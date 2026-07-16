import { BrowserWindow, session, clipboard, app } from 'electron';

/**
 * 네이버 지식인 자동화 레이어.
 *
 * 원칙(사람처럼):
 *  - 로그인은 사람이 직접. 앱은 계정별 세션(파티션)에 프록시만 연결해 창을 열어줌.
 *    → 비밀번호 자동입력 없음. 최초 1회 사람이 로그인하면 세션이 유지됨.
 *  - 질문 수집은 숨김 창으로 목록 페이지를 실제 렌더링해 카드에서 추출.
 *  - 등록은 계정 세션 창을 띄워 사람이 확인/제출. (모드에 따라 채우기/제출 자동화)
 *
 * 선택자(selector)는 실제 페이지 구조에 맞춰 조정이 필요할 수 있음.
 */

export interface AccountProxy {
  id: number;
  naverId: string;
  proxyHost?: string | null;
  proxyPort?: string | null;
  proxyUser?: string | null;
  proxyPass?: string | null;
}

const QUESTION_LIST_URL = 'https://kin.naver.com/qna/questionList.naver';

// 네이버에 "일반 크롬"으로 보이도록 위장하는 User-Agent (Electron/앱 흔적 제거)
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 계정별 프록시 인증 정보 (login 이벤트에서 사용)
const proxyCredById = new Map<number, { user: string; pass: string }>();

app.on('login', (event, _webContents, _request, authInfo, callback) => {
  if (authInfo.isProxy) {
    // 현재 활성 계정들의 프록시 인증을 시도 (가장 최근 것 우선)
    for (const cred of proxyCredById.values()) {
      if (cred.user) {
        event.preventDefault();
        callback(cred.user, cred.pass);
        return;
      }
    }
  }
});

/** 계정 전용 세션(파티션) 확보 + 프록시 연결 */
async function getAccountSession(acc: AccountProxy) {
  const part = `persist:kin-acc-${acc.id}`;
  const ses = session.fromPartition(part);

  if (acc.proxyHost && acc.proxyPort) {
    const rule = `${acc.proxyHost}:${acc.proxyPort}`;
    await ses.setProxy({ proxyRules: `http=${rule};https=${rule}` });
    if (acc.proxyUser) {
      proxyCredById.set(acc.id, { user: acc.proxyUser, pass: acc.proxyPass || '' });
    }
  } else {
    await ses.setProxy({ proxyRules: 'direct://' });
  }
  ses.setUserAgent(CHROME_UA); // 크롬으로 위장
  return ses;
}

function humanDelay(min = 600, max = 1600): Promise<void> {
  // 사람처럼: 고정값 대신 범위 내 대기
  const ms = min + Math.floor((max - min) * Math.abs(Math.sin(Date.now() / 1000)));
  return new Promise((r) => setTimeout(r, ms));
}

export interface CollectedQuestion {
  kinKey: string;
  title: string;
  url: string;
  content: string;
  category: string;
}

/**
 * 답변 대기 질문 목록 수집.
 * keyword가 있으면 지식인 검색 결과(답변 대기)에서, 없으면 전체 대기 목록에서 수집.
 * account가 있으면 해당 세션/프록시로, 없으면 기본 세션으로 수집(로그인 불필요).
 */
export async function collectQuestions(opts: {
  keyword?: string;
  account?: AccountProxy;
}): Promise<CollectedQuestion[]> {
  const ses = opts.account
    ? await getAccountSession(opts.account)
    : session.fromPartition('persist:kin-collect');
  if (!opts.account) ses.setUserAgent(CHROME_UA); // 수집 세션도 크롬으로 위장

  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: { session: ses, offscreen: false },
  });

  try {
    // 키워드가 있으면 "해당 태그의 답변 대기 질문" 목록(서버 렌더링, 미답변만),
    // 없으면 전체 답변 대기 목록(JS 렌더링).
    const url = opts.keyword
      ? `https://kin.naver.com/tag/tagDetail.naver?tag=${encodeURIComponent(
          opts.keyword,
        )}&listType=answer`
      : QUESTION_LIST_URL;

    await win.loadURL(url);
    await humanDelay(900, 1800);

    // 사람처럼: 목록을 잠깐 스크롤 (JS 렌더 목록이 채워지도록)
    await win.webContents.executeJavaScript('window.scrollBy(0, 600);').catch(() => {});
    await humanDelay(600, 1300);

    // 실측 구조: li.lst > div.tit > a (제목/링크), a.cont (본문 스니펫).
    // detail 링크는 /qna/detail.naver?d1id=&dirId=&docId= 형태.
    const script = `
      (function () {
        const out = [];
        const seen = new Set();
        const keyOf = (href) => {
          const m = href.match(/dirId=(\\d+)[\\s\\S]*?docId=(\\d+)/) || href.match(/docId=(\\d+)/);
          return m ? m.slice(1).join('-') : href;
        };
        // 1순위: 실제 목록 항목(li.lst)
        let items = Array.from(document.querySelectorAll('li.lst'));
        for (const li of items) {
          const titleA = li.querySelector('div.tit a, a.txt');
          if (!titleA) continue;
          const href = titleA.href || '';
          if (!/detail\\.naver/.test(href) || !/docId=/.test(href)) continue;
          const key = keyOf(href);
          if (seen.has(key)) continue;
          const title = (titleA.textContent || '').replace(/\\s+/g, ' ').trim();
          if (!title || title.length < 4) continue;
          const contA = li.querySelector('a.cont');
          const content = contA ? (contA.textContent || '').replace(/\\s+/g, ' ').trim() : '';
          seen.add(key);
          out.push({ kinKey: key, title: title, url: href, content: content, category: '' });
          if (out.length >= 40) break;
        }
        // 2순위(폴백): li.lst가 없으면 detail 앵커 전체에서 추출
        if (out.length === 0) {
          const anchors = Array.from(document.querySelectorAll('a[href*="detail.naver"]'));
          for (const a of anchors) {
            const href = a.href || '';
            if (!/docId=/.test(href)) continue;
            const key = keyOf(href);
            if (seen.has(key)) continue;
            const title = (a.textContent || '').replace(/\\s+/g, ' ').trim();
            if (!title || title.length < 4) continue;
            seen.add(key);
            out.push({ kinKey: key, title: title, url: href, content: '', category: '' });
            if (out.length >= 40) break;
          }
        }
        return out;
      })();
    `;
    const result = (await win.webContents.executeJavaScript(script)) as CollectedQuestion[];
    return Array.isArray(result) ? result : [];
  } finally {
    win.destroy();
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * 질문 상세 페이지에서 제목/본문 전체를 가져온다.
 * 메타 태그(og:title, description)를 사용 — DOM 변화에 강하고 로그인 불필요.
 */
export async function fetchQuestionDetail(
  url: string,
): Promise<{ title?: string; body?: string }> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      },
    });
    if (!res.ok) return {};
    const html = await res.text();
    const titleM = /property="og:title"\s+content="([^"]*)"/i.exec(html);
    const bodyM = /name="description"\s+content="([^"]*)"/i.exec(html);
    return {
      title: titleM ? decodeEntities(titleM[1]).trim() : undefined,
      body: bodyM ? decodeEntities(bodyM[1]).trim() : undefined,
    };
  } catch {
    return {};
  }
}

export type PostMode = 'manual' | 'semi' | 'auto';

export interface PostResult {
  ok: boolean;
  error?: string;
  needsHuman?: boolean; // 사람이 창에서 마무리해야 함
}

/**
 * 답변 등록 창 열기.
 *  - manual: 질문 페이지를 열고 답변을 클립보드에 복사 → 사람이 붙여넣고 등록
 *  - semi:  답변 에디터에 본문을 자동 입력 → 등록 버튼은 사람이 클릭
 *  - auto:  본문 입력 후 등록까지 시도 (리스크 큼)
 * 어느 경우든 로그인은 사람이 미리 해둔 세션을 사용.
 */
export async function openAnswerWindow(opts: {
  account: AccountProxy;
  question: { url: string; title: string };
  answer: string;
  mode: PostMode;
}): Promise<PostResult> {
  const ses = await getAccountSession(opts.account);

  // 답변은 항상 클립보드에도 복사 (사람이 언제든 붙여넣기 가능)
  clipboard.writeText(opts.answer);

  const win = new BrowserWindow({
    show: true,
    width: 1200,
    height: 900,
    title: `답변 작성 · ${opts.account.naverId}`,
    webPreferences: { session: ses },
  });

  try {
    await win.loadURL(opts.question.url);
    await humanDelay(1000, 2000);

    if (opts.mode === 'manual') {
      // 사람이 직접. 답변은 클립보드에 있음.
      return { ok: true, needsHuman: true };
    }

    // 답변칸(에디터)이 나타날 때까지 대기.
    // 주의: 상단 메뉴 "답변하기"를 클릭하면 질문 선택 화면으로 이동해버리므로 절대 클릭하지 않는다.
    // 로그인된 상세 페이지에는 답변 에디터가 인라인으로 이미 있으므로 기다리기만 하면 됨.
    const hasEditorScript = `
      (function () {
        if (document.querySelector('[contenteditable="true"], textarea')) return true;
        for (const f of document.querySelectorAll('iframe')) {
          try { const d = f.contentDocument; if (d && (d.querySelector('[contenteditable="true"]') || (d.body && d.body.isContentEditable))) return true; } catch (e) {}
        }
        return false;
      })();
    `;
    let hasEditor = false;
    for (let i = 0; i < 8; i++) {
      hasEditor = await win.webContents.executeJavaScript(hasEditorScript).catch(() => false);
      if (hasEditor) break;
      await humanDelay(600, 1100);
    }
    if (!hasEditor) {
      return {
        ok: true,
        needsHuman: true,
        error: '답변 입력칸을 찾지 못했습니다(로그인 여부 확인). 클립보드에 답변을 복사해 두었으니 직접 붙여넣어 주세요.',
      };
    }
    // 답변 쓰기 전, 사람처럼 잠깐 읽는 시간
    await humanDelay(1500, 3000);

    // semi/auto: 에디터에 본문을 "사람처럼 한 글자씩" 입력.
    // 지식인 답변칸 = iframe 내부 body[contenteditable] (SmartEditor).
    // 한 번에 붙여넣지 않고, 랜덤 간격으로 타이핑하며 중간중간 생각하는 듯 쉼.
    const injected = await win.webContents
      .executeJavaScript(
        `
        (async function () {
          const text = ${JSON.stringify(opts.answer)};
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const rnd = (a, b) => a + Math.floor(Math.random() * (b - a));

          // 에디터 찾기: 최상위 CE → iframe 내부 CE → textarea
          let ce = document.querySelector('[contenteditable="true"]');
          let doc = document;
          if (!ce) {
            for (const f of document.querySelectorAll('iframe')) {
              try {
                const d = f.contentDocument;
                if (!d) continue;
                const ice = d.querySelector('[contenteditable="true"]') || (d.body && d.body.isContentEditable ? d.body : null);
                if (ice) { ce = ice; doc = d; break; }
              } catch (e) {}
            }
          }
          let ta = null;
          if (!ce) { ta = document.querySelector('textarea'); }
          if (!ce && !ta) return false;

          // 사람처럼 한 글자씩 타이핑
          const typeHuman = async (insertChar, insertNewline) => {
            let i = 0;
            for (const ch of text) {
              if (ch === '\\n') insertNewline();
              else insertChar(ch);
              i++;
              // 기본 타이핑 간격
              await sleep(rnd(18, 75));
              // 공백/문장부호 뒤 가끔 살짝 멈칫
              if (/[\\s.,!?~]/.test(ch) && Math.random() < 0.15) await sleep(rnd(120, 340));
              // 가끔(문장 길이쯤) 생각하는 듯 쉼
              if (i % rnd(35, 60) === 0) await sleep(rnd(300, 900));
            }
          };

          if (ce) {
            ce.focus();
            // 기존 내용 비우기
            try { doc.execCommand('selectAll', false, null); doc.execCommand('delete', false, null); } catch (e) {}
            const insertChar = (c) => { try { doc.execCommand('insertText', false, c); } catch (e) {} ce.dispatchEvent(new Event('input', { bubbles: true })); };
            const insertNewline = () => { try { doc.execCommand('insertParagraph', false, null); } catch (e) { try { doc.execCommand('insertText', false, '\\n'); } catch (e2) {} } ce.dispatchEvent(new Event('input', { bubbles: true })); };
            await typeHuman(insertChar, insertNewline);
            // 타이핑이 전혀 안 먹었으면(빈 상태) innerHTML 폴백
            if ((ce.textContent || '').trim().length === 0) {
              const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
              ce.innerHTML = text.split('\\n').map((l) => '<p>' + (l ? esc(l) : '<br>') + '</p>').join('');
              ce.dispatchEvent(new Event('input', { bubbles: true }));
            }
            return 'typed-ce';
          }

          // textarea 폴백: 값에 한 글자씩 추가
          ta.focus();
          ta.value = '';
          const insertChar = (c) => { ta.value += c; ta.dispatchEvent(new Event('input', { bubbles: true })); };
          const insertNewline = () => { ta.value += '\\n'; ta.dispatchEvent(new Event('input', { bubbles: true })); };
          await typeHuman(insertChar, insertNewline);
          return 'typed-textarea';
        })();
      `,
      )
      .catch(() => false);

    if (!injected) {
      // 자동 주입 실패 → 사람이 클립보드로 처리
      return { ok: true, needsHuman: true, error: '에디터를 찾지 못해 자동 입력에 실패했습니다. 클립보드에 답변을 복사해 두었으니 붙여넣어 주세요.' };
    }

    if (opts.mode === 'auto') {
      await humanDelay(900, 1800);
      // "등록" 버튼 클릭 (임시저장 '저장'은 제외, 정확히 등록 계열만).
      const submitted = await win.webContents
        .executeJavaScript(
          `
          (function () {
            const els = Array.from(document.querySelectorAll('button, a, input[type=button], input[type=submit]'));
            const b = els.find((el) => {
              const t = (el.innerText || el.value || '').trim();
              return t === '등록' || /^답변\\s*등록$/.test(t);
            });
            if (b) { b.click(); return true; }
            return false;
          })();
        `,
        )
        .catch(() => false);
      if (!submitted) return { ok: true, needsHuman: true };
      return { ok: true, needsHuman: false };
    }

    // semi: 입력만, 사람이 등록
    return { ok: true, needsHuman: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

/** 계정 로그인용 창 (사람이 직접 로그인) */
export async function openLoginWindow(acc: AccountProxy): Promise<void> {
  const ses = await getAccountSession(acc);
  const win = new BrowserWindow({
    show: true,
    width: 980,
    height: 760,
    title: `네이버 로그인 · ${acc.naverId}`,
    webPreferences: { session: ses },
  });
  await win.loadURL('https://nid.naver.com/nidlogin.login');
}

// ==================== 완전자동 (Autopilot) 브라우저 헬퍼 ====================

const HAS_EDITOR_JS = `
  (function () {
    if (document.querySelector('[contenteditable="true"], textarea')) return true;
    for (const f of document.querySelectorAll('iframe')) {
      try { const d = f.contentDocument; if (d && (d.querySelector('[contenteditable="true"]') || (d.body && d.body.isContentEditable))) return true; } catch (e) {}
    }
    return false;
  })();
`;

const SUBMIT_JS = `
  (function () {
    const els = Array.from(document.querySelectorAll('button, a, input[type=button], input[type=submit]'));
    const b = els.find((el) => { const t = (el.innerText || el.value || '').trim(); return t === '등록' || /^답변\\s*등록$/.test(t); });
    if (b) { b.click(); return true; }
    return false;
  })();
`;

// 사람처럼 한 글자씩 타이핑하는 주입 스크립트
function typeJS(answer: string): string {
  return `
    (async function () {
      const text = ${JSON.stringify(answer)};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const rnd = (a, b) => a + Math.floor(Math.random() * (b - a));
      let ce = document.querySelector('[contenteditable="true"]');
      let doc = document;
      if (!ce) {
        for (const f of document.querySelectorAll('iframe')) {
          try { const d = f.contentDocument; if (!d) continue; const ice = d.querySelector('[contenteditable="true"]') || (d.body && d.body.isContentEditable ? d.body : null); if (ice) { ce = ice; doc = d; break; } } catch (e) {}
        }
      }
      let ta = null; if (!ce) { ta = document.querySelector('textarea'); }
      if (!ce && !ta) return false;
      const typeHuman = async (insertChar, insertNewline) => {
        let i = 0;
        for (const ch of text) {
          if (ch === '\\n') insertNewline(); else insertChar(ch);
          i++;
          await sleep(rnd(18, 75));
          if (/[\\s.,!?~]/.test(ch) && Math.random() < 0.15) await sleep(rnd(120, 340));
          if (i % rnd(35, 60) === 0) await sleep(rnd(300, 900));
        }
      };
      if (ce) {
        ce.focus();
        try { doc.execCommand('selectAll', false, null); doc.execCommand('delete', false, null); } catch (e) {}
        const insertChar = (c) => { try { doc.execCommand('insertText', false, c); } catch (e) {} ce.dispatchEvent(new Event('input', { bubbles: true })); };
        const insertNewline = () => { try { doc.execCommand('insertParagraph', false, null); } catch (e) { try { doc.execCommand('insertText', false, '\\n'); } catch (e2) {} } ce.dispatchEvent(new Event('input', { bubbles: true })); };
        await typeHuman(insertChar, insertNewline);
        if ((ce.textContent || '').trim().length === 0) {
          const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          ce.innerHTML = text.split('\\n').map((l) => '<p>' + (l ? esc(l) : '<br>') + '</p>').join('');
          ce.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      }
      ta.focus(); ta.value = '';
      const insertChar = (c) => { ta.value += c; ta.dispatchEvent(new Event('input', { bubbles: true })); };
      const insertNewline = () => { ta.value += '\\n'; ta.dispatchEvent(new Event('input', { bubbles: true })); };
      await typeHuman(insertChar, insertNewline);
      return true;
    })();
  `;
}

/** 완전자동용 브라우저 창 (계정 세션·프록시·크롬 UA) */
export async function openAutoWindow(acc: AccountProxy): Promise<BrowserWindow> {
  const ses = await getAccountSession(acc);
  return new BrowserWindow({
    show: true,
    width: 1240,
    height: 920,
    title: `완전자동 · ${acc.naverId}`,
    webPreferences: { session: ses },
  });
}

/** 목록(키워드→tagDetail, 없으면 kinupList) 열고 사람처럼 스크롤 후 질문 추출 */
export async function autoScrapeList(
  win: BrowserWindow,
  keyword?: string,
): Promise<CollectedQuestion[]> {
  const url = keyword
    ? `https://kin.naver.com/tag/tagDetail.naver?tag=${encodeURIComponent(keyword)}&listType=answer`
    : 'https://kin.naver.com/qna/kinupList.naver';
  await win.loadURL(url);
  await humanDelay(1200, 2400);
  for (let i = 0; i < 2; i++) {
    await win.webContents
      .executeJavaScript(`window.scrollBy(0, ${300 + Math.floor(Math.random() * 400)});`)
      .catch(() => {});
    await humanDelay(600, 1400);
  }
  const script = `
    (function () {
      const out = []; const seen = new Set();
      const keyOf = (h) => { const m = h.match(/dirId=(\\d+)[\\s\\S]*?docId=(\\d+)/) || h.match(/docId=(\\d+)/); return m ? m.slice(1).join('-') : h; };
      document.querySelectorAll('li.lst').forEach((li) => {
        const a = li.querySelector('div.tit a, a.txt'); if (!a) return; const href = a.href || ''; if (!/detail\\.naver/.test(href) || !/docId=/.test(href)) return;
        const key = keyOf(href); if (seen.has(key)) return; const title = (a.textContent || '').replace(/\\s+/g, ' ').trim(); if (title.length < 4) return;
        const c = li.querySelector('a.cont'); seen.add(key);
        out.push({ kinKey: key, title, url: href, content: c ? (c.textContent || '').replace(/\\s+/g, ' ').trim() : '', category: '' });
      });
      if (out.length === 0) {
        document.querySelectorAll('#au_board_list tr').forEach((tr) => {
          const a = tr.querySelector('td.title a'); if (!a) return; const href = a.href || ''; if (!/detail\\.naver/.test(href) || !/docId=/.test(href)) return;
          const key = keyOf(href); if (seen.has(key)) return; const title = (a.textContent || '').replace(/\\s+/g, ' ').trim(); if (title.length < 4) return;
          seen.add(key); out.push({ kinKey: key, title, url: href, content: '', category: '' });
        });
      }
      return out.slice(0, 40);
    })();
  `;
  const r = await win.webContents.executeJavaScript(script).catch(() => []);
  return Array.isArray(r) ? r : [];
}

/** 상세로 이동 → 에디터 대기 → 사람처럼 타이핑 → (submit) 등록 클릭 */
export async function autoOpenAndAnswer(
  win: BrowserWindow,
  url: string,
  answer: string,
  submit: boolean,
): Promise<{ typed: boolean; submitted: boolean; error?: string }> {
  try {
    await win.loadURL(url);
    await humanDelay(1500, 3200); // 읽는 시간
    let hasEditor = false;
    for (let i = 0; i < 8; i++) {
      hasEditor = await win.webContents.executeJavaScript(HAS_EDITOR_JS).catch(() => false);
      if (hasEditor) break;
      await humanDelay(600, 1100);
    }
    if (!hasEditor) return { typed: false, submitted: false, error: '답변칸 없음(로그인/페이지 확인)' };
    await humanDelay(1200, 2600);
    const typed = await win.webContents.executeJavaScript(typeJS(answer)).catch(() => false);
    if (!typed) return { typed: false, submitted: false, error: '입력 실패' };
    if (!submit) return { typed: true, submitted: false };
    await humanDelay(1000, 2200);
    const submitted = await win.webContents.executeJavaScript(SUBMIT_JS).catch(() => false);
    return { typed: true, submitted: !!submitted };
  } catch (e: unknown) {
    return { typed: false, submitted: false, error: e instanceof Error ? e.message : String(e) };
  }
}
