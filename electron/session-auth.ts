import type { BrowserContext, Page } from 'playwright';

export type AuthState = 'authenticated' | 'signed-out' | 'unknown';
export const AUTH_STOP = '[AUTH_STOP] 로그인 상태를 확인할 수 없어 작업을 중단했습니다. 자동 재로그인은 하지 않습니다.';

export function classifyAuth(hasAuth: boolean, hasSession: boolean, login: boolean, logout: boolean): AuthState {
  if (login) return 'signed-out';
  if (hasAuth && hasSession && logout) return 'authenticated';
  return 'unknown';
}

export async function readAuthState(ctx: BrowserContext, page: Page): Promise<AuthState> {
  try {
    const u = new URL(page.url());
    if (u.protocol !== 'https:' || !(u.hostname === 'naver.com' || u.hostname.endsWith('.naver.com'))) return 'unknown';
    const cs = await ctx.cookies('https://www.naver.com/');
    const has = (name: string) => cs.some(c => c.name === name && !!c.value);
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
    return classifyAuth(has('NID_AUT'), has('NID_SES'), ui.login, ui.logout);
  } catch { return 'unknown'; }
}

export async function requireAuthenticated(ctx: BrowserContext, page: Page): Promise<void> {
  // A page transition may temporarily hide the account menu; allow only a short, read-only retry.
  for (let i = 0; i < 3; i++) {
    const state = await readAuthState(ctx, page);
    if (state === 'authenticated') return;
    if (state === 'signed-out') break;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(AUTH_STOP);
}
