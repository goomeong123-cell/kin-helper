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

    // 에디터가 아직 안 열려 있으면 "답변하기/답변 쓰기" 버튼을 눌러 연다.
    await win.webContents
      .executeJavaScript(
        `
        (function () {
          const hasCE = () => {
            if (document.querySelector('[contenteditable="true"]')) return true;
            for (const f of document.querySelectorAll('iframe')) {
              try { if (f.contentDocument && (f.contentDocument.querySelector('[contenteditable="true"]') || (f.contentDocument.body && f.contentDocument.body.isContentEditable))) return true; } catch(e){}
            }
            return false;
          };
          if (hasCE()) return;
          const b = Array.from(document.querySelectorAll('a, button')).find((el) => /답변\\s*하기|답변\\s*쓰기|답변\\s*등록하기/.test((el.innerText || '').trim()));
          if (b) b.click();
        })();
      `,
      )
      .catch(() => {});
    await humanDelay(1200, 2200);

    // semi/auto: 에디터에 본문 주입. 지식인 답변칸 = iframe 내부 body[contenteditable] (SmartEditor).
    const injected = await win.webContents
      .executeJavaScript(
        `
        (function () {
          const text = ${JSON.stringify(opts.answer)};
          const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          const html = text.split('\\n').map((l) => '<p>' + (l ? esc(l) : '<br>') + '</p>').join('');
          const fillCE = (ce) => {
            ce.focus();
            try { ce.innerHTML = html; } catch (e) { ce.textContent = text; }
            ce.dispatchEvent(new Event('input', { bubbles: true }));
            ce.dispatchEvent(new Event('keyup', { bubbles: true }));
            return true;
          };
          // 1) 최상위 문서 contenteditable
          const topCE = document.querySelector('[contenteditable="true"]');
          if (topCE) return fillCE(topCE) ? 'top-ce' : false;
          // 2) 같은 출처 iframe 내부 contenteditable body (SmartEditor)
          for (const f of document.querySelectorAll('iframe')) {
            try {
              const d = f.contentDocument;
              if (!d) continue;
              const ice = d.querySelector('[contenteditable="true"]') || (d.body && d.body.isContentEditable ? d.body : null);
              if (ice) return fillCE(ice) ? 'iframe-ce' : false;
            } catch (e) {}
          }
          // 3) textarea 폴백
          const ta = document.querySelector('textarea');
          if (ta) { ta.focus(); ta.value = text; ta.dispatchEvent(new Event('input', { bubbles: true })); return 'textarea'; }
          return false;
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
