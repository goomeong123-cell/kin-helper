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
    const pick = (re: RegExp) => {
      const m = re.exec(html);
      return m ? decodeEntities(m[1]).trim() : '';
    };
    const title = pick(/property="og:title"\s+content="([^"]*)"/i);
    // 본문 후보를 여러 곳에서 뽑아 가장 긴 것을 사용
    const cands = [
      pick(/name="description"\s+content="([^"]*)"/i),
      pick(/property="og:description"\s+content="([^"]*)"/i),
    ].filter(Boolean);
    const body = cands.sort((a, b) => b.length - a.length)[0] || '';
    return { title: title || undefined, body: body || undefined };
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

/**
 * 네이버 로그인 쿠키를 디스크에 영구 저장한다.
 * NID_SES 등은 만료일 없는 '세션 쿠키'라 앱을 끄면 사라져서 매번 재로그인하게 된다.
 * → 만료일(30일)을 붙여 다시 저장하면 앱 재시작·업데이트 후에도 로그인이 유지됨.
 */
export async function persistNaverCookies(ses: Electron.Session): Promise<number> {
  let saved = 0;
  try {
    const cookies = await ses.cookies.get({ domain: '.naver.com' });
    const expirationDate = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // 30일
    for (const c of cookies) {
      if (c.expirationDate) continue; // 이미 영구 쿠키
      const host = (c.domain || '').replace(/^\./, '');
      if (!host) continue;
      try {
        await ses.cookies.set({
          url: `https://${host}${c.path || '/'}`,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          expirationDate,
          sameSite: c.sameSite,
        });
        saved++;
      } catch {
        // 개별 쿠키 실패는 무시
      }
    }
    await ses.cookies.flushStore();
  } catch {
    // ignore
  }
  return saved;
}

/** 계정 세션의 쿠키를 영구화 (외부에서 계정 정보로 호출) */
export async function persistAccountLogin(acc: AccountProxy): Promise<number> {
  const ses = await getAccountSession(acc);
  return persistNaverCookies(ses);
}

/** 계정 로그인용 창 (사람이 직접 로그인) */
export async function openLoginWindow(acc: AccountProxy): Promise<void> {
  const ses = await getAccountSession(acc);
  const win = new BrowserWindow({
    show: true,
    width: 980,
    height: 760,
    title: `네이버 로그인 · ${acc.naverId} — 로그인 후 창을 닫으세요`,
    webPreferences: { session: ses },
  });

  // 로그인 진행 중 주기적으로, 그리고 창 닫을 때 쿠키를 영구 저장
  const timer = setInterval(() => {
    persistNaverCookies(ses).catch(() => {});
  }, 5000);
  win.on('closed', () => {
    clearInterval(timer);
    persistNaverCookies(ses).catch(() => {});
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

/**
 * 네이버 로그인 상태 확인.
 * 페이지 HTML 모양은 로그인 상태에서도 로그인 링크가 남거나 늦게 렌더되어 오판하므로,
 * 세션의 네이버 로그인 쿠키(NID_AUT / NID_SES)를 직접 확인한다. (httpOnly 포함해 조회됨)
 */
export async function autoIsLoggedIn(win: BrowserWindow): Promise<{ ok: boolean; detail: string }> {
  try {
    await win.loadURL('https://www.naver.com/');
    await humanDelay(1500, 2600);

    const ses = win.webContents.session;
    const cookies = await ses.cookies.get({ domain: '.naver.com' }).catch(() => []);
    const names = new Set(cookies.map((c) => c.name));
    const hasAuth = names.has('NID_AUT');
    const hasSes = names.has('NID_SES');
    // 둘 중 하나만 있어도 로그인으로 간주 (NID_SES는 세션 쿠키라 재시작 후 없을 수 있음)
    if (hasAuth || hasSes) {
      await persistNaverCookies(ses); // 확인된 로그인 쿠키를 영구화
      return { ok: true, detail: `쿠키 확인(NID_AUT=${hasAuth}, NID_SES=${hasSes})` };
    }

    // 보조 확인: 페이지에서 로그아웃 링크가 보이면 로그인된 것으로 간주
    const domLoggedIn = await win.webContents
      .executeJavaScript(
        `!!document.querySelector('a[href*="nidlogin.logout"], .link_logout, .MyView-module__link_logout___bsTOJ');`,
      )
      .catch(() => false);
    if (domLoggedIn) return { ok: true, detail: '페이지에서 로그아웃 링크 확인' };

    return {
      ok: false,
      detail: `네이버 쿠키 ${cookies.length}개, NID_AUT=${hasAuth}, NID_SES=${hasSes}`,
    };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** 네이버 메인 → (…) 버튼 → 지식iN 클릭 → 답변하기 클릭 (사람처럼 클릭 경로) */
export async function autoGoToKinAnswerList(win: BrowserWindow): Promise<boolean> {
  try {
    // 네이버 메인에서 시작 (이미 로그인 확인 시 여기 있음)
    if (!/naver\.com\/?$/.test(win.webContents.getURL())) {
      await win.loadURL('https://www.naver.com/');
      await humanDelay(1200, 2200);
    }
    // (…) 더보기 버튼 클릭
    await win.webContents
      .executeJavaScript(
        `
        (function () {
          const more = document.querySelector('.service_icon.type_more');
          const btn = more ? (more.closest('a,button') || more) : null;
          if (btn) { btn.click(); return true; }
          return false;
        })();
      `,
      )
      .catch(() => false);
    await humanDelay(700, 1400);

    // 지식iN 링크 클릭 (target=_blank 제거해 같은 창에서 이동)
    const went = await win.webContents
      .executeJavaScript(
        `
        (function () {
          let a = document.querySelector('a.link_service .service_icon.type_kin');
          a = a ? a.closest('a') : document.querySelector('a[href*="kin.naver.com"]');
          if (!a) return false;
          a.removeAttribute('target');
          a.click();
          return true;
        })();
      `,
      )
      .catch(() => false);
    await humanDelay(1500, 2600);

    // 클릭이 안 먹었으면 직접 이동
    if (!went || !/kin\.naver\.com/.test(win.webContents.getURL())) {
      await win.loadURL('https://kin.naver.com/');
      await humanDelay(1200, 2000);
    }

    // 답변하기 클릭
    await win.webContents
      .executeJavaScript(
        `
        (function () {
          const els = Array.from(document.querySelectorAll('a, em, button'));
          const el = els.find((e) => (e.textContent || '').trim() === '답변하기');
          const a = el ? (el.closest('a') || el) : null;
          if (a) { a.removeAttribute && a.removeAttribute('target'); a.click(); return true; }
          return false;
        })();
      `,
      )
      .catch(() => false);
    await humanDelay(1500, 2600);

    // 최종적으로 답변 대기 목록 페이지 보장
    if (!/questionList\.naver/.test(win.webContents.getURL())) {
      await win.loadURL('https://kin.naver.com/qna/questionList.naver');
      await humanDelay(1400, 2400);
    }
    return true;
  } catch {
    return false;
  }
}

/** '답변을 기다리는 질문' 목록에서 질문 추출 (JS 렌더링되므로 실제 창에서 스크랩) */
export async function autoScrapeWaitingList(win: BrowserWindow): Promise<CollectedQuestion[]> {
  // 목록이 채워질 때까지 대기 + 사람처럼 스크롤
  for (let i = 0; i < 6; i++) {
    const n = await win.webContents
      .executeJavaScript(`document.querySelectorAll('a[href*="detail.naver"]').length;`)
      .catch(() => 0);
    if (typeof n === 'number' && n > 0) break;
    await humanDelay(700, 1300);
  }
  await win.webContents
    .executeJavaScript(`window.scrollBy(0, ${250 + Math.floor(Math.random() * 350)});`)
    .catch(() => {});
  await humanDelay(600, 1300);

  const script = `
    (function () {
      const out = []; const seen = new Set();
      const keyOf = (h) => { const m = h.match(/dirId=(\\d+)[\\s\\S]*?docId=(\\d+)/) || h.match(/docId=(\\d+)/); return m ? m.slice(1).join('-') : h; };
      const add = (a, contEl) => {
        const href = a.href || ''; if (!/detail\\.naver/.test(href) || !/docId=/.test(href)) return;
        const key = keyOf(href); if (seen.has(key)) return;
        const title = (a.textContent || '').replace(/\\s+/g, ' ').trim(); if (title.length < 4) return;
        seen.add(key);
        out.push({ kinKey: key, title, url: href, content: contEl ? (contEl.textContent || '').replace(/\\s+/g,' ').trim() : '', category: '' });
      };
      // 1) '답변을 기다리는 질문' 영역 우선
      const box = document.querySelector('._noanswer_list, .answer_list');
      if (box) {
        box.querySelectorAll('li').forEach((li) => {
          const a = li.querySelector('a[href*="detail.naver"]');
          if (a) add(a, li.querySelector('a.cont, .cont'));
        });
      }
      // 2) 폴백: li.lst 구조
      if (out.length === 0) {
        document.querySelectorAll('li.lst').forEach((li) => {
          const a = li.querySelector('div.tit a, a.txt') || li.querySelector('a[href*="detail.naver"]');
          if (a) add(a, li.querySelector('a.cont'));
        });
      }
      // 3) 폴백: 페이지 전체 detail 링크
      if (out.length === 0) {
        document.querySelectorAll('a[href*="detail.naver"]').forEach((a) => add(a, null));
      }
      return out.slice(0, 40);
    })();
  `;
  const r = await win.webContents.executeJavaScript(script).catch(() => []);
  return Array.isArray(r) ? r : [];
}

/** 지식인 검색창에 키워드 검색 → 최신순 정렬 (홍보용) */
export async function autoSearchKeyword(win: BrowserWindow, keyword: string): Promise<boolean> {
  try {
    // 검색은 지식인 검색 페이지로 바로 이동(검색창 입력과 동일 결과, 더 안정적)
    await win.loadURL(
      `https://kin.naver.com/search/list.naver?query=${encodeURIComponent(keyword)}`,
    );
    await humanDelay(1400, 2400);
    // 최신순 클릭
    await win.webContents
      .executeJavaScript(
        `
        (function () {
          const els = Array.from(document.querySelectorAll('button, a'));
          const b = els.find((e) => (e.textContent || '').replace(/\\s+/g,'').includes('최신순'));
          if (b) { b.click(); return true; }
          return false;
        })();
      `,
      )
      .catch(() => false);
    await humanDelay(1200, 2200);
    return true;
  } catch {
    return false;
  }
}

/**
 * 에디터에 실제 커서를 잡고 클릭 좌표를 구한다.
 * 지식인 답변창은 iframe 안의 contenteditable이라, iframe 오프셋을 더해 실제 화면 좌표를 계산.
 */
async function focusEditorPoint(
  win: BrowserWindow,
): Promise<{ x: number; y: number } | null> {
  const r = await win.webContents
    .executeJavaScript(
      `
      (function () {
        const big = (el) => { const r = el.getBoundingClientRect(); return r.width > 20 && r.height > 15; };
        // 지식인 답변창은 SmartEditor ONE — contenteditable 속성이 없고 자체 커서를 그린다.
        // 그래서 SE 전용 선택자까지 포함해서 찾는다.
        // 실제 글이 들어가는 문단(.se-text-paragraph)을 최우선으로 클릭해야 커서가 잡힌다
        const SEL = [
          '.se-text-paragraph',
          '.se-module-text',
          '[contenteditable="true"]',
          '.se-section-text',
          '.se-components-wrap',
          '.se-content',
          'textarea',
        ];
        const findIn = (root) => {
          for (const s of SEL) {
            const els = Array.from(root.querySelectorAll(s)).filter(big);
            if (els.length) return els[els.length - 1]; // 마지막(=본문 입력 영역)
          }
          return null;
        };

        let target = findIn(document), offX = 0, offY = 0, doc = document;
        if (!target) {
          for (const f of document.querySelectorAll('iframe')) {
            try {
              const d = f.contentDocument; if (!d) continue;
              const fr = f.getBoundingClientRect(); if (fr.width < 50 || fr.height < 50) continue;
              const el = findIn(d) || ((d.body && d.body.isContentEditable) ? d.body : null);
              if (el) { target = el; doc = d; offX = fr.left; offY = fr.top; try { f.contentWindow.focus(); } catch (e) {} break; }
            } catch (e) {}
          }
        }
        if (!target) return null;

        // 이 답변칸만 정확히 측정하기 위해 표시를 남긴다 (질문 본문도 같은 SE 마크업이라 페이지 전체 합산은 오염됨)
        try {
          const doc0 = target.ownerDocument;
          doc0.querySelectorAll('[data-kin-editor]').forEach((n) => n.removeAttribute('data-kin-editor'));
          const box = target.closest('.se-module-text, .se-section-text, .se-component-content') || target;
          box.setAttribute('data-kin-editor', '1');
        } catch (e) {}

        try { target.focus(); } catch (e) {}
        // 네이티브 contenteditable이면 캐럿도 잡아둔다 (SE는 클릭으로 잡힘)
        try {
          if (target.isContentEditable) {
            const range = doc.createRange();
            range.selectNodeContents(target);
            range.collapse(false);
            const sel = doc.defaultView.getSelection();
            sel.removeAllRanges(); sel.addRange(range);
          }
        } catch (e) {}

        const b = target.getBoundingClientRect();
        return {
          x: Math.round(offX + b.left + Math.min(Math.max(b.width / 2, 30), 220)),
          y: Math.round(offY + b.top + Math.min(Math.max(b.height / 3, 15), 50)),
        };
      })();
    `,
    )
    .catch(() => null);
  return r && typeof r.x === 'number' ? r : null;
}

/** 에디터 안 글자 수 (입력 성공 검증용) — SmartEditor(.__se-node) 포함 */
async function editorTextLength(win: BrowserWindow): Promise<number> {
  return await win.webContents
    .executeJavaScript(
      `
      (function () {
        const readIn = (root) => {
          // 표시해둔 답변칸이 있으면 그것만 측정 (질문 본문 오염 방지)
          const marked = root.querySelector('[data-kin-editor="1"]');
          if (marked) return (marked.innerText || marked.textContent || '').replace(/\\u200B/g, '').trim().length;
          // SmartEditor: 입력된 텍스트는 .__se-node / .se-text-paragraph 안에 들어감
          const se = root.querySelectorAll('.__se-node, .se-text-paragraph');
          if (se.length) {
            let s = '';
            se.forEach((n) => { s += (n.innerText || n.textContent || ''); });
            return s.replace(/\\u200B/g, '').trim().length;
          }
          const ce = root.querySelector('[contenteditable="true"]');
          if (ce) return (ce.innerText || ce.textContent || '').trim().length;
          const ta = root.querySelector('textarea');
          if (ta) return (ta.value || '').trim().length;
          return 0;
        };
        let n = readIn(document);
        if (n > 0) return n;
        for (const f of document.querySelectorAll('iframe')) {
          try { const d = f.contentDocument; if (!d) continue; n = readIn(d); if (n > 0) return n; } catch (e) {}
        }
        return 0;
      })();
    `,
    )
    .catch(() => 0);
}

/**
 * 실제 키보드 입력으로 사람처럼 타이핑.
 * (execCommand는 iframe 안에서 커서가 안 잡히면 조용히 실패하므로, 진짜 키 이벤트를 보낸다)
 */
/** SmartEditor 커서가 실제로 잡혔는지 (깜빡이는 캐럿 또는 포커스된 편집영역) */
async function caretActive(win: BrowserWindow): Promise<boolean> {
  return await win.webContents
    .executeJavaScript(
      `
      (function () {
        if (document.querySelector('.se-caret.se-is-caret-blinking, .se-is-focused')) return true;
        const a = document.activeElement;
        if (a && (a.isContentEditable || a.tagName === 'TEXTAREA')) return true;
        for (const f of document.querySelectorAll('iframe')) {
          try {
            const d = f.contentDocument; if (!d) continue;
            if (d.querySelector('.se-caret.se-is-caret-blinking, .se-is-focused')) return true;
            const b = d.activeElement;
            if (b && (b.isContentEditable || b.tagName === 'TEXTAREA')) return true;
          } catch (e) {}
        }
        return false;
      })();
    `,
    )
    .catch(() => false);
}

export async function typeIntoEditorHuman(
  win: BrowserWindow,
  text: string,
): Promise<{ ok: boolean; detail: string }> {
  // 입력 전 글자 수를 기준으로 삼는다.
  // (에디터 안내문도 .se-text-paragraph 안에 있어서, 단순 '글자 있음' 판정은 속는다)
  const before = await editorTextLength(win);

  const pt = await focusEditorPoint(win);
  if (!pt) return { ok: false, detail: '에디터 위치를 찾지 못함' };

  const click = (x: number, y: number) => {
    try {
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    } catch {
      // ignore
    }
  };

  try {
    win.focus();
    click(pt.x, pt.y);
  } catch {
    // ignore
  }
  await humanDelay(500, 1000);

  // 커서가 안 잡혔으면 살짝 아래를 한 번 더 클릭
  let caret = await caretActive(win);
  if (!caret) {
    click(pt.x, pt.y + 30);
    await humanDelay(400, 800);
    caret = await caretActive(win);
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a: number, b: number) => a + Math.floor(Math.random() * (b - a));

  // insertText: 포커스된 편집영역에 문자를 실제로 삽입하는 Electron API.
  // SmartEditor처럼 자체 입력 처리를 하는 에디터에서 raw 키 이벤트보다 훨씬 확실하다.
  const sendChar = (ch: string) => {
    try {
      if (ch === '\n') {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
        win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
      } else {
        win.webContents.insertText(ch);
      }
    } catch {
      // ignore
    }
  };

  // 먼저 몇 글자만 보내서 '입력 전보다 늘었는지' 확인 (허공에 300자 치는 것 방지)
  const probe = text.slice(0, 3);
  try {
    for (const ch of probe) {
      sendChar(ch);
      await sleep(rnd(40, 90));
    }
  } catch {
    // ignore
  }
  await humanDelay(400, 800);

  if ((await editorTextLength(win)) <= before) {
    // 폴백 1: 전체 문장을 한 번에 삽입
    try {
      win.webContents.insertText(text);
      await humanDelay(700, 1200);
    } catch {
      // ignore
    }
    if ((await editorTextLength(win)) > before) {
      return { ok: true, detail: '일괄 입력됨(insertText)' };
    }
    // 폴백 2: 클립보드 붙여넣기
    try {
      clipboard.writeText(text);
      win.webContents.paste();
      await humanDelay(900, 1600);
    } catch {
      // ignore
    }
    const after = await editorTextLength(win);
    return after > before
      ? { ok: true, detail: '붙여넣기로 입력됨' }
      : {
          ok: false,
          detail: `입력 실패 (전 ${before}자 → 후 ${after}자, 커서 ${caret ? '있음' : '없음'})`,
        };
  }

  // 키 입력이 먹으므로 나머지를 사람처럼 한 글자씩
  let i = 0;
  for (const ch of text.slice(probe.length)) {
    if (win.isDestroyed()) return { ok: false, detail: '창이 닫힘' };
    try {
      sendChar(ch);
    } catch {
      return { ok: false, detail: '키 입력 중 오류' };
    }
    i++;
    await sleep(rnd(18, 70));
    if (/[\s.,!?~]/.test(ch) && Math.random() < 0.15) await sleep(rnd(120, 320));
    if (i % rnd(35, 60) === 0) await sleep(rnd(300, 850));
  }

  await humanDelay(400, 900);
  const final = await editorTextLength(win);
  return final > before
    ? { ok: true, detail: `타이핑 입력됨 (${final - before}자)` }
    : { ok: false, detail: `입력 확인 실패 (전 ${before}자 → 후 ${final}자)` };
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

/**
 * 상세로 이동 → '답변' 버튼 클릭해 에디터 열기 → 사람처럼 타이핑 → (submit) 등록 클릭.
 * 실제 지식인 구조:
 *   답변 열기 = button._answerWriteButton._scrollToEditor
 *   등록      = button#answerRegisterButton._answerRegisterButton
 */
export async function autoOpenAndAnswer(
  win: BrowserWindow,
  url: string,
  answer: string,
  submit: boolean,
): Promise<{ typed: boolean; submitted: boolean; error?: string }> {
  try {
    await win.loadURL(url);
    await humanDelay(1800, 3400); // 질문 읽는 시간

    // 이미 내가 답변한 질문이면 중단 (중복 방지 2차 안전장치)
    const already = await win.webContents
      .executeJavaScript(
        `
        (function () {
          // 내 답변이 이미 있으면 '수정'/'삭제' 같은 내 답변 컨트롤이 보임
          return !!document.querySelector('._answerModifyButton, .my_answer');
        })();
      `,
      )
      .catch(() => false);
    if (already) return { typed: false, submitted: false, error: '이미 답변한 질문(건너뜀)' };

    // '답변' 버튼 클릭 → 에디터 열기
    const opened = await win.webContents
      .executeJavaScript(
        `
        (function () {
          const b = document.querySelector('button._answerWriteButton, .endAnswerButton._answerWriteButton, ._scrollToEditor');
          if (b) { b.click(); return true; }
          return false;
        })();
      `,
      )
      .catch(() => false);
    if (!opened) {
      return { typed: false, submitted: false, error: "'답변' 버튼 없음(로그인 상태/페이지 확인)" };
    }
    await humanDelay(1200, 2200);

    // 에디터 대기
    let hasEditor = false;
    for (let i = 0; i < 10; i++) {
      hasEditor = await win.webContents.executeJavaScript(HAS_EDITOR_JS).catch(() => false);
      if (hasEditor) break;
      await humanDelay(600, 1100);
    }
    if (!hasEditor) return { typed: false, submitted: false, error: '답변 입력칸이 열리지 않음' };

    await humanDelay(1000, 2200);

    // 1순위: 실제 키보드 입력 (iframe/SmartEditor에서 확실히 동작)
    const before = await editorTextLength(win);
    const r = await typeIntoEditorHuman(win, answer);
    let typed = r.ok;
    let detail = r.detail;
    if (!typed) {
      // 2순위: execCommand 주입 폴백
      await win.webContents.executeJavaScript(typeJS(answer)).catch(() => false);
      const len = await editorTextLength(win);
      typed = len > before;
      if (typed) detail = 'execCommand 폴백으로 입력됨';
    }
    if (!typed) {
      return { typed: false, submitted: false, error: `답변이 입력창에 들어가지 않음 — ${detail}` };
    }
    if (!submit) return { typed: true, submitted: false };

    await humanDelay(1200, 2400);
    const submitted = await win.webContents
      .executeJavaScript(
        `
        (function () {
          const b = document.querySelector('#answerRegisterButton, button._answerRegisterButton');
          if (b) { b.click(); return true; }
          return false;
        })();
      `,
      )
      .catch(() => false);
    if (!submitted) return { typed: true, submitted: false, error: "'등록' 버튼을 찾지 못함" };
    await humanDelay(1500, 2600); // 등록 처리 대기
    return { typed: true, submitted: true };
  } catch (e: unknown) {
    return { typed: false, submitted: false, error: e instanceof Error ? e.message : String(e) };
  }
}
