// 회선 판별 규칙 확인 (네트워크 없음). 대역명 예시는 공개 RDAP에서 관측되는 형식.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const r = await build({ entryPoints: ['electron/ip-line.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { classifyNetname } = await import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'));

assert.equal(classifyNetname('HAIONNET-KR', 'HAIonNet'), 'hosting', '하이온넷 = 실제 보호조치 사례의 대역');
assert.equal(classifyNetname('KINXINC-KR'), 'hosting');
assert.equal(classifyNetname('SMILESERV-KR'), 'hosting');
assert.equal(classifyNetname('KORNET', 'Korea Telecom'), 'carrier');
assert.equal(classifyNetname('SKBROADBAND-NET'), 'carrier');
assert.equal(classifyNetname('LGDACOM-NET', 'LG DACOM Corporation'), 'carrier');
assert.equal(classifyNetname('SKTELECOM-NET'), 'carrier');
assert.equal(classifyNetname('KT-MOBILE', 'KT Corporation'), 'carrier');
assert.equal(classifyNetname('SOMENET-KR', 'Some Company'), 'unknown');
// 통신사 이름이 있어도 호스팅 단서가 같이 있으면 호스팅 우선 (예: KT 클라우드)
assert.equal(classifyNetname('KTCLOUD-KR', 'kt cloud'), 'hosting');
console.log('PASS: netname classification (hosting/carrier/unknown) incl. HAIONNET case');
