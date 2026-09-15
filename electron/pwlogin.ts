// 네이버 로그인 전용 — Playwright로 '시스템에 설치된 진짜 Chrome'을 띄운다.
//
// 왜 Electron 창을 안 쓰나:
//   Electron은 크롬이 아니라서 sec-ch-ua / userAgentData / 권한상태 등에서 흔적이 남고,
//   그걸 JS로 위장하면 위장 자체가 또 탐지 신호가 된다(두더지 잡기).
//   로그인은 네이버가 가장 엄격하게 보는 순간이라, 아예 '진짜 크롬'으로 처리한다.
//
// 핵심 전략(카페포스터에서 검증된 방식):
//   1) channel:'chrome' — 시스템 Chrome 사용 (지문이 진짜)
//   2) 계정별 영속 프로필 — 쿠키/히스토리/캐시가 쌓여 '항상 첫 방문' 신호를 없앰
//   3) 계정↔프록시 1:1 고정
//   4) 자동화 플래그 제거 (--enable-automation 등)
//   5) 계정마다 코어수/메모리/해상도를 고정값으로 다르게 → 한 PC에서 돌려도 계정이 안 묶임
//      (canvas/WebGL/폰트는 건드리지 않는다 — 모순이 생기면 오히려 들킴)

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { AccountProxy } from './naver';
import { createContextStore } from './browser-contexts';
import { readAuthState, AUTH_STOP } from './session-auth';

/** 계정 시드로부터 항상 같은 값이 나오는 지문 (접속마다 바뀌면 그게 봇 신호) */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface DerivedFp {
  cores: number;
  memory: number;
  screenW: number;
  screenH: number;
}

export function deriveFingerprint(seed: string): DerivedFp {
  const h = fnv1a(seed || 'default');
  // 부호없는 시프트(>>>) 필수 — 부호있는 >> 를 쓰면 음수 인덱스가 나와 터진다
  const cores = [4, 6, 8, 12, 16][h % 5];
  const memory = [4, 8, 16][(h >>> 3) % 3];
  const resolutions: Array<[number, number]> = [
    [1440, 900], [1536, 864], [1600, 900], [1920, 1080], [1680, 1050], [1600, 1024],
  ];
  const [screenW, screenH] = resolutions[(h >>> 6) % resolutions.length];
  return { cores, memory, screenW, screenH };
}

/** 계정별 크롬 프로필 폴더 (쿠키·히스토리가 쌓이는 곳) */
export function profileDirFor(accountId: number): string {
  const dir = path.join(app.getPath('userData'), 'chrome-profiles', String(accountId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}


/**
 * 로그인·작업에서 공통으로 쓰는 크롬 실행 옵션.
 * ★ 로그인한 환경과 작업 환경이 조금이라도 다르면 네이버가 세션을 의심한다.
 *   그래서 반드시 같은 옵션·같은 프로필을 쓴다.
 */
export function buildContextOptions(acc: AccountProxy) {
  const fp = deriveFingerprint(acc.naverId || String(acc.id));
  const proxy =
    acc.proxyHost && acc.proxyPort
      ? {
          server: `http://${acc.proxyHost}:${acc.proxyPort}`,
          username: acc.proxyUser || undefined,
          password: acc.proxyPass || undefined,
        }
      : undefined;
  return {
    headless: false as const,
    channel: 'chrome' as const,
    proxy,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: null,
    args: [
      '--no-default-browser-check',
      '--no-first-run',
      '--window-size=1280,900',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--disable-quic',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
    ignoreDefaultArgs: [
      '--enable-automation',
      '--no-sandbox',
      '--disable-component-extensions-with-background-pages',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-component-update',
    ],
  };
}

/**
 * 자동화 흔적 숨김 + 계정별 지문 분산. 로그인/작업 컨텍스트에 똑같이 적용해야 한다.
 */
export async function applyStealthInit(
  ctx: import('playwright').BrowserContext,
  acc: AccountProxy,
): Promise<void> {
  const fp = deriveFingerprint(acc.naverId || String(acc.id));
  await ctx.addInitScript((f: DerivedFp) => {
    // ★ 반드시 '프로토타입'에 정의한다.
    //   navigator/screen 인스턴스에 own property 로 두면 Object.getOwnPropertyNames()로
    //   위장이 그대로 드러난다(진짜 크롬은 둘 다 []). 실측으로 확인된 흔적.
    const def = (proto: any, key: string, value: unknown) => {
      try {
        Object.defineProperty(proto, key, { get: () => value, configurable: true, enumerable: true });
      } catch {
        /* ignore */
      }
    };
    const navProto = Object.getPrototypeOf(navigator);
    def(navProto, 'webdriver', false); // Playwright가 true로 심는다 → 진짜 크롬 값 false
    def(navProto, 'languages', ['ko-KR', 'ko']);
    def(navProto, 'hardwareConcurrency', f.cores);
    def(navProto, 'deviceMemory', f.memory);
    const scrProto = Object.getPrototypeOf((globalThis as any).screen);
    def(scrProto, 'width', f.screenW);
    def(scrProto, 'height', f.screenH);
    def(scrProto, 'availWidth', f.screenW);
    def(scrProto, 'availHeight', f.screenH - 40);
    def(scrProto, 'colorDepth', 24);
    def(scrProto, 'pixelDepth', 24);
  }, fp);
}

const accountContexts = createContextStore(async (_id, config) => {
  const acc = JSON.parse(config) as AccountProxy;
  const { chromium } = await import('playwright');
  const ctx = await chromium.launchPersistentContext(profileDirFor(acc.id), buildContextOptions(acc));
  try { await applyStealthInit(ctx, acc); }
  catch (e) { await ctx.close(); throw e; }
  return ctx;
});

export function getAccountContext(acc: AccountProxy) {
  if (!acc.proxyHost || !acc.proxyPort) throw new Error('프록시를 먼저 설정해 주세요.');
  return accountContexts.get(acc.id, JSON.stringify(acc));
}
export const closeAccountContext = (id: number) => accountContexts.close(id);
export const closeAllKinContexts = () => accountContexts.closeAll();
export const shutdownAccountContexts = () => accountContexts.shutdown();
export const hasOpenAccountContext = () => accountContexts.hasOpen();

export interface PwLoginResult { ok: boolean; error?: string; }

/** Explicit login only. Opening a browser never forces a login or copies cookies. */
export async function loginWithRealChrome(
  acc: AccountProxy,
  onStatus?: (s: string) => void,
  password?: string,
  mode: 'login' | 'browse' = 'login',
): Promise<PwLoginResult> {
  try {
    const ctx = await getAccountContext(acc);
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://www.naver.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.bringToFront();
    await new Promise(r => setTimeout(r, 1500));
    let state = await readAuthState(ctx, page);
    if (mode === 'browse') {
      onStatus?.('브라우저를 열었습니다. 로그인 상태는 변경하지 않습니다.');
      return { ok: true };
    }
    if (state !== 'authenticated') {
      const cs = await ctx.cookies('https://www.naver.com/');
      const hasExistingAuth = cs.some(c => (c.name === 'NID_AUT' || c.name === 'NID_SES') && !!c.value);
      if (state !== 'signed-out' || hasExistingAuth) {
        onStatus?.(AUTH_STOP + ' 열린 창에서 상태를 직접 확인해 주세요.');
        return { ok: false, error: AUTH_STOP };
      }
      const link = page.locator('a[href*="nidlogin.login"]:visible, a.link_login:visible').first();
      await link.click({ timeout: 8000 });
      await page.waitForLoadState('domcontentloaded');
      if (password) {
        const result = await tryAutoLogin(page, acc.naverId, password, onStatus);
        if (result !== 'ok') return { ok: false, error: '자동 로그인 시도를 중단했습니다. 열린 창에서 확인해 주세요.' };
      }
    } else {
      onStatus?.('기존 로그인 상태를 확인했습니다. 재로그인하지 않습니다.');
    }
    let closed = false;
    const onClose = () => { closed = true; };
    ctx.on('close', onClose);
    let authenticated = state === 'authenticated';
    const deadline = Date.now() + 3 * 60 * 60 * 1000;
    try {
      while (!closed && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));
        if (closed) break;
        const pages = ctx.pages();
        const current = pages[pages.length - 1];
        if (!current) continue;
        state = await readAuthState(ctx, current);
        if (state === 'authenticated') {
          if (!authenticated) onStatus?.('로그인 상태를 확인했습니다. 창을 닫으면 작업을 시작할 수 있습니다.');
          authenticated = true;
        } else if (authenticated) {
          onStatus?.(AUTH_STOP);
          return { ok: false, error: AUTH_STOP };
        }
      }
      return authenticated && closed ? { ok: true } : { ok: false, error: '로그인 확인이 완료되지 않았습니다. 자동으로 다시 시도하지 않습니다.' };
    } finally { ctx.off('close', onClose); }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** VM 시계가 실제 시각과 얼마나 어긋나는지(초). 몇 분만 틀려도 세션 토큰이 무효가 된다. */
export async function checkClockSkewSec(): Promise<number | null> {
  try {
    const { request } = await import('playwright');
    const ctx = await request.newContext({ ignoreHTTPSErrors: true, timeout: 12000 });
    try {
      const t0 = Date.now();
      const r = await ctx.get('https://www.naver.com/', { timeout: 12000 });
      const t1 = Date.now();
      const dateHeader = r.headers()['date'];
      if (!dateHeader) return null;
      const server = new Date(dateHeader).getTime();
      if (!Number.isFinite(server)) return null;
      const local = (t0 + t1) / 2; // 왕복 시간 보정
      return Math.round((local - server) / 1000);
    } finally {
      await ctx.dispose().catch(() => {});
    }
  } catch {
    return null;
  }
}

export interface ProxyIpCheck {
  ok: boolean;
  ips: string[];
  distinct: string[];
  stable: boolean;
  /** 프록시가 스스로를 드러내는 헤더를 붙였는지 (붙으면 네이버가 프록시 사용을 바로 알아챔) */
  leakHeaders?: Array<{ name: string; value: string }>;
  anonymous?: boolean;
  /** VM 시계 오차(초). |값|이 크면 세션이 끊긴다. */
  clockSkewSec?: number | null;
  error?: string;
}

// 프록시 사용을 드러내는 대표 헤더들 (하나라도 붙으면 익명성 실패)
const PROXY_REVEALING = [
  'via', 'x-forwarded-for', 'forwarded', 'x-real-ip', 'client-ip',
  'proxy-connection', 'x-proxy-id', 'x-forwarded-host', 'x-forwarded-server',
];

/**
 * 이 계정의 프록시로 실제로 나가는 IP를 여러 번 확인한다.
 * 한 세션 안에서 IP가 바뀌면 네이버가 세션을 무효화하고 계정을 잠근다
 * ("로그인은 됐는데 클릭 한 번에 로그아웃" 증상의 대표 원인).
 */
export async function checkProxyExitIp(acc: AccountProxy, times = 6): Promise<ProxyIpCheck> {
  if (!acc.proxyHost || !acc.proxyPort) {
    return { ok: false, ips: [], distinct: [], stable: false, error: '프록시가 등록되지 않았습니다.' };
  }
  let request: typeof import('playwright').request;
  try {
    ({ request } = await import('playwright'));
  } catch (e) {
    return { ok: false, ips: [], distinct: [], stable: false, error: 'playwright 로드 실패' };
  }
  const ips: string[] = [];
  let ctx: import('playwright').APIRequestContext | null = null;
  try {
    ctx = await request.newContext({
      proxy: {
        server: `http://${acc.proxyHost}:${acc.proxyPort}`,
        username: acc.proxyUser || undefined,
        password: acc.proxyPass || undefined,
      },
      ignoreHTTPSErrors: true,
      timeout: 15000,
    });
    for (let i = 0; i < times; i++) {
      let ip = '';
      try {
        const r = await ctx.get('https://api.ipify.org?format=json', { timeout: 15000 });
        if (r.ok()) {
          const j = (await r.json()) as { ip?: string };
          ip = String(j.ip || '').trim();
        }
      } catch {
        // 한 번 실패는 다음 시도로
      }
      if (ip) ips.push(ip);
      if (i < times - 1) await new Promise((r) => setTimeout(r, 2500));
    }
  } catch (e) {
    return {
      ok: false, ips, distinct: Array.from(new Set(ips)), stable: false,
      error: '프록시 연결 실패: ' + (e instanceof Error ? e.message : String(e)).slice(0, 160),
    };
  } finally {
    try {
      await ctx?.dispose();
    } catch {
      /* ignore */
    }
  }
  const distinct = Array.from(new Set(ips));
  if (!ips.length) {
    return { ok: false, ips, distinct, stable: false, error: '프록시로 외부 접속이 되지 않습니다(IP 확인 실패).' };
  }

  // 프록시가 요청에 자기 흔적을 붙이는지 확인한다.
  // Via / X-Forwarded-For 같은 헤더가 붙으면 IP가 아무리 고정이어도
  // 네이버는 "프록시로 접속했다"를 즉시 알 수 있다.
  const leakHeaders: Array<{ name: string; value: string }> = [];
  let anonymous: boolean | undefined;
  try {
    const ctx2 = await request.newContext({
      proxy: {
        server: `http://${acc.proxyHost}:${acc.proxyPort}`,
        username: acc.proxyUser || undefined,
        password: acc.proxyPass || undefined,
      },
      ignoreHTTPSErrors: true,
      timeout: 15000,
    });
    try {
      const r = await ctx2.get('https://httpbin.org/headers', { timeout: 15000 });
      if (r.ok()) {
        const j = (await r.json()) as { headers?: Record<string, string> };
        const hs = j.headers || {};
        for (const k of Object.keys(hs)) {
          if (PROXY_REVEALING.includes(k.toLowerCase())) {
            leakHeaders.push({ name: k, value: String(hs[k]).slice(0, 120) });
          }
        }
        anonymous = leakHeaders.length === 0;
      }
    } finally {
      await ctx2.dispose().catch(() => {});
    }
  } catch {
    // 헤더 검사 실패는 치명적이지 않음 (anonymous 는 undefined 로 남음)
  }

  const clockSkewSec = await checkClockSkewSec();

  return { ok: true, ips, distinct, stable: distinct.length === 1, leakHeaders, anonymous, clockSkewSec };
}

/**
 * 저장된 비밀번호로 로그인 폼을 자동 입력한다. (사람이 치는 것과 같은 실제 키 입력)
 *
 * 안전 원칙 — 카페포스터에서 검증된 것과 동일:
 *   · 쿠키가 없을 때 '딱 1회'만 시도한다. 반복 자동 로그인은 보호조치를 부른다.
 *   · 캡차/2차 인증/보호조치가 뜨면 즉시 멈추고 사람에게 넘긴다(자동으로 풀지 않는다).
 */
export async function tryAutoLogin(
  page: import('playwright').Page,
  naverId: string,
  password: string,
  onStatus?: (s: string) => void,
): Promise<'ok' | 'challenge' | 'failed'> {
  if (!naverId || !password) return 'failed';
  try {
    const id = page.locator('#id');
    const pw = page.locator('#pw');
    if (!(await id.count()) || !(await pw.count())) return 'failed';

    onStatus?.('아이디 입력 중…');
    await id.fill('');
    await id.click({ timeout: 8000 });
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
    // 실제 키 입력 (사람 타이핑 속도)
    for (const ch of naverId) {
      await page.keyboard.type(ch, { delay: 60 + Math.floor(Math.random() * 110) });
    }
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 500));

    onStatus?.('비밀번호 입력 중…');
    await pw.fill('');
    await pw.click({ timeout: 8000 });
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
    for (const ch of password) {
      await page.keyboard.type(ch, { delay: 60 + Math.floor(Math.random() * 120) });
    }
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 600));

    onStatus?.('로그인 버튼 클릭');
    let clicked = false;
    for (const sel of ['#log\.login', '#loginBtn_row', 'button.btn_login', '.btn_login', 'button[type="submit"]']) {
      try {
        const b = page.locator(sel).first();
        if (await b.count()) {
          await b.click({ timeout: 6000 });
          clicked = true;
          break;
        }
      } catch {
        /* 다음 선택자 */
      }
    }
    if (!clicked) await pw.press('Enter').catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));

    // 캡차/2차 인증/보호조치가 떴으면 절대 자동으로 진행하지 않는다
    const blocked = await page
      .evaluate(`
        (function () {
          var t = (document.body ? (document.body.innerText || '') : '').slice(0, 4000);
          if (document.querySelector('#captcha, #captchaimg, input[name="captcha"]')) return '보안문자';
          if (/보호\s*\(?[^)]{0,8}\)?\s*조치|영구\s*정지|아이디\s*잠금|이용이\s*제한/.test(t)) return '보호조치';
          if (/2단계|인증번호|본인확인|기기\s*등록/.test(t)) return '추가인증';
          return '';
        })();
      `)
      .catch(() => '');
    if (blocked) {
      onStatus?.(`⚠ ${blocked} 화면 — 창에서 직접 처리해 주세요 (자동 진행 중단)`);
      return 'challenge';
    }
    return 'ok';
  } catch {
    return 'failed';
  }
}
