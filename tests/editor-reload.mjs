// 답변 입력칸이 안 열릴 때 새로고침 1회 후 재시도 확인. 실제 Chrome(headless) + 로컬 가짜 페이지. 실계정·네이버 접속 없음.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const built = await build({ entryPoints: ['electron/pwkin.ts'], bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'stubs', setup(b) {
  b.onResolve({ filter: /^(electron|playwright|\.\/db|\.\/claude)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
  b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ loader: 'js', contents: a.path === 'electron'
    ? 'export const app={getPath:()=>".",on(){}}; export class BrowserWindow{}; export const session={}; export const clipboard={}; export const safeStorage={};'
    : a.path === 'playwright' ? 'export const chromium={}; export const request={};' : 'export const getDb=()=>({}); export const generateAnswer=()=>({});' }));
} }] });
const { pwAnswerQuestion } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));

const page1 = (editorWorks) => `<html><body><button class="_answerWriteButton" onclick="${editorWorks ? "document.getElementById('e').innerHTML='<div contenteditable=true style=&quot;min-height:40px&quot;></div>'" : ''}">답변하기</button><div id="e"></div></body></html>`;
const URL_Q = 'https://kin.naver.com/qna/detail.naver?d1id=1&dirId=1&docId=777';

async function run(brokenLoads) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const ctx = await browser.newContext();
    let loads = 0;
    await ctx.route('**/*', (route) => { loads++; route.fulfill({ contentType: 'text/html', body: page1(loads > brokenLoads) }); });
    await ctx.addCookies([{ name: 'NID_AUT', value: 'synthetic-only', domain: '.naver.com', path: '/', secure: true }]);
    await ctx.newPage();
    const steps = [];
    const res = await pwAnswerQuestion(ctx, URL_Q, '테스트', false, (s) => steps.push(s));
    return { res, loads, steps };
  } finally { await browser.close(); }
}

const ok = await run(0);            // 처음부터 정상 → 새로고침 없음
assert.equal(ok.res.typed, true, JSON.stringify(ok.res));
assert.equal(ok.loads, 1);
const flaky = await run(1);         // 첫 로드에선 입력칸이 안 열림 → 새로고침 1회 후 성공
assert.equal(flaky.res.typed, true, JSON.stringify(flaky.res));
assert.equal(flaky.loads, 2);
assert.ok(flaky.steps.some((s) => s.includes('새로고침')));
const dead = await run(99);         // 계속 안 열림 → 새로고침은 딱 1회, 진단 포함 실패
assert.equal(dead.res.typed, false);
assert.equal(dead.loads, 2);
assert.match(dead.res.error, /새로고침 1회 후에도.*답변버튼=1/);
console.log('PASS: editor opens normally without reload; one reload recovers a flaky editor; persistent failure reloads exactly once and reports diagnostics');
