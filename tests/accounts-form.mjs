// Render the actual Accounts component with a synthetic API; never start Electron or use a real DB.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const out = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Accounts from './src/pages/Accounts'; import {ToastProvider} from './src/lib/toast'; createRoot(document.getElementById('root')).render(<ToastProvider><Accounts/></ToastProvider>);`, resolveDir: process.cwd(), loader: 'tsx' }, jsx: 'automatic', bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
  await page.route('**/*', r => r.abort());
  await page.setContent('<html lang="ko"><meta charset="utf-8"><body><main id="root" style="padding:24px"></main></body></html>');
  await page.addStyleTag({ content: await readFile('src/styles/globals.css','utf8') });
  await page.evaluate(() => {
    const row = { id: 1, naver_id: 'synthetic-account', memo: '', daily_limit: 5, status: 'active', proxy_host: 'proxy.invalid', proxy_port: '1234', has_password: true };
    window.saved = [];
    window.api = { accounts: { list: async () => [row], update: async (_id, fields) => { window.saved.push(fields); return window.failSave ? {error:'테스트 저장 실패'} : row; } } };
  });
  await page.addScriptTag({ content: out.outputFiles[0].text });
  await page.getByRole('button', { name: '수정', exact: true }).click();
  const password = page.getByPlaceholder('저장돼 있음 · 바꾸려면 새로 입력');
  const clear = page.getByRole('checkbox', { name: '저장된 비밀번호 삭제 (저장 버튼을 누르면 적용)' });
  assert.equal(await password.inputValue(), '');
  assert.equal(await clear.isChecked(), false);
  await page.getByRole('button', {name:'저장',exact:true}).click();
  assert.equal(await page.evaluate(() => window.saved[0].naver_pw), '');
  assert.equal(await page.evaluate(() => window.saved[0].clear_password), false);
  await page.getByRole('button', { name: '수정', exact: true }).click();
  await clear.check();
  assert.equal(await password.isDisabled(), true);
  await mkdir('release/qa', {recursive:true});
  await page.screenshot({path:'release/qa/accounts-password.png',fullPage:true});
  await page.getByRole('button', {name:'저장',exact:true}).click();
  assert.equal(await page.evaluate(() => window.saved[1].clear_password), true);
  await page.getByRole('button', { name: '수정', exact: true }).click();
  await page.evaluate(() => { window.failSave = true; });
  await page.getByRole('button', {name:'저장',exact:true}).click();
  await page.getByText('테스트 저장 실패', {exact:true}).waitFor();
  assert.equal(await page.getByRole('button', {name:'저장',exact:true}).isVisible(), true);
  console.log('PASS: actual account form preserves blank password, explicit deletion disables input, save failure retains form.');
} finally { await browser.close(); }
