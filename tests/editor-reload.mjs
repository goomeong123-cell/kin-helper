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
const { pwAnswerQuestion, __watchDialogs: watchDialogs } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));

const page1 = (editorWorks, alertMsg) => `<html><body><button class="_answerWriteButton" onclick="${editorWorks ? "document.getElementById('e').innerHTML='<div contenteditable=true style=&quot;min-height:40px&quot;></div>'" : alertMsg ? `alert('${alertMsg}')` : ''}">답변하기</button><div id="e"></div></body></html>`;
const URL_Q = 'https://kin.naver.com/qna/detail.naver?d1id=1&dirId=1&docId=777';

async function run(brokenLoads, alertMsg) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const ctx = await browser.newContext();
    let loads = 0;
    await ctx.route('**/*', (route) => { loads++; route.fulfill({ contentType: 'text/html; charset=utf-8', body: page1(loads > brokenLoads, alertMsg) }); });
    watchDialogs(ctx);
    await ctx.addCookies([{ name: 'NID_AUT', value: 'synthetic-only', domain: '.naver.com', path: '/', secure: true }]);
    await ctx.newPage(); // 첫 탭 = 목록 자리
    await ctx.newPage(); // 질문 탭 (목록에서 클릭해 열린 것과 같은 위치)
    const steps = [];
    const res = await pwAnswerQuestion(ctx, URL_Q, '테스트', false, (s) => steps.push(s));
    return { res, loads, steps, tabs: ctx.pages().length };
  } finally { await browser.close(); }
}

const ok = await run(0);            // 처음부터 정상 → 새로고침 없음
assert.equal(ok.res.typed, true, JSON.stringify(ok.res));
assert.equal(ok.loads, 1);
const flaky = await run(1);         // 첫 로드에선 입력칸이 안 열림 → 새로고침 1회 후 성공
assert.equal(flaky.res.typed, true, JSON.stringify(flaky.res));
assert.equal(flaky.loads, 2);
assert.ok(flaky.steps.some((s) => s.includes('새로고침')));
const tab = await run(2);           // 새로고침으로도 안 열림 → 새 탭에서 다시 열어 성공. 옛 탭은 닫혀 탭이 늘지 않음
assert.equal(tab.res.typed, true, JSON.stringify(tab.res));
assert.equal(tab.loads, 3);
assert.ok(tab.steps.some((s) => s.includes('새 탭')));
assert.equal(tab.tabs, 2); // 목록 탭 + 새 질문 탭 (옛 질문 탭은 닫힘)
const dead = await run(99);         // 계속 안 열림 → 재시도는 새로고침 1 + 새 탭 1 뿐, 진단 포함 실패
assert.equal(dead.res.typed, false);
assert.equal(dead.loads, 3);
assert.match(dead.res.error, /재시도 후에도.*답변버튼=1.*알림창 없음/);
const limited = await run(99, '오늘은 더 이상 답변할 수 없습니다'); // 네이버가 알림창으로 거절 → 문구가 실패 사유에 남는다
assert.equal(limited.res.typed, false);
assert.match(limited.res.error, /네이버 알림창: "오늘은 더 이상 답변할 수 없습니다"/);
assert.ok(limited.steps.some((s) => s.includes('네이버 알림창')));
console.log('PASS: normal open (no reload); reload recovers; new-tab recovers without leaking tabs; persistent failure reports diagnostics; a Naver alert text is captured into the failure reason');
