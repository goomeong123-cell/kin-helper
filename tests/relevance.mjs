// 연관성 판정: 응답 해석 + 요청 형태 확인. 네트워크 없음(fetch 가짜).
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const r = await build({ entryPoints: ['electron/claude.ts'], bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'db', setup(b) {
  b.onResolve({ filter: /^\.\/db$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ loader: 'js', contents: 'export const getDb=()=>({prepare:()=>({get:()=>({value:"sk-test-only"})})});' }));
} }] });
const { parseRelevance, judgeRelevance, RELEVANCE_MODEL } = await import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'));

assert.deepEqual(parseRelevance('YES\n같은 홍조 고민'), { ok: true, relevant: true, reason: '같은 홍조 고민' });
assert.deepEqual(parseRelevance('NO\n게임 질문'), { ok: true, relevant: false, reason: '게임 질문' });
assert.equal(parseRelevance('**NO** 자동차 질문').relevant, false);
assert.equal(parseRelevance('yes').relevant, true);
assert.equal(parseRelevance('잘 모르겠습니다').ok, false);

let sent;
globalThis.fetch = async (url, init) => { sent = JSON.parse(init.body); return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'NO\n법률 질문' }], stop_reason: 'end_turn' }) }; };
const j = await judgeRelevance({ brandPrompt: '홍조 크림 홍보', questionTitle: '전세 계약 해지 방법', questionBody: '' });
assert.deepEqual(j, { ok: true, relevant: false, reason: '법률 질문' });
assert.equal(sent.model, RELEVANCE_MODEL);
assert.equal(sent.temperature, undefined, 'temperature 를 보내면 400');
assert.deepEqual(sent.thinking, { type: 'disabled' });
globalThis.fetch = async () => ({ ok: true, json: async () => ({ content: [], stop_reason: 'refusal' }) });
assert.equal((await judgeRelevance({ brandPrompt: 'x', questionTitle: 'y', questionBody: '' })).ok, false);
console.log('PASS: relevance parsing (YES/NO/markdown/garbage), request shape (haiku-5-5, no temperature, thinking disabled), refusal handled');
