// 질문 작업은 로그인과 동일한 Chrome 프로필 및 컨텍스트 관리자를 사용한다.
// 이 구조가 네이버 보호조치의 원인이나 해소 여부를 입증하는 것은 아니다.

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
export { getAccountContext, closeAccountContext, closeAllKinContexts } from './pwlogin';
import { readAuthState, requireAuthenticated, waitForAuth, assertWarmupAuth, AUTH_STOP } from './session-auth';

const rnd = (a: number, b: number) => a + Math.floor(Math.random() * (b - a));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const human = (min = 600, max = 1600) => sleep(rnd(min, max));

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
  return (await readAuthState(ctx, await activePage(ctx))) === 'authenticated';
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
  await requireAuthenticated(ctx, page);
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
    await requireAuthenticated(ctx, page);
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

    // 로그인이 풀렸으면 '그 순간의 상태'를 그대로 남긴다.
    // (무엇이 세션을 끊었는지 알아야 원인을 특정할 수 있다 — 추측 금지)
    await requireAuthenticated(ctx, page);

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
    let nextAuthCheck = 0;
    for (const ch of answer) {
      if (Date.now() >= nextAuthCheck) {
        await requireAuthenticated(ctx, page);
        nextAuthCheck = Date.now() + 2000;
      }
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
    await requireAuthenticated(ctx, page);
    onStep?.('등록 버튼 클릭');
    const submitted = await realClick(page, '#answerRegisterButton, button._answerRegisterButton', SUBMIT_JS);
    if (!submitted) return { typed: true, submitted: false, error: "'등록' 버튼을 찾지 못함" };
    await human(1800, 3000);
    await requireAuthenticated(ctx, page);
    await closeExtraTabs(ctx).catch(() => {});
    return { typed: true, submitted: true };
  } catch (e) {
    return { typed: false, submitted: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 이 계정의 '크롬 창이 실제로' 어떤 IP로 나가는지 확인한다.
 * ★ 옵션에 프록시를 넣는 것과, 브라우저가 정말 그 IP로 나가는 건 다른 문제다.
 *   여기서 프록시 IP가 아닌 값이 나오면 계정이 VM 실제 IP로 접속 중이라는 뜻.
 */
export async function pwCheckBrowserExitIp(ctx: BrowserContext): Promise<string | null> {
  try {
    const p = await ctx.newPage();
    try {
      await p.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 20000 });
      const txt = await p.evaluate('document.body ? document.body.innerText : ""');
      const m = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(String(txt));
      return m ? m[1] : null;
    } finally {
      await p.close().catch(() => {});
    }
  } catch {
    return null;
  }
}

// 명백한 정지/보호조치 문구만 잡는다 (오탐 최소화 — 약관·공지의 단순 언급은 제외).
// 카페포스터에서 검증된 패턴을 그대로 사용.
const SUSPEND_RE =
  /보호\s*(\([^)]{0,8}\))?\s*조치|영구\s*정지|강제\s*탈퇴|아이디\s*잠금|활동(이|을)?\s*(정지|제한)\s*(되|됩|된|중)|이용(이|을)?\s*(정지|제한)\s*(되|됩|된|중)|이용이\s*제한된\s*회원|운영(원칙|정책)\s*위반|회원\s*자격\s*(정지|박탈)/;

/**
 * 지금 화면에 '보호조치/정지' 문구가 있으면 그 문맥을 돌려준다.
 * ★ 잠긴 계정으로 계속 시도하면 상황이 더 나빠지므로, 감지되면 즉시 그 계정을 멈춰야 한다.
 */
export async function pwDetectSuspension(ctx: BrowserContext): Promise<string | null> {
  try {
    const page = await activePage(ctx);
    for (const f of page.frames()) {
      try {
        const text = (await f.evaluate(
          '(document.body ? (document.body.innerText || "") : "").slice(0, 6000)',
        )) as string;
        if (!text) continue;
        const m = SUSPEND_RE.exec(text);
        if (m) {
          const idx = text.indexOf(m[0]);
          const around = text
            .slice(Math.max(0, idx - 25), idx + 70)
            .replace(/\s+/g, ' ')
            .trim();
          return around || m[0];
        }
      } catch {
        /* 프레임 접근 불가 — 무시 */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 질문 탭이 아직 열려 있지 않으면 연다. 이미 그 질문이면 아무것도 안 한다. */
export async function pwOpenQuestion(ctx: BrowserContext, url: string): Promise<void> {
  const page = await activePage(ctx);
  const want = (/docId=(\d+)/.exec(url) || [])[1];
  if (want && page.url().includes(`docId=${want}`)) return;
  await page.goto(normalizeKinUrl(url), { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  await human(1200, 2200);
}

/**
 * 이미 열려 있는 질문 탭에서 제목·본문을 읽는다.
 * ★ 별도 네트워크 요청을 만들지 않는다 — 같은 IP에서 브라우저와 다른 UA/TLS 지문의 요청이
 *   섞이면 그 자체가 흔적이다. 사람이 열어둔 페이지를 읽는 것과 동일.
 */
export async function pwReadOpenQuestion(ctx: BrowserContext): Promise<{ title?: string; body?: string }> {
  try {
    const page = await activePage(ctx);
    const r = (await page.evaluate(`(function () {
      var m = function (sel) { var e = document.querySelector(sel); return e ? (e.getAttribute('content') || '') : ''; };
      var title = m('meta[property="og:title"]') || document.title || '';
      var cands = [m('meta[name="description"]'), m('meta[property="og:description"]')].filter(Boolean);
      var body = cands.sort(function (a, b) { return b.length - a.length; })[0] || '';
      return { title: title.trim(), body: body.trim() };
    })()`)) as { title: string; body: string };
    return { title: r.title || undefined, body: r.body || undefined };
  } catch {
    return {};
  }
}

export interface FingerprintDiag {
  proxyIp: string;
  ua: string; platform: string; cores: number | null; memory: number | null;
  screen: string; timezone: string; languages: string;
  webglVendor: string; webglRenderer: string; canvasHash: string;
  webrtcIps: string[]; leakedPublicIps: string[]; webrtcLeak: boolean;
  /** 렌더러 문자열이 VM/소프트웨어 GPU 처럼 보이는가 (SwiftShader, Basic Render Driver, VMware 등) */
  vmLike: boolean;
  /** 계정 간 비교용 요약 해시 — 계정마다 달라야 한다 */
  fingerprintHash: string;
}

/**
 * 이 계정의 '실제 크롬'이 네이버에 보여주는 기기 지문을 측정한다 (읽기 전용, 위장 없음).
 * 카페포스터 diagnostic:fingerprint 와 동일한 측정. GPU/캔버스는 위장 대상이 아니라 확인 대상.
 */
export async function pwFingerprintDiag(ctx: BrowserContext): Promise<FingerprintDiag> {
  const page = await ctx.newPage();
  try {
    let proxyIp = '';
    try {
      await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 20000 });
      const txt = String(await page.evaluate('document.body ? document.body.innerText : ""')).trim();
      try { proxyIp = JSON.parse(txt).ip; } catch { proxyIp = txt; }
    } catch { /* ignore */ }

    const fp = (await page.evaluate(`(async function () {
      var nav = navigator, scr = screen;
      var canvasHash = '';
      try {
        var c = document.createElement('canvas'); var g = c.getContext('2d');
        g.textBaseline = 'top'; g.font = "14px 'Arial'";
        g.fillStyle = '#f60'; g.fillRect(10, 1, 60, 20);
        g.fillStyle = '#069'; g.fillText('kin-fp-9620', 2, 15);
        var data = c.toDataURL(); var h = 0;
        for (var i = 0; i < data.length; i++) { h = (h * 31 + data.charCodeAt(i)) | 0; }
        canvasHash = (h >>> 0).toString(16);
      } catch (e) {}
      var webglVendor = '', webglRenderer = '';
      try {
        var gc = document.createElement('canvas');
        var gl = gc.getContext('webgl') || gc.getContext('experimental-webgl');
        if (gl) {
          var dbg = gl.getExtension('WEBGL_debug_renderer_info');
          webglVendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
          webglRenderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        }
      } catch (e) {}
      var webrtcIps = await new Promise(function (resolve) {
        var found = new Set(); var pc = null;
        try {
          pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
          pc.createDataChannel('d');
          pc.onicecandidate = function (e) {
            if (!e || !e.candidate) return;
            var cand = String(e.candidate.candidate || '');
            var m = cand.match(/([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/);
            if (m && !/\.local/i.test(cand)) found.add(m[1]);
          };
          pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function () {});
        } catch (e) {}
        setTimeout(function () { try { pc && pc.close(); } catch (e) {} resolve(Array.from(found)); }, 3500);
      });
      return {
        ua: nav.userAgent, platform: nav.platform,
        cores: nav.hardwareConcurrency == null ? null : nav.hardwareConcurrency,
        memory: nav.deviceMemory == null ? null : nav.deviceMemory,
        screen: scr.width + 'x' + scr.height + 'x' + scr.colorDepth,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        languages: (nav.languages || []).join(','),
        webglVendor: String(webglVendor || ''), webglRenderer: String(webglRenderer || ''),
        canvasHash: canvasHash, webrtcIps: webrtcIps,
      };
    })()`)) as Omit<FingerprintDiag, 'proxyIp' | 'leakedPublicIps' | 'webrtcLeak' | 'vmLike' | 'fingerprintHash'>;

    const isPublic = (ip: string) =>
      !!ip && !/^10\./.test(ip) && !/^192\.168\./.test(ip) &&
      !/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip) && !/^169\.254\./.test(ip) && !/^127\./.test(ip);
    const leakedPublicIps = (fp.webrtcIps || []).filter((ip) => isPublic(ip) && ip !== proxyIp);
    const vmLike = /swiftshader|basic render|vmware|virtualbox|llvmpipe|mesa|parallels|hyper-v|virtio|qxl|remotefx/i
      .test(fp.webglRenderer + ' ' + fp.webglVendor);
    const fpString = [fp.ua, fp.platform, fp.cores, fp.memory, fp.screen, fp.timezone, fp.languages, fp.webglRenderer, fp.canvasHash].join('|');
    let fh = 0;
    for (let i = 0; i < fpString.length; i++) fh = (fh * 31 + fpString.charCodeAt(i)) | 0;
    return { proxyIp, ...fp, leakedPublicIps, webrtcLeak: leakedPublicIps.length > 0, vmLike, fingerprintHash: (fh >>> 0).toString(16) };
  } finally {
    await page.close().catch(() => {});
  }
}


/** 워밍업 세션 유형 — 사람이 지식인에 들르는 세 가지 결 */
export type WarmupKind = 'skim' | 'read' | 'search';

/** 이번 세션을 어떤 결로 할지 뽑는다 (키워드가 없으면 검색형은 제외) */
export function pickWarmupKind(hasKeyword: boolean): WarmupKind {
  const r = Math.random();
  if (r < 0.35) return 'skim';
  if (r < 0.8 || !hasKeyword) return 'read';
  return 'search';
}

/** 한 질문을 '읽는' 동작 — 글 길이에 맞춰 체류 시간을 정한다 (짧은 글은 빨리 나간다) */
async function dwellOnQuestion(page: Page, check: (page: Page) => Promise<void>): Promise<void> {
  const chars = (await page
    .evaluate('(document.body && document.body.innerText || "").length')
    .catch(() => 900)) as number;
  // 한국어 묵독 대략 초당 8~14자 + 딴짓. 최소 6초, 최대 100초.
  const speed = 8 + Math.random() * 6;
  const total = Math.max(6000, Math.min(100000, (Number(chars) || 900) / speed * 1000));
  const steps = rnd(2, 7);
  for (let i = 0; i < steps; i++) {
    await check(page);
    await page.mouse.wheel(0, rnd(180, 620)).catch(() => {});
    await sleep(Math.round((total / steps) * (0.6 + Math.random() * 0.8)));
  }
  // 다 읽고 잠깐 멈칫 (가끔 위로 다시 올려본다)
  if (Math.random() < 0.35) {
    await check(page);
    await page.mouse.wheel(0, -rnd(200, 700)).catch(() => {});
    await human(1500, 5000);
  }
  await human(2000, 9000);
}

/** 목록에서 질문 하나를 실제로 클릭해 새 탭에서 읽고 닫는다 */
async function readOneFromList(ctx: BrowserContext, page: Page, topN: number, check: (page: Page) => Promise<void>): Promise<boolean> {
  await check(page);
  const links = page.locator('#questionAll a[href*="docId="]');
  const count = await links.count().catch(() => 0);
  if (!count) return false;
  const link = links.nth(rnd(0, Math.min(count, topN)));
  await link.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await human(700, 2400); // 제목 읽고
  const [tab] = await Promise.all([
    ctx.waitForEvent('page', { timeout: 12000 }).catch(() => null),
    link.click({ timeout: 8000 }).catch(() => {}),
  ]);
  const q = tab || page;
  await q.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await check(q);
  await dwellOnQuestion(q, check);
  await check(q);
  if (tab) {
    await tab.close().catch(() => {});
    await human(1500, 6000);
  }
  return true;
}

/**
 * 워밍업 세션 — 로그인한 그 크롬으로 사람처럼 지식인을 '읽기만' 한다. 답변은 절대 하지 않는다.
 * 읽기 동작을 예약 실행한다. 보호조치 예방 효과는 확인되지 않았다.
 *
 * 세션마다 결이 달라진다:
 *   skim   — 목록만 훑고 나감 (질문 0~1개, 짧게)
 *   read   — 질문 2~4개를 깊게 읽음
 *   search — 키워드로 검색해 보고 1~3개 읽음
 * 스크롤은 진짜 마우스 휠, 질문은 목록에서 진짜 클릭(새 탭), 체류는 글 길이에 비례.
 */
export async function runWarmupSession(
  ctx: BrowserContext,
  onStep?: (s: string) => void,
  opts?: { keywords?: string[] },
): Promise<{ opened: number; kind: WarmupKind; suspended: string | null }> {
  const page = await firstPage(ctx);
  const keywords = (opts?.keywords || []).filter(Boolean);
  const kind = pickWarmupKind(keywords.length > 0);
  let opened = 0;
  // Establish state on a real page, never classify a new about:blank tab as signed out.
  await page.goto('https://www.naver.com/', { waitUntil: 'domcontentloaded', timeout: 40000 });
  const initial = await waitForAuth(ctx, page, 8000);
  const check = async (target: Page) => {
    if (await pwDetectSuspension(ctx)) throw new Error(AUTH_STOP + ' 보호조치 의심 화면 — 워밍업 중단');
    const current = await waitForAuth(ctx, target, 1500);
    assertWarmupAuth(current, initial);
  };
  assertWarmupAuth(initial);
  await check(page);

  // 가끔은 네이버 메인부터 들어온다 (사람은 늘 지식인 주소를 바로 치지 않는다)
  if (Math.random() < 0.45) {
    onStep?.('네이버 메인 둘러보기');
    await page.goto('https://www.naver.com/', { waitUntil: 'domcontentloaded', timeout: 40000 });
    await check(page);
    await human(2500, 9000);
    for (let i = 0, n = rnd(1, 4); i < n; i++) {
      await check(page);
      await page.mouse.wheel(0, rnd(250, 950)).catch(() => {});
      await human(1500, 6000);
    }
  }

  onStep?.(kind === 'search' ? '지식인에서 검색해 보기' : '지식인 답변대기 목록 둘러보기');
  await page.goto(QUESTION_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await check(page);
  await human(2000, 5500);
  await check(page);
  await realClick(page, '#contentsOfMain', ACTIVATE_TAB_JS);
  await human(1500, 4000);

  // 검색형: 관심 키워드를 사람처럼 한 글자씩 쳐서 찾아본다
  await check(page);
  if (kind === 'search') {
    const kw = keywords[rnd(0, keywords.length)];
    onStep?.(`'${kw}' 검색해 보는 중`);
    let typed = false;
    try {
      const input = page.locator('#questionAll input._search_input').first();
      if (await input.count()) {
        await input.click({ timeout: 6000 });
        await sleep(rnd(250, 900));
        await input.fill('');
        await page.keyboard.type(kw, { delay: rnd(70, 190) });
        await sleep(rnd(300, 1200));
        typed = true;
      }
    } catch {
      // 아래 JS 폴백
    }
    await check(page);
    if (typed) {
      const searched = await realClick(page, '#questionAll a._search_button');
      if (!searched) await page.keyboard.press('Enter').catch(() => {});
    } else {
      await page.evaluate(searchInPageJS(kw)).catch(() => {});
    }
    await human(2500, 5000);
  }

  // 목록 훑기 — 유형마다 훑는 양이 다르다
  const scrolls = kind === 'skim' ? rnd(3, 9) : rnd(2, 5);
  for (let i = 0; i < scrolls; i++) {
    await check(page);
    await page.mouse.wheel(0, rnd(220, 780)).catch(() => {});
    await human(2000, 8000);
    // 훑다가 가끔 위로 되돌아간다
    if (Math.random() < 0.2) {
      await check(page);
      await page.mouse.wheel(0, -rnd(150, 500)).catch(() => {});
      await human(1200, 4000);
    }
  }

  // 질문 열어 읽기 — 유형별 개수
  const toRead = kind === 'skim' ? rnd(0, 2) : kind === 'search' ? rnd(1, 4) : rnd(2, 5);
  for (let i = 0; i < toRead; i++) {
    onStep?.(`질문 읽는 중 (${i + 1}/${toRead})`);
    const ok = await readOneFromList(ctx, page, kind === 'search' ? 8 : 12, check);
    if (!ok) break;
    opened++;
  }

  // 가끔 다음 페이지도 넘겨본다 (훑기형이 더 자주)
  if (Math.random() < (kind === 'skim' ? 0.5 : 0.25)) {
    await check(page);
    await realClick(page, '#questionAll a._nextPage, a._nextPage');
    await human(2500, 9000);
    if (Math.random() < 0.5) {
      await check(page);
      await page.mouse.wheel(0, rnd(250, 800)).catch(() => {});
      await human(2000, 7000);
    }
  }

  await check(page);
  const suspended = await pwDetectSuspension(ctx);
  return { opened, kind, suspended };
}
