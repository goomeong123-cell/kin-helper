// 로그인 판정 — 카페포스터(운영 중, 같은 프록시·같은 출처 계정 18개 정상)와 동일한 규칙.
//   1) NID_AUT 쿠키가 있으면 로그인. DOM 셀렉터보다 안정적이고, 화면 변형에 영향받지 않는다.
//   2) 없으면 네이버 홈을 한 번 띄워 쿠키가 갱신되는지 보고 재판정 (세션 쿠키가 헤더로 되살아나는 경우).
//   3) 그래도 없을 때만 '로그아웃'으로 본다.
// 이전(v0.9.4~0.9.6) 규칙은 NID_AUT+NID_SES+화면 계정표시 셋 다 있어야 통과라, NID_SES 하나 빠진 정상 세션도
// "확인 불가"로 멈추고 사람에게 재로그인을 유도했다. 재로그인 직후 보호조치가 난 실사례가 있어 되돌린다.
import type { BrowserContext, Page } from 'playwright';

export type AuthState = 'authenticated' | 'signed-out';
export const AUTH_STOP = '[AUTH_STOP] 로그인 상태가 아니라 작업을 중단했습니다. 자동 재로그인은 하지 않습니다.';
export const NAVER_HOME = 'https://www.naver.com/';

export interface AuthSnapshot {
  state: AuthState;
  site: string;
  hasAuth: boolean;
  hasSession: boolean;
  login: boolean;
  logout: boolean;
  readable: boolean;
}

/** 쿠키만으로 판정 — 카페포스터 hasLoginCookie 와 동일 */
export function classifyAuth(hasAuth: boolean): AuthState {
  return hasAuth ? 'authenticated' : 'signed-out';
}

/** Metadata only: never return cookie values, page text, user IDs, or URL query parameters. */
export async function inspectAuth(ctx: BrowserContext, page: Page): Promise<AuthSnapshot> {
  const snap: AuthSnapshot = { state: 'signed-out', site: 'other', hasAuth: false, hasSession: false, login: false, logout: false, readable: false };
  try {
    const cs = await ctx.cookies(NAVER_HOME);
    snap.hasAuth = cs.some((c) => c.name === 'NID_AUT' && !!c.value);
    snap.hasSession = cs.some((c) => c.name === 'NID_SES' && !!c.value);
  } catch {
    /* 닫힌 컨텍스트 → 쿠키 없음으로 */
  }
  snap.state = classifyAuth(snap.hasAuth);
  // 화면 표시는 설명용으로만 읽는다 (판정에 쓰지 않음)
  try {
    const u = new URL(page.url());
    if (u.protocol === 'https:' && (u.hostname === 'naver.com' || u.hostname.endsWith('.naver.com'))) {
      snap.site = u.hostname;
      const ui = (await page.evaluate(`(() => {
        const visible = (selector) => Array.from(document.querySelectorAll(selector)).some(el => {
          const s = getComputedStyle(el);
          return el.getClientRects().length > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        });
        return {
          login: visible('a[href*="nidlogin.login"], a.link_login, #id, #pw'),
          logout: visible('a[href*="nidlogin.logout"], .link_logout, .gnb_my, #gnb_logout_button'),
        };
      })()`)) as { login: boolean; logout: boolean };
      snap.login = ui.login;
      snap.logout = ui.logout;
      snap.readable = true;
    }
  } catch {
    /* 이동 중이거나 닫힌 페이지 → 화면 정보 없음 */
  }
  return snap;
}

export function describeAuth(s: AuthSnapshot): string {
  const yn = (v: boolean) => (v ? '있음' : '없음');
  const reason = s.hasAuth ? '로그인 확인' : '인증 쿠키(NID_AUT) 없음';
  return `${reason} | 사이트=${s.site} | NID_AUT=${yn(s.hasAuth)}, NID_SES=${yn(s.hasSession)} | 로그인표시=${yn(s.login)}, 계정표시=${yn(s.logout)} (보호조치 판정 아님)`;
}

export async function readAuthState(ctx: BrowserContext, page: Page): Promise<AuthState> {
  return (await inspectAuth(ctx, page)).state;
}

export async function waitForAuth(ctx: BrowserContext, page: Page, timeoutMs: number): Promise<AuthSnapshot> {
  const end = Date.now() + timeoutMs;
  let snap = await inspectAuth(ctx, page);
  while (snap.state !== 'authenticated' && Date.now() < end) {
    await new Promise((r) => setTimeout(r, Math.min(250, Math.max(0, end - Date.now()))));
    snap = await inspectAuth(ctx, page);
  }
  return snap;
}

/** 작업 도중 검사 — 페이지를 옮기지 않고 쿠키만 본다 */
export async function requireAuthenticated(ctx: BrowserContext, page: Page, timeoutMs = 750): Promise<void> {
  const snap = await waitForAuth(ctx, page, timeoutMs);
  if (snap.state !== 'authenticated') throw new Error(AUTH_STOP + ' ' + describeAuth(snap));
}

/**
 * 작업 시작 시 검사 — 카페포스터 ensureLoggedIn 1)~2) 단계.
 * 쿠키 없으면 홈을 한 번 띄워 갱신을 기다린 뒤 재판정. 그래도 없으면 AUTH_STOP (로그인은 시도하지 않음).
 */
export async function ensureAuthenticated(ctx: BrowserContext): Promise<AuthSnapshot> {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  let snap = await inspectAuth(ctx, page);
  if (snap.state === 'authenticated') return snap;
  await page.goto(NAVER_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  snap = await waitForAuth(ctx, page, 3000);
  if (snap.state !== 'authenticated') throw new Error(AUTH_STOP + ' ' + describeAuth(snap));
  return snap;
}

/** 워밍업 중 상태가 바뀌면(로그인↔로그아웃) 중단 */
export function assertWarmupAuth(current: AuthSnapshot, initial?: AuthSnapshot): void {
  if (initial && initial.state !== current.state) {
    throw new Error(AUTH_STOP + ' 워밍업 중단: ' + describeAuth(current));
  }
}
