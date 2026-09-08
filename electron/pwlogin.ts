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

export interface PwLoginResult {
  ok: boolean;
  error?: string;
  cookies?: Array<{
    name: string; value: string; domain: string; path: string;
    expires: number; httpOnly: boolean; secure: boolean; sameSite?: string;
  }>;
}

/**
 * 진짜 Chrome으로 네이버 로그인 창을 띄우고, 사람이 로그인할 때까지 기다린다.
 * 로그인이 확인되면(NID_AUT 쿠키) 그 쿠키를 반환한다. 창을 닫으면 종료.
 */
export async function loginWithRealChrome(
  acc: AccountProxy,
  onStatus?: (s: string) => void,
  // 로그인이 확인되는 즉시 호출된다(창은 그대로 열려 있음) — 앱 세션에 바로 반영하기 위함
  onCookies?: (c: NonNullable<PwLoginResult['cookies']>) => void | Promise<void>,
): Promise<PwLoginResult> {
  let chromium: typeof import('playwright').chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (e) {
    return { ok: false, error: 'playwright 로드 실패: ' + (e instanceof Error ? e.message : String(e)) };
  }

  const fp = deriveFingerprint(acc.naverId || String(acc.id));
  const proxy =
    acc.proxyHost && acc.proxyPort
      ? {
          server: `http://${acc.proxyHost}:${acc.proxyPort}`,
          username: acc.proxyUser || undefined,
          password: acc.proxyPass || undefined,
        }
      : undefined;

  let ctx: import('playwright').BrowserContext | null = null;
  try {
    onStatus?.('진짜 Chrome 실행 중…');
    ctx = await chromium.launchPersistentContext(profileDirFor(acc.id), {
      headless: false, // 사람이 직접 로그인해야 하므로 반드시 화면 표시
      channel: 'chrome', // 시스템에 설치된 진짜 Chrome
      proxy,
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
      viewport: null, // 실제 창 크기 그대로 (자연스러운 지문)
      args: [
        '--no-default-browser-check',
        '--no-first-run',
        '--window-size=1280,900',
        // WebRTC는 프록시를 타지 않고 UDP로 직접 나가서 진짜 IP를 흘릴 수 있다 → 프록시만 쓰게 강제
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
        // QUIC(UDP)도 HTTP 프록시를 우회할 수 있으므로 끄고 TCP만 사용
        '--disable-quic',
        // 창이 뒤로 가도 렌더러가 멈추지 않게 (백그라운드에서 작업이 정지하던 문제 예방)
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
      // Playwright가 기본으로 붙이는 자동화 표식 제거
      ignoreDefaultArgs: [
        '--enable-automation',
        '--no-sandbox',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-component-update',
      ],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/channel|chrome.*not found|Executable doesn't exist/i.test(msg)) {
      return { ok: false, error: '이 컴퓨터에 Google Chrome이 설치돼 있지 않습니다. Chrome을 먼저 설치해 주세요.' };
    }
    return { ok: false, error: 'Chrome 실행 실패: ' + msg.slice(0, 200) };
  }

  try {
    // 자동화 흔적만 가린다. 진짜 크롬이라 그 외에는 위장할 게 없다.
    await ctx.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      } catch {
        /* ignore */
      }
      try {
        Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en'] });
      } catch {
        /* ignore */
      }
    });
    // 계정마다 다른 기기처럼 보이게 (한 PC에서 여러 계정을 써도 서로 안 묶이도록)
    await ctx.addInitScript((f: DerivedFp) => {
      try { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => f.cores }); } catch { /* ignore */ }
      try { Object.defineProperty(navigator, 'deviceMemory', { get: () => f.memory }); } catch { /* ignore */ }
      const sd: Record<string, number> = {
        width: f.screenW, height: f.screenH,
        availWidth: f.screenW, availHeight: f.screenH - 40,
        colorDepth: 24, pixelDepth: 24,
      };
      for (const k of Object.keys(sd)) {
        try { Object.defineProperty((globalThis as any).screen, k, { get: () => sd[k] }); } catch { /* ignore */ }
      }
    }, fp);

    const page = ctx.pages()[0] || (await ctx.newPage());

    // ★ 사람처럼 '네이버 메인 → 로그인 버튼' 순서로 들어간다.
    //   갓 만든 빈 프로필이 첫 요청부터 로그인 주소로 직행하면(쿠키·리퍼러 없음)
    //   그 자체가 비정상 접근 신호가 된다. 메인을 먼저 거쳐야 기본 쿠키가 생기고
    //   리퍼러도 정상으로 남는다. (카페포스터가 쓰는 순서와 동일)
    onStatus?.('네이버 메인 여는 중…');
    await page.goto('https://www.naver.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1200 + Math.floor(Math.random() * 1500)));

    // 메인에서 '로그인' 링크를 실제로 눌러서 이동 (실패하면 주소로 폴백)
    let clicked = false;
    try {
      // 화면에 실제로 보이는 로그인 링크만 클릭 (숨은 요소를 잡으면 타임아웃 남)
      const link = page.locator('a[href*="nidlogin.login"]:visible, a.link_login:visible').first();
      if (await link.count()) {
        await link.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await link.click({ timeout: 6000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        clicked = /nidlogin/.test(page.url());
      }
    } catch {
      // 링크를 못 찾거나 클릭 실패 — 아래에서 주소로 이동
    }
    if (!clicked && !/nidlogin/.test(page.url())) {
      await page.goto('https://nid.naver.com/nidlogin.login', { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    onStatus?.('브라우저를 열었습니다. 로그인/프로필 설정을 끝내고 창을 닫아 주세요.');

    // ★ 로그인이 확인돼도 창을 닫지 않는다.
    //   사용자가 프로필 설정을 만지거나 잠깐 둘러볼 수 있어야 하고,
    //   그렇게 쌓인 히스토리·쿠키가 오히려 계정을 자연스럽게 만든다.
    //   창을 직접 닫을 때까지 유지하고, 그 사이 쿠키는 계속 최신으로 들고 있는다.
    let closed = false;
    ctx.on('close', () => {
      closed = true;
    });
    const deadline = Date.now() + 1000 * 60 * 60 * 3; // 안전장치: 최대 3시간
    let cookies: PwLoginResult['cookies'];
    let reported = false;
    while (!closed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      let cs: Awaited<ReturnType<import('playwright').BrowserContext['cookies']>> = [];
      try {
        cs = await ctx.cookies();
      } catch {
        break; // 창이 닫힘 — 마지막으로 들고 있던 쿠키를 사용
      }
      const naverCookies = cs
        .filter((c) => (c.domain || '').includes('naver.com'))
        .map((c) => ({
          name: c.name, value: c.value, domain: c.domain, path: c.path,
          expires: c.expires, httpOnly: c.httpOnly, secure: c.secure,
          sameSite: c.sameSite,
        }));
      if (naverCookies.some((c) => c.name === 'NID_AUT' && c.value)) {
        cookies = naverCookies; // 항상 최신 스냅샷 유지
        if (!reported) {
          reported = true;
          onStatus?.('로그인 확인됨 ✓ — 창은 그대로 두셔도 됩니다 (닫으면 저장)');
          // 창이 열려 있어도 앱 세션에는 바로 반영해 둔다
          try {
            await onCookies?.(naverCookies);
          } catch {
            /* ignore */
          }
        }
      }
    }
    if (!cookies) {
      return { ok: false, error: '로그인하지 않은 채로 창이 닫혔습니다.' };
    }
    return { ok: true, cookies };
  } finally {
    // 프로필 폴더는 그대로 둔다(쿠키·히스토리가 이어져야 자연스러움).
    try {
      await ctx?.close();
    } catch {
      /* ignore */
    }
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
