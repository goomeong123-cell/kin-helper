import type { BrowserContext } from 'playwright';

/**
 * 만료 없는(세션) 네이버 쿠키에 30일 만료일을 붙여 디스크에 남긴다. 값은 그대로 — 서버는 만료일을 볼 수 없다.
 * Chrome은 세션 쿠키를 종료 시 버리므로, 이걸 안 하면 업데이트·재시작마다 로그아웃 → 재로그인 → 보호조치 위험.
 * 반환: 다시 쓴 쿠키 수. (tests/session-persist.mjs)
 */
export async function persistSessionCookies(ctx: BrowserContext): Promise<number> {
  const all = await ctx.cookies();
  const session = all.filter((c) => c.expires === -1 && /(^|\.)naver\.com$/.test(c.domain.replace(/^\./, '')));
  if (!session.length) return 0;
  const expires = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  await ctx.addCookies(session.map((c) => ({ ...c, expires })));
  return session.length;
}

/**
 * 다 본 질문 탭 정리 — 사람이 글을 다 보고 탭을 닫고 목록으로 돌아가는 것과 같다.
 * 지식인 목록의 질문 링크는 새 탭으로 열리는데, 예전엔 '자동 등록 성공' 때만 닫아서
 * 관전 모드·건너뜀·오류 때마다 탭이 쌓였다(실사례: 수십 개 → VM 메모리 부담, 마지막 탭을 작업 탭으로 쓰는 로직이 엉뚱한 탭을 집을 위험).
 * 안전장치:
 *  - 첫 탭은 절대 닫지 않는다 — 마지막 탭을 닫으면 창이 닫히고 그 계정 작업이 통째로 끊긴다.
 *  - 지식인(kin.naver.com) 탭과 빈 탭만 닫는다 — 사람이 따로 연 다른 사이트 탭은 건드리지 않는다.
 *  - 닫기 전 그 탭의 요청이 끝나길 잠깐 기다린다 — 관전 모드에서 직접 누른 [등록]이 전송 중이면 끊기지 않게.
 * 탭은 같은 브라우저 컨텍스트(같은 쿠키)라 닫아도 로그인 세션에는 영향이 없다. (tests/tab-cleanup.mjs)
 */
export async function closeDoneTabs(ctx: Pick<BrowserContext, 'pages'>): Promise<number> {
  const ps = ctx.pages();
  let closed = 0;
  for (let i = ps.length - 1; i >= 1; i--) {
    const p = ps[i];
    let host = '';
    try {
      host = new URL(p.url()).hostname;
    } catch {
      /* about:blank 등 → 빈 탭으로 취급 */
    }
    if (host && host !== 'kin.naver.com') continue;
    await p.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    await p.close().catch(() => {});
    closed++;
  }
  return closed;
}

/**
 * 네이버가 띄우는 알림창(alert/confirm) 내용을 기억한다.
 * Playwright 는 리스너가 없으면 알림창을 '즉시 자동으로 닫는다'(alert/confirm → dismiss, beforeunload → accept).
 * 그래서 자동화 창에서는 사람이 직접 눌러도 안내 문구가 보이지 않고 "눌렀는데 아무 일도 안 일어남"처럼 보인다.
 * 여기서는 닫는 동작은 기본과 똑같이 두고(동작 변화 없음), 무슨 문구였는지만 남긴다. (tests/dialog-watch.mjs)
 */
export interface SeenDialog { type: string; message: string; ts: number }
const dialogs = new WeakMap<object, SeenDialog[]>();
export function watchDialogs(ctx: BrowserContext, onDialog?: (d: SeenDialog) => void): void {
  dialogs.set(ctx, []);
  ctx.on('dialog', (d) => {
    const seen: SeenDialog = { type: d.type(), message: (d.message() || '').trim().slice(0, 300), ts: Date.now() };
    if (seen.type === 'beforeunload') {
      d.accept().catch(() => {});
      return;
    }
    const list = dialogs.get(ctx);
    if (list) {
      list.push(seen);
      if (list.length > 20) list.shift();
    }
    try { onDialog?.(seen); } catch { /* 기록 실패가 작업을 막지 않게 */ }
    d.dismiss().catch(() => {});
  });
}
/** since(ms 시각) 이후에 뜬 알림창들 */
export function dialogsSince(ctx: object, since: number): SeenDialog[] {
  return (dialogs.get(ctx) || []).filter((d) => d.ts >= since);
}

/** One pending launch or live context per account. Never log profile configuration. */
export function createContextStore(
  launch: (id: number, config: string) => Promise<BrowserContext>,
  /** 닫기 직전에 한 번 실행 (세션 쿠키 영구화 등). 실패해도 닫기는 진행한다. */
  beforeClose?: (ctx: BrowserContext) => Promise<unknown>,
) {
  const entries = new Map<number, { config: string; pending: Promise<BrowserContext> }>();
  let shuttingDown = false;
  return {
    hasOpen: () => entries.size > 0,
    async get(id: number, config: string): Promise<BrowserContext> {
      if (shuttingDown) throw new Error('앱 종료 중에는 브라우저를 열 수 없습니다.');
      const existing = entries.get(id);
      if (existing) {
        if (existing.config !== config) throw new Error('계정/프록시 설정이 변경되었습니다. 기존 Chrome 창을 닫은 후 다시 열어주세요.');
        return existing.pending;
      }
      const entry = { config, pending: Promise.resolve().then(() => launch(id, config)) };
      entries.set(id, entry);
      try {
        const ctx = await entry.pending;
        ctx.on('close', () => { if (entries.get(id) === entry) entries.delete(id); });
        return ctx;
      } catch (e) {
        if (entries.get(id) === entry) entries.delete(id);
        throw e;
      }
    },
    async close(id: number): Promise<void> {
      const entry = entries.get(id);
      if (!entry) return;
      const ctx = await entry.pending;
      if (beforeClose) await beforeClose(ctx).catch(() => {});
      await ctx.close();
      if (entries.get(id) === entry) entries.delete(id);
    },
    async closeAll(): Promise<void> {
      const results = await Promise.allSettled(Array.from(entries.keys(), id => this.close(id)));
      if (results.some(r => r.status === 'rejected')) throw new Error('Chrome 종료를 완료하지 못했습니다.');
    },
    async shutdown(): Promise<void> {
      shuttingDown = true;
      await this.closeAll();
    },
  };
}
