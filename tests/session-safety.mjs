// Run: node tests/session-safety.mjs. No real accounts, profiles, DB or external HTTP requests.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

async function bundle(file, plugins = []) {
  const result = await build({ entryPoints: [file], bundle: true, write: false, platform: 'node', format: 'esm', plugins });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}
const { createContextStore } = await bundle('electron/browser-contexts.ts');
const { readAuthState, requireAuthenticated, inspectAuth, describeAuth } = await bundle('electron/session-auth.ts');
class Context extends EventEmitter {
  async close() { this.emit('close'); }
}
let launches = 0;
const store = createContextStore(async () => { launches++; await new Promise(r => setTimeout(r, 10)); return new Context(); });
const [a, b] = await Promise.all([store.get(1, 'A'), store.get(1, 'A')]);
assert.equal(a, b);
assert.equal(launches, 1);
await assert.rejects(store.get(1, 'B'));
await store.close(1);
assert.notEqual(await store.get(1, 'B'), a);
await store.shutdown();
await assert.rejects(store.get(2, 'A'));
let fail = true;
const retry = createContextStore(async () => { if (fail) throw Error('launch failure'); return new Context(); });
await assert.rejects(retry.get(1, 'A'));
fail = false;
await retry.get(1, 'A');
await retry.closeAll();
const closing = createContextStore(async () => { await new Promise(r => setTimeout(r, 10)); return new Context(); });
const pending = closing.get(3, 'A');
await closing.close(3);
await pending;
assert.equal(closing.hasOpen(), false);
console.log('PASS: launch deduplication, config guard, failed-launch recovery, pending-launch close, shutdown guard');

// Actual DOM evaluation in a clean headless browser. All requests are fulfilled locally.
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const ctx = await browser.newContext();
  await ctx.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<html><body>local fixture</body></html>' }));
  const page = await ctx.newPage();
  await page.goto('https://www.naver.com/');
  const cookies = ['NID_AUT', 'NID_SES'].map(name => ({ name, value: 'synthetic-test-only', domain: '.naver.com', path: '/', secure: true }));
  await ctx.addCookies(cookies);
  await page.setContent('<a href="https://nid.naver.com/nidlogin.logout">Logout</a>');
  assert.equal(await readAuthState(ctx, page), 'authenticated');
  await requireAuthenticated(ctx, page);
  await page.setContent('<a href="https://nid.naver.com/nidlogin.login">Login</a>');
  assert.equal(await readAuthState(ctx, page), 'signed-out');
  await assert.rejects(requireAuthenticated(ctx, page), /AUTH_STOP/);
  await page.setContent('<a class="gnb_my" href="#">My account</a>');
  await ctx.clearCookies();
  await ctx.addCookies([cookies[0]]);
  assert.equal(await readAuthState(ctx, page), 'unknown');
  await assert.rejects(requireAuthenticated(ctx, page), /NID_SES=없음/);
  assert.ok(!describeAuth(await inspectAuth(ctx, page)).includes('synthetic-test-only'));
  await ctx.addCookies(cookies);
  await page.setContent('<div>unrecognized page</div>');
  assert.equal(await readAuthState(ctx, page), 'unknown');
  await page.goto('https://example.test/');
  assert.equal(await readAuthState(ctx, page), 'unknown');
  await ctx.close();
} finally { await browser.close(); }
console.log('PASS: DOM authentication, stale cookies, partial cookies, missing UI, unrelated host; external requests blocked');

const temp = await mkdtemp(path.join(tmpdir(), 'kin-session-test-'));
try {
  let active;
  globalThis.__sessionTestLaunch = async () => active;
  const login = await bundle('electron/pwlogin.ts', [{ name: 'offline-dependencies', setup(b) {
    b.onResolve({ filter: /^(electron|playwright)$/ }, args => ({ path: args.path, namespace: 'test-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'test-stub' }, args => ({ contents: args.path === 'electron'
      ? 'export const app = { getPath: () => ' + JSON.stringify(temp) + ' };'
      : 'export const chromium = { launchPersistentContext: (...args) => globalThis.__sessionTestLaunch(...args) };', loader: 'js' }));
  } }]);
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => realTimeout(fn, Math.min(ms, 5), ...args);
  function fixture(sequence) {
    const ctx = new Context();
    let reads = 0;
    ctx.gotos = [];
    ctx.clicks = 0;
    ctx.addInitScript = async () => {};
    ctx.cookies = async () => [{ name: 'NID_AUT', value: 'test' }, { name: 'NID_SES', value: 'test' }];
    const page = {
      goto: async u => { ctx.gotos.push(u); }, url: () => 'https://www.naver.com/', bringToFront: async () => {},
      evaluate: async () => sequence[Math.min(reads++, sequence.length - 1)],
      locator: () => { ctx.clicks++; throw Error('Unexpected login interaction'); },
    };
    ctx.pages = () => [page];
    return ctx;
  }
  try {
    active = fixture([{ login: false, logout: true }, { login: true, logout: false }]);
    const lost = await login.loginWithRealChrome({ id: 1, naverId: 'test', proxyHost: 'test.invalid', proxyPort: 1 }, undefined, 'synthetic-only');
    assert.equal(lost.ok, true); // Successful login hands off the still-open context.
    assert.equal(await login.getAccountContext({ id: 1, naverId: 'test', proxyHost: 'test.invalid', proxyPort: 1 }), active);
    assert.equal(active.clicks, 0);
    assert.deepEqual(active.gotos, ['https://www.naver.com/']);
    await login.closeAllKinContexts();
    active = fixture([{ login: true, logout: false }]);
    const browse = await login.loginWithRealChrome({ id: 2, naverId: 'test', proxyHost: 'test.invalid', proxyPort: 1 }, undefined, undefined, 'browse');
    assert.equal(browse.ok, true);
    assert.equal(active.clicks, 0);
    await login.closeAllKinContexts();
    active = fixture([{ login: false, logout: false }]);
    const unknown = await login.loginWithRealChrome({ id: 3, naverId: 'test', proxyHost: 'test.invalid', proxyPort: 1 }, undefined, 'synthetic-only');
    assert.equal(unknown.ok, false);
    assert.equal(active.clicks, 0);
    await login.closeAllKinContexts();
  } finally { globalThis.setTimeout = realTimeout; delete globalThis.__sessionTestLaunch; }
} finally {
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(tmpdir()));
  assert.ok(path.basename(temp).startsWith('kin-session-test-'));
  await rm(temp, { recursive: true, force: true });
}
console.log('PASS: existing session hands off without closing or logging in again, browse never logs in, unknown state refuses auto-login');
