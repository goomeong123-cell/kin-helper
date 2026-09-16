// System Chrome with native browser-reported properties. Proxy and profile remain account-specific.
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { AccountProxy } from './naver';
import { proxyFor } from './network-config';
import { createContextStore, persistSessionCookies } from './browser-contexts';
import { readAuthState, waitForAuth, NAVER_HOME } from './session-auth';

// 카페포스터와 동일 — 로그인 페이지로 직접 간다
const LOGIN_URL = 'https://nid.naver.com/nidlogin.login';

export function profileDirFor(accountId: number): string {
  const dir = path.join(app.getPath('userData'), 'chrome-profiles', String(accountId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}


/** Keep platform/browser defaults; retain only the account proxy and window settings. */
export function buildContextOptions(acc: AccountProxy) {
  return {
    headless: false as const,
    channel: 'chrome' as const,
    chromiumSandbox: true,
    proxy: proxyFor(acc),
    viewport: null,
    args: ['--window-size=1280,900', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp'],
    // "자동화된 테스트 소프트웨어가 제어 중" 안내 막대만 끈다. webdriver 값은 이걸로 안 바뀐다(실측) → 위 maskWebdriver.
    ignoreDefaultArgs: ['--enable-automation'],
  };
}

const accountContexts = createContextStore(async (_id, config) => {
  const acc = JSON.parse(config) as AccountProxy;
  const { chromium } = await import('playwright');
  const ctx = await chromium.launchPersistentContext(profileDirFor(acc.id), buildContextOptions(acc));
  await maskWebdriver(ctx);
  // 사용 중 네이버가 NID_SES를 '만료 없는 세션 쿠키'로 계속 재발급한다 → 2분마다 만료일을 붙여 둔다.
  // 안 그러면 Chrome이 닫히는 순간(업데이트·종료) 사라져 다음 실행이 로그아웃이 되고,
  // 그 재로그인이 보호조치를 부른다(실제 사례: v0.9.4 업데이트 직후).
  const timer = setInterval(() => void persistSessionCookies(ctx).catch(() => 0), 2 * 60 * 1000);
  ctx.on('close', () => clearInterval(timer));
  return ctx;
}, persistSessionCookies);

/**
 * 유일하게 남긴 브라우저 정보 변경: navigator.webdriver.
 * Playwright가 띄운 Chrome은 실행 인자와 무관하게 webdriver=true 로 보인다(실측: about:blank 기준
 * ignoreDefaultArgs 유무 모두 true). 진짜 크롬 값은 false. 코어/메모리/화면 등 다른 위장은 제거된 상태 유지.
 * 반드시 '프로토타입'에 정의한다 — 인스턴스 own property 로 두면 그 자체가 흔적이 된다(실측).
 */
async function maskWebdriver(ctx: import('playwright').BrowserContext): Promise<void> {
  // ponytail: getter.toString()이 "() => false"로 보인다(진짜 크롬은 "[native code]"). 이전 배포본도 동일했음.
  //   Function.prototype.toString까지 덮으면 그게 더 큰 흔적이라 여기서 멈춤. 필요해지면 그때 검토.
  await ctx.addInitScript(() => {
    try {
      Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', {
        get: () => false,
        configurable: true,
        enumerable: true,
      });
    } catch {
      /* ignore */
    }
  });
}

export function getAccountContext(acc: AccountProxy) {
  proxyFor(acc);
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
    await page.goto(NAVER_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.bringToFront();
    await new Promise(r => setTimeout(r, 1500));
    if (mode === 'browse') {
      onStatus?.('브라우저를 열었습니다. 로그인 상태는 변경하지 않습니다.');
      return { ok: true };
    }
    // 카페포스터와 동일: NID_AUT 쿠키가 있으면 로그인. 홈을 띄운 뒤 잠깐 기다려 재판정.
    const initial = await waitForAuth(ctx, page, 8000);
    let state = initial.state;
    if (state === 'authenticated') {
      onStatus?.('기존 로그인 상태를 확인했습니다. Chrome을 닫지 않고 작업을 시작하세요.');
      return { ok: true };
    }
    // 카페포스터와 동일: 로그인 페이지로 '직접' 이동 (홈에서 링크를 찾아 누르지 않는다)
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (password) {
      const result = await tryAutoLogin(page, acc.naverId, password, onStatus, ctx);
      if (result === 'ok') {
        onStatus?.('로그인 상태를 확인했습니다. Chrome을 닫지 않고 작업을 시작하세요.');
        return { ok: true };
      }
      // 캡차·추가인증·미완료 → 창은 그대로 두고 사람이 마무리하도록 아래에서 기다린다 (자동 재시도 없음)
      onStatus?.('자동 로그인이 완료되지 않았습니다. 열린 창에서 직접 마무리해 주세요.');
    } else {
      onStatus?.('저장된 비밀번호가 없습니다. 열린 창에서 직접 로그인해 주세요.');
    }
    let closed = false;
    const onClose = () => { closed = true; };
    ctx.on('close', onClose);
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
          onStatus?.('로그인 상태를 확인했습니다. Chrome을 닫지 않고 작업을 시작하세요.');
          return { ok: true };

        }
      }
      return { ok: false, error: '로그인 확인이 완료되지 않았습니다. 자동으로 다시 시도하지 않습니다.' };
    } finally { ctx.off('close', onClose); }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** VM 시계가 실제 시각과 얼마나 어긋나는지(초). 몇 분만 틀려도 세션 토큰이 무효가 된다. */
export async function checkClockSkewSec(acc: AccountProxy): Promise<number | null> {
  try {
    const { request } = await import('playwright');
    const ctx = await request.newContext({ proxy: proxyFor(acc), ignoreHTTPSErrors: false, timeout: 12000 });
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
 * 결과는 측정 시점의 관측값이며 네이버의 계정 판단을 설명하지 않는다.
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
      proxy: proxyFor(acc),
      ignoreHTTPSErrors: false,
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

  // 에코 서비스 응답에 전달 헤더가 있는지 측정한다. 계정 안전 판정은 아니다.
  const leakHeaders: Array<{ name: string; value: string }> = [];
  let anonymous: boolean | undefined;
  try {
    const ctx2 = await request.newContext({
      proxy: proxyFor(acc),
      ignoreHTTPSErrors: false,
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

  const clockSkewSec = await checkClockSkewSec(acc);

  return { ok: true, ips, distinct, stable: ips.length === times && distinct.length === 1, leakHeaders, anonymous, clockSkewSec };
}

/**
 * 저장된 비밀번호로 로그인 폼을 자동 입력한다. (사람이 치는 것과 같은 실제 키 입력)
 *
 * 안전 원칙 — 카페포스터에서 검증된 것과 동일:
 *   · 쿠키가 없을 때 '딱 1회'만 시도한다. 반복 자동 로그인은 보호조치를 부른다.
 *   · 캡차/2차 인증/보호조치가 뜨면 즉시 멈추고 사람에게 넘긴다(자동으로 풀지 않는다).
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));

/**
 * 카페포스터 human.ts 의 humanClick 과 동일: 요소 안 랜덤 지점으로 마우스를 옮겨 down/up.
 * 실패하면 locator.click 폴백. (여기서 던진 예외는 호출자가 '제출 여부 불명'으로 다룬다)
 */
async function humanClick(locator: import('playwright').Locator): Promise<void> {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    const box = await locator.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) throw new Error('no box');
    const page = locator.page();
    const x = box.x + box.width * (0.3 + Math.random() * 0.4);
    const y = box.y + box.height * (0.3 + Math.random() * 0.4);
    await page.mouse.move(x, y, { steps: rand(8, 20) });
    await sleep(rand(60, 180));
    await page.mouse.down();
    await sleep(rand(40, 110));
    await page.mouse.up();
  } catch {
    await locator.click({ delay: rand(40, 110) });
  }
}

/**
 * 카페포스터 human.ts 의 humanType 과 동일: 클릭 → fill 한 번에.
 * 한 글자씩 keyboard.type 하면 네이버 로그인의 자동완성 드롭다운이 타이핑 중간에 끼어들어
 * `5044vgl555044` 처럼 글자가 뒤섞이는 사고가 있었다(카페포스터 실측). fill 은 비밀번호 관리자처럼 동작.
 */
async function humanType(locator: import('playwright').Locator, text: string): Promise<void> {
  await humanClick(locator);
  await sleep(120);
  await locator.fill(text);
  await sleep(150 + Math.floor(Math.random() * 250));
}

const CHALLENGE_JS = `
  (function () {
    var t = (document.body ? (document.body.innerText || '') : '').slice(0, 4000);
    if (document.querySelector('#captcha, #captchaimg, input[name="captcha"]')) return '보안문자';
    if (/보호\\s*\\(?[^)]{0,8}\\)?\\s*조치|영구\\s*정지|아이디\\s*잠금|이용이\\s*제한/.test(t)) return '보호조치';
    if (/2단계|인증번호|본인확인|기기\\s*등록/.test(t)) return '추가인증';
    return '';
  })();
`;

/**
 * 자동 로그인 1회 — 카페포스터 ensureLoggedIn 4) 단계와 동일한 절차.
 * 로그인 페이지에 이미 와 있어야 한다. 제출은 한 번만(불명확한 실패 후 다른 버튼/Enter 재시도 없음).
 * ctx 를 주면 카페처럼 최대 25초 동안 NID_AUT 쿠키를 폴링해 '느린 로그인'을 실패로 오판하지 않는다.
 */
export async function tryAutoLogin(
  page: import('playwright').Page,
  naverId: string,
  password: string,
  onStatus?: (s: string) => void,
  ctx?: import('playwright').BrowserContext,
): Promise<'ok' | 'challenge' | 'failed'> {
  if (!naverId || !password) return 'failed';
  try {
    const id = page.locator('#id');
    const pw = page.locator('#pw');
    if (!(await id.count()) || !(await pw.count())) return 'failed';

    await sleep(rand(800, 1500));
    onStatus?.('아이디 입력 중…');
    await humanType(id, naverId);
    await sleep(rand(300, 700));
    onStatus?.('비밀번호 입력 중…');
    await humanType(pw, password);
    await sleep(rand(300, 700));

    onStatus?.('로그인 버튼 클릭');
    // 새 UI(#loginBtn_row, type=button) → 옛 UI 순. 보이는 첫 버튼 하나만 고르고 한 번만 누른다.
    let submitButton: import('playwright').Locator | undefined;
    for (const sel of ['#loginBtn_row', '#log\\.login', 'button.btn_done', 'button.btn_login', '.btn_login', 'button[type="submit"]']) {
      const candidate = page.locator(sel).first();
      if ((await candidate.isVisible()) && (await candidate.isEnabled())) {
        submitButton = candidate;
        break;
      }
    }
    if (!submitButton) return 'failed';
    try {
      await humanClick(submitButton);
    } catch {
      // 클릭이 던졌어도 이미 제출됐을 수 있다 → 다른 버튼/Enter 로 재제출하지 않는다
      return 'failed';
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});

    // 카페와 동일: 쿠키를 일정 시간 폴링 (느린 프록시로 로그인이 늦게 끝나는 케이스를 실패로 오판하지 않게)
    const deadline = Date.now() + (ctx ? 25000 : 2000);
    while (Date.now() < deadline) {
      await sleep(1500);
      const blocked = (await page.evaluate(CHALLENGE_JS).catch(() => '')) as string;
      if (blocked) {
        onStatus?.(`⚠ ${blocked} 화면 — 창에서 직접 처리해 주세요 (자동 진행 중단)`);
        return 'challenge';
      }
      if (ctx) {
        const cs = await ctx.cookies(NAVER_HOME).catch(() => []);
        if (cs.some((c) => c.name === 'NID_AUT' && !!c.value)) return 'ok';
      }
    }
    if (!ctx) return 'ok'; // 컨텍스트 없이 호출된 경우(테스트) 화면에 차단 표시가 없으면 통과
    onStatus?.('로그인이 시간 내 완료되지 않았습니다 (느린 연결일 수 있음). 창에서 확인해 주세요.');
    return 'failed';
  } catch {
    return 'failed';
  }
}
