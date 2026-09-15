import type { BrowserContext } from 'playwright';

/** One pending launch or live context per account. Never log profile configuration. */
export function createContextStore(launch: (id: number, config: string) => Promise<BrowserContext>) {
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
      await (await entry.pending).close();
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
