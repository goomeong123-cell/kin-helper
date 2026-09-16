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
