// Read-only audit of production functions through mocked external boundaries.
// No browser launch, network request, real database, or account credentials.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const calls = [];
let failRequest = false;
const fakeAccount = { id: 1, naver_id: 'synthetic', naver_pw: 'enc:v1:synthetic-only', daily_limit: 5, status: 'active' };
let savedPassword = 'unchanged';
globalThis.__auditDb = { prepare(sql) { return {
  get() { return fakeAccount; }, all() { return []; },
  run(values) { if (sql === 'UPDATE accounts SET naver_pw=? WHERE id=?') savedPassword = values[0]; return { changes: 1 }; },
}; } };
globalThis.__auditRequest = { async newContext(options) {
  calls.push({ kind: 'request-context', options });
  return { async get() { if (failRequest) throw Error('synthetic certificate error'); calls.push({ kind: 'request-get' }); return { ok: () => true, text: async () => '<meta property="og:title" content="test">' }; }, async dispose() {} };
} };
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { calls.push({ kind: 'direct-fetch' }); return { ok: true, text: async () => '<meta property="og:title" content="test">' }; };
try {
  const built = await build({ stdin: { contents: "export { buildContextOptions, getAccountContext } from './electron/pwlogin'; export { fetchQuestionDetail, collectQuestions } from './electron/naver'; export { registerIpc } from './electron/ipc';", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'external-boundaries', setup(b) {
    b.onResolve({ filter: /^(electron|playwright|\.\/db|\.\/claude)$/ }, args => ({ path: args.path, namespace: 'audit' }));
    b.onLoad({ filter: /.*/, namespace: 'audit' }, args => ({ loader: 'js', contents:
      args.path === 'electron' ? 'export const app={on(){},getVersion(){return "test"}}; export class BrowserWindow{}; export const session={}; export const clipboard={}; export const safeStorage={isEncryptionAvailable:()=>false};'
      : args.path === 'playwright' ? 'export const request=globalThis.__auditRequest; export const chromium={launchPersistentContext(){throw Error("Real browser launch forbidden in this audit")}};'
      : args.path === './db' ? 'export const getDb=()=>globalThis.__auditDb;'
      : 'export function generateAnswer(){throw Error("API calls forbidden")}' }));
  } }] });
  const api = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
  const account = { id: 1, naverId: 'synthetic', proxyHost: 'proxy.invalid', proxyPort: '1234', proxyUser: 'test', proxyPass: 'synthetic-only' };
  assert.deepEqual(api.buildContextOptions(account).proxy, { server: 'http://proxy.invalid:1234', username: 'test', password: 'synthetic-only' });
  assert.throws(() => api.getAccountContext({ id: 1 }), /프록시/);
  console.log('PASS: Chrome forwards configured proxy; missing proxy prevents launch.');
  assert.deepEqual(api.buildContextOptions(account).ignoreDefaultArgs, ['--enable-automation']); // 유일하게 허용된 예외 (자동화 안내 막대 끄기). 그 외 인자 덮어쓰기는 여전히 금지
  assert.equal(api.buildContextOptions(account).chromiumSandbox, true);
  assert.equal(api.buildContextOptions(account).userAgent, undefined);
  assert.equal(api.buildContextOptions(account).locale, undefined);
  calls.length = 0;
  await assert.rejects(api.fetchQuestionDetail('https://kin.naver.com/qna/detail.naver?docId=1'), /PROXY_REQUIRED/);
  await assert.rejects(api.collectQuestions({}), /PROXY_REQUIRED/);
  for (const port of ['', '0', '-1', '65536', '80;direct://']) {
    assert.throws(() => api.buildContextOptions({ ...account, proxyPort: port }), /PROXY_REQUIRED/);
  }
  assert.equal(calls.length, 0);
  console.log('PASS: missing/invalid proxy prevents collection and detail requests before network access.');
  calls.length = 0;
  await api.fetchQuestionDetail('https://kin.naver.com/qna/detail.naver?docId=1', account);
  assert.equal(calls.filter(c => c.kind === 'direct-fetch').length, 0);
  const options = calls.find(c => c.kind === 'request-context').options;
  assert.equal(options.proxy.server, 'http://proxy.invalid:1234');
  assert.equal(options.ignoreHTTPSErrors, false);
  assert.equal(options.userAgent, undefined);
  assert.equal(options.storageState, undefined);
  failRequest = true;
  await assert.rejects(api.fetchQuestionDetail('https://kin.naver.com/qna/detail.naver?docId=1', account), /HTTPS/);
  failRequest = false;
  assert.equal(calls.filter(c => c.kind === 'direct-fetch').length, 0);
  console.log('PASS: TLS validation enabled; request failure is propagated without direct retry.');
  const handlers = new Map();
  const originalInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  try { api.registerIpc({ handle(name, fn) { handlers.set(name, fn); } }); }
  finally { globalThis.setInterval = originalInterval; }
  await handlers.get('accounts:update')(null, 1, { naver_pw: '', memo: 'synthetic edit' });
  assert.equal(savedPassword, fakeAccount.naver_pw);
  await handlers.get('accounts:update')(null, 1, { memo: 'omitted password' });
  assert.equal(savedPassword, fakeAccount.naver_pw);
  await handlers.get('accounts:update')(null, 1, { clear_password: true, naver_pw: '' });
  assert.equal(savedPassword, null);
  savedPassword = 'unchanged';
  const conflict = await handlers.get('accounts:update')(null, 1, { clear_password: true, naver_pw: 'synthetic-only' });
  assert.ok(conflict.error);
  assert.equal(savedPassword, 'unchanged');
  const encryptionFailure = await handlers.get('accounts:update')(null, 1, { naver_pw: 'synthetic-only' });
  assert.ok(encryptionFailure.error);
  assert.equal(savedPassword, 'unchanged');
  console.log('PASS: blank/omitted password preserved, explicit deletion, conflicting input and encryption failure do not overwrite.');
} finally {
  globalThis.fetch = originalFetch;
  delete globalThis.__auditDb;
  delete globalThis.__auditRequest;
}
