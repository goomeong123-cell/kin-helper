// 다 본 질문 탭 정리 확인 — 실제 Chrome(headless), 모든 요청은 로컬 응답. 실계정·네이버 접속 없음.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const r = await build({ entryPoints: ['electron/browser-contexts.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { closeDoneTabs } = await import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const ctx = await browser.newContext();
  await ctx.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<html><body>local fixture</body></html>' }));
  await ctx.addCookies([{ name: 'NID_AUT', value: 'synthetic-only', domain: '.naver.com', path: '/', secure: true }]);
  const open = async (url) => { const p = await ctx.newPage(); if (url) await p.goto(url); return p; };

  const list = await open('https://kin.naver.com/qna/list.naver'); // 첫 탭 = 목록
  await open('https://kin.naver.com/qna/detail.naver?docId=1');      // 다 본 질문
  const other = await open('https://www.example.com/');              // 사람이 따로 연 다른 사이트
  await open('');                                                     // 빈 탭
  await open('https://kin.naver.com/qna/detail.naver?docId=2');      // 다 본 질문

  const n = await closeDoneTabs(ctx);
  assert.equal(n, 3, '지식인 질문 탭 2개 + 빈 탭 1개만 닫아야 함');
  assert.deepEqual(ctx.pages(), [list, other], '첫 탭(목록)과 다른 사이트 탭은 남아야 함');
  // 탭을 닫아도 같은 컨텍스트 → 로그인 쿠키·창 그대로
  assert.ok((await ctx.cookies('https://www.naver.com/')).some((c) => c.name === 'NID_AUT'), '쿠키 유지');
  await open('https://kin.naver.com/qna/detail.naver?docId=3'); // 컨텍스트가 살아 있어 새 탭도 열림
  assert.equal(ctx.pages().length, 3);
  await ctx.close();

  // 탭이 하나뿐이면(사람이 목록 탭을 닫아 질문 탭만 남은 경우) 절대 닫지 않는다 → 창이 안 꺼짐
  const solo = await browser.newContext();
  await solo.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  const only = await solo.newPage();
  await only.goto('https://kin.naver.com/qna/detail.naver?docId=9');
  assert.equal(await closeDoneTabs(solo), 0);
  assert.deepEqual(solo.pages(), [only]);
  await solo.close();
} finally {
  await browser.close();
}
console.log('PASS: closes finished kin tabs + blank tabs; keeps first tab and other-site tabs; cookies/context survive; never closes the last tab');
