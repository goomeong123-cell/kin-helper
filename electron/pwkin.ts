// 지식인 작업(질문 찾기·답변·등록)을 '로그인한 그 크롬 그대로' 수행한다.
//
// 왜 필요한가:
//   예전엔 로그인만 진짜 크롬으로 하고, 쿠키를 Electron 창으로 옮겨 답변을 등록했다.
//   그러면 같은 세션 쿠키가 갑자기 다른 브라우저에서 나타나는 꼴이라 네이버가
//   '세션 탈취'로 보고 세션을 죽인다(= 등록이 안 되고 곧 로그아웃됨).
//   로그인부터 등록까지 전부 같은 크롬 컨텍스트에서 해야 한다. (카페포스터와 동일)

import type { BrowserContext, Page } from 'playwright';
import type { AccountProxy, CollectedQuestion } from './naver';
import {
  ACTIVATE_TAB_JS,
  SCRAPE_NOANSWER_JS,
  SORT_RECENT_JS,
  HAS_EDITOR_JS,
  QUESTION_LIST_URL,
  advancePageJS,
  searchInPageJS,
  normalizeKinUrl,
} from './naver';
import { applyStealthInit, buildContextOptions, profileDirFor } from './pwlogin';

const rnd = (a: number, b: number) => a + Math.floor(Math.random() * (b - a));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const human = (min = 600, max = 1600) => sleep(rnd(min, max));

// 계정별 크롬 컨텍스트를 재사용한다 (매번 새로 띄우면 느리고 부자연스럽다)
const contexts = new Map<number, BrowserContext>();

function isAlive(ctx: BrowserContext): boolean {
  try {
    return !!ctx.browser()?.isConnected();
  } catch {
    return false;
  }
}

/** 이 계정의 크롬 컨텍스트 (없으면 띄운다). 로그인 때 쓰던 프로필을 그대로 사용. */
export async function getAccountContext(acc: AccountProxy): Promise<BrowserContext> {
  const existing = contexts.get(acc.id);
  if (existing && isAlive(existing)) return existing;
  const { chromium } = await import('playwright');
  const ctx = await chromium.launchPersistentContext(profileDirFor(acc.id), buildContextOptions(acc));
  // 로그인 때와 '완전히 같은' 위장을 적용해야 한다. 조금이라도 다르면 세션을 의심받는다.
  await applyStealthInit(ctx, acc);
  contexts.set(acc.id, ctx);
  ctx.on('close', () => contexts.delete(acc.id));
  return ctx;
}

export async function closeAccountContext(accountId: number): Promise<void> {
  const ctx = contexts.get(accountId);
  contexts.delete(accountId);
  try {
    if (ctx && isAlive(ctx)) await ctx.close();
  } catch {
    /* ignore */
  }
}

export async function closeAllKinContexts(): Promise<void> {
  for (const id of Array.from(contexts.keys())) await closeAccountContext(id);
}


/**
 * 진짜 마우스 클릭 (isTrusted=true). 실패하면 JS 클릭으로 폴백한다.
 * ★ JS로 누른 클릭은 isTrusted=false 라 사람이 누른 것과 구분된다.
 *   특히 '답변'·'등록' 같은 핵심 버튼은 반드시 진짜 클릭이어야 한다.
 */
async function realClick(page: Page, selector: string, fallbackJs?: string): Promise<boolean> {
  try {
    const el = page.locator(selector).first();
    if (await el.count()) {
      await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await sleep(rnd(150, 400)); // 사람처럼 버튼을 보고 잠깐 뒤 누름
      await el.click({ timeout: 6000 });
      return true;
    }
  } catch {
    // 가려져 있거나 타이밍 문제 — 아래 폴백
  }
  if (fallbackJs) {
    const ok = await page.evaluate(fallbackJs).catch(() => false);
    return !!ok;
  }
  return false;
}

/** 목록 탭(첫 번째) */
function firstPage(ctx: BrowserContext): Promise<Page> {
  const p = ctx.pages()[0];
  return p ? Promise.resolve(p) : ctx.newPage();
}

/** 지금 작업 중인 탭 = 가장 최근에 열린 탭 (지식인 질문은 '새 창'으로 열린다) */
function activePage(ctx: BrowserContext): Promise<Page> {
  const ps = ctx.pages();
  const p = ps[ps.length - 1];
  return p ? Promise.resolve(p) : ctx.newPage();
}

/** 목록 탭만 남기고 나머지 탭을 닫는다 (사람처럼 탭이 쌓이지 않게) */
async function closeExtraTabs(ctx: BrowserContext): Promise<void> {
  const ps = ctx.pages();
  for (let i = ps.length - 1; i >= 1; i--) {
    try {
      await ps[i].close();
    } catch {
      /* ignore */
    }
  }
}

/** 로그인 여부 — 쿠키로 판정 (DOM보다 안정적) */
export async function pwIsLoggedIn(ctx: BrowserContext): Promise<boolean> {
  try {
    const cs = await ctx.cookies();
    return cs.some((c) => (c.name === 'NID_AUT' || c.name === 'NID_SES') && !!c.value);
  } catch {
    return false;
  }
}

/**
 * 답변 대기 목록에서 답변할 질문을 하나 고른다.
 * keyword가 있으면 위젯 내 검색 → 최신순, 없으면 전체 답변대기 → 최신순.
 * '그 페이지'에 쓸 만한 질문이 없을 때만 다음 페이지로 넘어간다(최신순 우선).
 */
export async function pwFindQuestion(
  ctx: BrowserContext,
  opts: { keyword?: string; scanPages?: number; isUsable?: (q: CollectedQuestion) => boolean },
  onStep?: (s: string) => void,
): Promise<{ picked?: CollectedQuestion; scanned: number; pages: number }> {
  const page = await firstPage(ctx);
  const scanPages = Math.max(1, Math.min(20, opts.scanPages ?? 3));
  onStep?.(opts.keyword ? `'${opts.keyword}' 검색 → 최신순` : '답변 대기 목록 → 최신순');

  await page.goto(QUESTION_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  await human(2200, 3400);
  await realClick(page, '#contentsOfMain', ACTIVATE_TAB_JS);
  await human(1400, 2400);

  if (opts.keyword) {
    // 사람처럼: 검색창 클릭 → 한 글자씩 입력 → 검색 버튼 클릭
    let typed = false;
    try {
      const input = page.locator('#questionAll input._search_input').first();
      if (await input.count()) {
        await input.click({ timeout: 6000 });
        await sleep(rnd(200, 500));
        await input.fill('');
        await page.keyboard.type(opts.keyword, { delay: rnd(60, 160) });
        await sleep(rnd(250, 600));
        typed = true;
      }
    } catch {
      // 아래 JS 폴백
    }
    if (typed) {
      const searched = await realClick(page, '#questionAll a._search_button');
      if (!searched) await page.keyboard.press('Enter').catch(() => {});
    } else {
      await page.evaluate(searchInPageJS(opts.keyword)).catch(() => {});
    }
    await human(2600, 3600);
  }
  {
    let sorted = false;
    try {
      const btn = page.locator('#questionAll a, #questionAll button').filter({ hasText: /^\s*최신순\s*$/ }).first();
      if (await btn.count()) {
        await btn.click({ timeout: 6000 });
        sorted = true;
      }
    } catch {
      // 폴백
    }
    if (!sorted) await page.evaluate(SORT_RECENT_JS).catch(() => {});
  }
  await human(2000, 3000);

  let scanned = 0;
  let pageNo = 1;
  const seen = new Set<string>();
  while (pageNo <= scanPages) {
    await page.evaluate('window.scrollBy(0, 400);').catch(() => {});
    await human(500, 1100);
    const list = (await page.evaluate(SCRAPE_NOANSWER_JS).catch(() => [])) as CollectedQuestion[];
    if (Array.isArray(list)) {
      for (const q of list) {
        if (seen.has(q.kinKey)) continue;
        seen.add(q.kinKey);
        scanned++;
        if (!opts.isUsable || opts.isUsable(q)) {
          onStep?.(`${pageNo}페이지에서 질문 선택`);
          // 주소로 점프하지 않고 '목록에서 그 질문을 실제로 클릭'해서 들어간다(사람과 동일).
          const docId = (q.kinKey.split('-').pop() || '').trim();
          if (docId) {
            try {
              const link = page.locator(`#questionAll a[href*="docId=${docId}"]`).first();
              if (await link.count()) {
                await link.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
                await sleep(rnd(300, 800)); // 제목 보고 잠깐 뒤 클릭
                // 지식인 목록의 질문 링크는 '새 창'으로 열린다 → 새 탭을 받아서 이어서 작업
                const [opened] = await Promise.all([
                  ctx.waitForEvent('page', { timeout: 12000 }).catch(() => null),
                  link.click({ timeout: 8000 }),
                ]);
                if (opened) {
                  await opened.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
                  await opened.bringToFront().catch(() => {});
                } else {
                  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
                }
              }
            } catch {
              // 클릭 실패 시엔 pwAnswerQuestion 이 주소로 열어준다
            }
          }
          return { picked: q, scanned, pages: pageNo };
        }
      }
    }
    if (pageNo >= scanPages) break;
    let moved: unknown = false;
    try {
      const num = page.locator('#questionAll a._page').filter({ hasText: new RegExp('^\s*' + (pageNo + 1) + '\s*$') }).first();
      if (await num.count()) {
        await num.click({ timeout: 6000 });
        moved = true;
      } else {
        const next = page.locator('#questionAll a._nextPage, a._nextPage').first();
        if (await next.count()) {
          await next.click({ timeout: 6000 });
          moved = true;
        }
      }
    } catch {
      // 폴백
    }
    if (!moved) moved = await page.evaluate(advancePageJS(pageNo + 1)).catch(() => false);
    if (!moved) break;
    onStep?.(`${pageNo}페이지에 쓸 질문 없음 → 다음 페이지`);
    pageNo++;
    await human(2000, 3200);
  }
  return { scanned, pages: pageNo };
}

const FAQ_CHECK_JS = `(function () {
  const els = document.querySelectorAll('span, em, i, strong, b, a, div');
  for (const e of els) {
    if (e.children.length > 0) continue;
    if ((e.textContent || '').trim() !== 'FAQ') continue;
    const r = e.getBoundingClientRect();
    if (r.top >= 0 && r.top < 500 && r.width > 0 && r.width < 90 && r.height > 0 && r.height < 60) return true;
  }
  return false;
})();`;

const OPEN_EDITOR_JS = `(function () {
  const b = document.querySelector('button._answerWriteButton, .endAnswerButton._answerWriteButton, ._scrollToEditor');
  if (b) { b.click(); return true; }
  return false;
})();`;

const SUBMIT_JS = `(function () {
  const b = document.querySelector('#answerRegisterButton, button._answerRegisterButton');
  if (b) { b.click(); return true; }
  return false;
})();`;

const EDITOR_LEN_JS = `(function () {
  var u = document.querySelector('.se-module-text.__se-unit') || document.querySelector('.se-module-text');
  if (u) return u.classList.contains('se-is-empty') ? 0 : 1;
  var ce = document.querySelector('[contenteditable="true"]');
  if (ce) return (ce.innerText || '').trim().length;
  var ta = document.querySelector('textarea');
  return ta ? (ta.value || '').trim().length : 0;
})();`;

/** 질문 페이지를 열어 답변을 작성하고(필요시) 등록한다. 전부 같은 크롬에서. */
export async function pwAnswerQuestion(
  ctx: BrowserContext,
  url: string,
  answer: string,
  submit: boolean,
  onStep?: (s: string) => void,
): Promise<{ typed: boolean; submitted: boolean; error?: string }> {
  const page = await activePage(ctx);
  try {
    // 목록에서 클릭해 이미 그 질문에 들어와 있으면 다시 주소로 이동하지 않는다.
    const wantDoc = (/docId=(\d+)/.exec(url) || [])[1];
    const alreadyThere = !!wantDoc && page.url().includes(`docId=${wantDoc}`);
    if (alreadyThere) {
      onStep?.('질문 페이지(목록에서 클릭해 진입)');
    } else {
      onStep?.('질문 페이지 여는 중');
      await page.goto(normalizeKinUrl(url), { waitUntil: 'domcontentloaded', timeout: 40000 });
    }
    await human(1800, 3200); // 질문 읽는 시간

    const isFaq = await page.evaluate(FAQ_CHECK_JS).catch(() => false);
    if (isFaq) return { typed: false, submitted: false, error: 'FAQ 질문(권한 필요) — 건너뜀' };

    const already = await page
      .evaluate(`!!document.querySelector('._answerModifyButton, .my_answer')`)
      .catch(() => false);
    if (already) return { typed: false, submitted: false, error: '이미 답변한 질문(건너뜀)' };

    // 로그인이 풀렸으면 명확히 알린다 (엉뚱한 실패로 기록되지 않게)
    if (!(await pwIsLoggedIn(ctx))) {
      return {
        typed: false,
        submitted: false,
        error: '로그인이 풀렸습니다 — 계정·프록시 탭에서 다시 로그인하세요',
      };
    }

    onStep?.('답변 버튼 클릭');
    const opened = await realClick(
      page,
      'button._answerWriteButton, .endAnswerButton._answerWriteButton, ._scrollToEditor',
      OPEN_EDITOR_JS,
    );
    if (!opened) return { typed: false, submitted: false, error: "'답변' 버튼 없음(로그인/페이지 확인)" };
    await human(1200, 2200);

    onStep?.('입력칸 열림 대기');
    let hasEditor = false;
    for (let i = 0; i < 12; i++) {
      hasEditor = (await page.evaluate(HAS_EDITOR_JS).catch(() => false)) as boolean;
      if (hasEditor) break;
      await human(600, 1100);
    }
    if (!hasEditor) return { typed: false, submitted: false, error: '답변 입력칸이 열리지 않음' };
    await human(900, 1800);

    onStep?.('본문 입력 중');
    const box = page
      .locator('.se-section-text, .se-module-text, div[contenteditable="true"], textarea')
      .first();
    try {
      await box.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
      await box.click({ timeout: 8000 });
    } catch {
      return { typed: false, submitted: false, error: '답변 입력칸을 클릭하지 못함' };
    }
    await human(400, 900);

    // 사람처럼 한 글자씩 (문장부호에서 가끔 쉼)
    const NL = String.fromCharCode(10);
    for (const ch of answer) {
      if (ch === NL) {
        await page.keyboard.press('Enter');
        await sleep(rnd(80, 200));
        continue;
      }
      await page.keyboard.type(ch, { delay: rnd(18, 65) });
      if (/[.,!?~\s]/.test(ch) && Math.random() < 0.12) await sleep(rnd(120, 320));
    }
    await human(600, 1200);

    const len = (await page.evaluate(EDITOR_LEN_JS).catch(() => 0)) as number;
    if (!len) return { typed: false, submitted: false, error: '답변이 입력창에 들어가지 않음' };
    if (!submit) return { typed: true, submitted: false };

    await human(1200, 2400);
    onStep?.('등록 버튼 클릭');
    const submitted = await realClick(page, '#answerRegisterButton, button._answerRegisterButton', SUBMIT_JS);
    if (!submitted) return { typed: true, submitted: false, error: "'등록' 버튼을 찾지 못함" };
    await human(1800, 3000);
    await closeExtraTabs(ctx).catch(() => {});
    return { typed: true, submitted: true };
  } catch (e) {
    return { typed: false, submitted: false, error: e instanceof Error ? e.message : String(e) };
  }
}
