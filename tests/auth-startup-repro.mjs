import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const result = await build({ entryPoints: ['electron/session-auth.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { readAuthState, requireAuthenticated } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
const dir = await mkdtemp(path.join(tmpdir(), 'kin-auth-repro-'));
let ctx;
try {
  ctx = await chromium.launchPersistentContext(dir, { channel: 'chrome', headless: true });
  await ctx.route('**/*', r => r.fulfill({ contentType: 'text/html', body: '<html><body>local test only</body></html>' }));
  const page = ctx.pages()[0];
  await page.goto('https://www.naver.com/');
  await ctx.addCookies([
    { name: 'NID_AUT', value: 'synthetic-only', domain: '.naver.com', path: '/', secure: true, expires: Date.now()/1000+86400 },
    { name: 'NID_SES', value: 'synthetic-only', domain: '.naver.com', path: '/', secure: true },
  ]);
  await page.evaluate(() => setTimeout(() => { document.body.innerHTML = '<a class="gnb_my" href="#">Account</a>'; }, 1500));
  const start = Date.now();
  let stopped = false;
  try { await requireAuthenticated(ctx, page, 8000); } catch { stopped = true; }
  console.log(JSON.stringify({ scenario: 'delayed-account-ui', stopped, elapsedMs: Date.now()-start }));
  assert.equal(stopped, false);
  await new Promise(r => setTimeout(r, 1700));
  assert.equal(await readAuthState(ctx,page), 'authenticated');
  console.log('Confirmed: the same page becomes authenticated without logging in again.');
  await ctx.close();
  ctx = await chromium.launchPersistentContext(dir, { channel: 'chrome', headless: true });
  const names = new Set((await ctx.cookies('https://www.naver.com/')).map(c => c.name));
  console.log(JSON.stringify({ scenario: 'profile-reopen', NID_AUT: names.has('NID_AUT'), NID_SES: names.has('NID_SES') }));
} finally {
  await ctx?.close();
  assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));
  assert.ok(path.basename(dir).startsWith('kin-auth-repro-'));
  await rm(dir,{recursive:true,force:true});
}
