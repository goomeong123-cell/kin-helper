import type { AccountProxy } from './naver';

/** Validate before any browser/session/request can be created. No direct fallback. */
export function proxyFor(acc?: AccountProxy) {
  const host = String(acc?.proxyHost || '').trim();
  const port = String(acc?.proxyPort || '').trim();
  if (!acc || !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])$/i.test(host) || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('[PROXY_REQUIRED] 등록계정을 선택하고 유효한 프록시 주소와 포트를 설정해 주세요.');
  }
  return { server: `http://${host}:${Number(port)}`, username: acc.proxyUser || undefined, password: acc.proxyPass || undefined };
}
