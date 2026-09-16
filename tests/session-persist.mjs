// 세션 쿠키 영구화 확인: 만료 없는 NID_SES가 Chrome 재실행 후에도 남는가.
// 임시 프로필 + 가짜 쿠키 값 + 모든 요청 로컬 응답. 실제 계정·네이버 접속 없음.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const result = await build({ entryPoints: ['electron/browser-contexts.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { persistSessionCookies } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));

const cookies = [
  { name: 'NID_AUT', value: 'synthetic-only', domain: '.naver.com', path: '/', secure: true, expires: Date.now() / 1000 + 86400 },
  { name: 'NID_SES', value: 'synthetic-only', domain: '.naver.com', path: '/', secure: true }, // 만료 없음 = 세션 쿠키
];
const launch = (dir) => chromium.launchPersistentContext(dir, { channel: 'chrome', headless: true });
const names = async (ctx) => new Set((await ctx.cookies('https://www.naver.com/')).map((c) => c.name));

async function run(persist) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kin-persist-'));
  try {
    let ctx = await launch(dir);
    await ctx.addCookies(cookies);
    const n = persist ? await persistSessionCookies(ctx) : 0;
    await ctx.close();
    ctx = await launch(dir);
    const after = await names(ctx);
    await ctx.close();
    return { n, after };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const control = await run(false);
assert.ok(control.after.has('NID_AUT') && !control.after.has('NID_SES'), '대조군: 세션 쿠키는 재실행 시 사라져야 이 테스트가 의미 있음');
const fixed = await run(true);
assert.equal(fixed.n, 1, '세션 쿠키 1개만 다시 써야 함 (NID_AUT는 이미 만료일 있음)');
assert.ok(fixed.after.has('NID_SES'), 'persistSessionCookies 후 NID_SES가 재실행에도 남아야 함');
console.log('PASS: session cookie survives Chrome relaunch after persistSessionCookies (control confirms it is dropped otherwise)');
