import type { BrowserContext, Page } from 'playwright';

export type AuthState = 'authenticated' | 'signed-out' | 'unknown';
export const AUTH_STOP = '[AUTH_STOP] 로그인 상태를 확인할 수 없어 작업을 중단했습니다. 자동 재로그인은 하지 않습니다.';
export interface AuthSnapshot {
  state: AuthState;
  site: string;
  hasAuth: boolean;
  hasSession: boolean;
  login: boolean;
  logout: boolean;
  readable: boolean;
}
export function classifyAuth(hasAuth: boolean, hasSession: boolean, login: boolean, logout: boolean): AuthState {
  if (login) return 'signed-out';
  if (hasAuth && hasSession && logout) return 'authenticated';
  return 'unknown';
}

/** Metadata only: never return cookie values, page text, user IDs, or URL query parameters. */
export async function inspectAuth(ctx: BrowserContext, page: Page): Promise<AuthSnapshot> {
  const snap: AuthSnapshot = { state: 'unknown', site: 'other', hasAuth: false, hasSession: false, login: false, logout: false, readable: false };
  try {
    const u = new URL(page.url());
    if (u.protocol !== 'https:' || !(u.hostname === 'naver.com' || u.hostname.endsWith('.naver.com'))) return snap;
    snap.site = u.hostname;
    const cs = await ctx.cookies('https://www.naver.com/');
    snap.hasAuth = cs.some(c => c.name === 'NID_AUT' && !!c.value);
    snap.hasSession = cs.some(c => c.name === 'NID_SES' && !!c.value);
    const ui = await page.evaluate(`(() => {
      const visible = (selector) => Array.from(document.querySelectorAll(selector)).some(el => {
        const s = getComputedStyle(el);
        return el.getClientRects().length > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      });
      return {
        login: visible('a[href*="nidlogin.login"], a.link_login, #id, #pw'),
        logout: visible('a[href*="nidlogin.logout"], .link_logout, .gnb_my, #gnb_logout_button'),
      };
    })()`) as { login: boolean; logout: boolean };
    snap.login = ui.login;
    snap.logout = ui.logout;
    snap.readable = true;
    snap.state = classifyAuth(snap.hasAuth, snap.hasSession, snap.login, snap.logout);
  } catch { /* Navigation or a closed page remains unknown. */ }
  return snap;
}
export function describeAuth(s: AuthSnapshot): string {
  const reason = !s.readable ? '페이지 확인 불가'
    : !s.hasAuth || !s.hasSession ? '인증 쿠키 부족'
    : s.login ? '로그인 화면 표시'
    : !s.logout ? '계정 표시 확인 불가' : '로그인 확인';
  const yn = (v: boolean) => v ? '있음' : '없음';
  return `${reason} | 사이트=${s.site} | NID_AUT=${yn(s.hasAuth)}, NID_SES=${yn(s.hasSession)} | 로그인표시=${yn(s.login)}, 계정표시=${yn(s.logout)} (보호조치 판정 아님)`;
}
export async function readAuthState(ctx: BrowserContext, page: Page): Promise<AuthState> {
  return (await inspectAuth(ctx, page)).state;
}
export async function waitForAuth(ctx: BrowserContext, page: Page, timeoutMs: number): Promise<AuthSnapshot> {
  const end = Date.now() + timeoutMs;
  let snap = await inspectAuth(ctx, page);
  while (snap.state !== 'authenticated' && Date.now() < end) {
    await new Promise(r => setTimeout(r, Math.min(250, Math.max(0, end - Date.now()))));
    snap = await inspectAuth(ctx, page);
  }
  return snap;
}
export async function requireAuthenticated(ctx: BrowserContext, page: Page, timeoutMs = 750): Promise<void> {
  const snap = await waitForAuth(ctx, page, timeoutMs);
  if (snap.state !== 'authenticated') throw new Error(AUTH_STOP + ' ' + describeAuth(snap));
}

/** A signed-out session is allowed only when it started without auth cookies. */
export function assertWarmupAuth(current: AuthSnapshot, initial?: AuthSnapshot): void {
  if (current.state === 'unknown'
      || (current.state === 'signed-out' && (current.hasAuth || current.hasSession))
      || (initial && initial.state !== current.state)) {
    throw new Error(AUTH_STOP + ' 워밍업 중단: ' + describeAuth(current));
  }
}
