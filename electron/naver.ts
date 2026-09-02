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

// 네이버에 "일반 크롬"으로 보이도록 위장하는 User-Agent (Electron/앱 흔적 제거).
// 중요: UA 문자열의 크롬 버전을 실제 엔진(Chromium) 버전과 맞춰야 client hints(sec-ch-ua)와
// 어긋나지 않는다. Electron이 심는 Chromium 버전을 그대로 사용.
const CHROME_VER = (process.versions.chrome || '130.0.0.0').replace(/^(\d+\.\d+\.\d+\.\d+).*/, '$1');
const CHROME_MAJOR = CHROME_VER.split('.')[0];
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VER} Safari/537.36`;

// 실제 크롬의 client-hint 값 (Electron은 "Google Chrome" 브랜드가 빠져 있어 봇으로 탐지됨 → 주입)
const SEC_CH_UA = `"Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}", "Not?A_Brand";v="99"`;
const SEC_CH_UA_FULL = `"Chromium";v="${CHROME_VER}", "Google Chrome";v="${CHROME_VER}", "Not?A_Brand";v="99.0.0.0"`;

// 매 페이지 로드 시 실행돼 navigator를 진짜 크롬처럼 위장하는 스크립트.
// userAgentData.brands는 getter가 non-configurable이라, 객체를 통째로 교체해야 'Google Chrome'이 들어감(실측 확인).
const STEALTH_JS = `
(function () {
  try {
    var brands = [
      { brand: 'Not?A_Brand', version: '99' },
      { brand: 'Chromium', version: '${CHROME_MAJOR}' },
      { brand: 'Google Chrome', version: '${CHROME_MAJOR}' }
    ];
    var fvl = [
      { brand: 'Not?A_Brand', version: '99.0.0.0' },
      { brand: 'Chromium', version: '${CHROME_VER}' },
      { brand: 'Google Chrome', version: '${CHROME_VER}' }
    ];
    var cp = function (a) { return a.map(function (b) { return { brand: b.brand, version: b.version }; }); };
    if (navigator.userAgentData) {
      var fake = {
        brands: cp(brands),
        mobile: false,
        platform: 'Windows',
        getHighEntropyValues: function (h) {
          return Promise.resolve({
            brands: cp(brands), fullVersionList: cp(fvl), mobile: false, platform: 'Windows',
            platformVersion: '19.0.0', architecture: 'x86', bitness: '64', model: '', uaFullVersion: '${CHROME_VER}'
          });
        },
        toJSON: function () { return { brands: cp(brands), mobile: false, platform: 'Windows' }; }
      };
      try { Object.defineProperty(navigator, 'userAgentData', { get: function () { return fake; }, configurable: true }); } catch (e) {}
    }
    try { Object.defineProperty(navigator, 'languages', { get: function () { return ['ko-KR', 'ko']; }, configurable: true }); } catch (e) {}
    if (!window.chrome) { try { window.chrome = {}; } catch (e) {} }
    if (window.chrome && !window.chrome.runtime) { try { window.chrome.runtime = {}; } catch (e) {} }

    // ★ 중요: 페이지가 alert/confirm/prompt를 띄우면 Electron이 네이티브 모달을 열고
    //   렌더러가 통째로 얼어 executeJavaScript가 영원히 안 끝난다(= 자동발행 정지).
    //   에디터의 '임시저장 이어쓰기' 확인창 등이 여기 해당 → 모달 없이 즉시 응답 처리.
    try { window.alert = function () {}; } catch (e) {}
    try { window.confirm = function () { return false; }; } catch (e) {}
    try { window.prompt = function () { return null; }; } catch (e) {}
    // 페이지 이탈 경고(beforeunload)도 모달 없이 통과시킨다.
    try { window.onbeforeunload = null; } catch (e) {}
  } catch (e) {}
})();
`;

// 세션 위장: 크롬 UA + 한국어 + client-hint 헤더를 실제 크롬 값으로 교체
function applySessionSpoof(ses: Electron.Session) {
  ses.setUserAgent(CHROME_UA, 'ko-KR,ko');
  try {
    ses.webRequest.onBeforeSendHeaders((details, cb) => {
      const h = details.requestHeaders;
      for (const k of Object.keys(h)) {
        const lk = k.toLowerCase();
        if (lk === 'sec-ch-ua') h[k] = SEC_CH_UA;
        else if (lk === 'sec-ch-ua-full-version-list') h[k] = SEC_CH_UA_FULL;
      }
      cb({ requestHeaders: h });
    });
  } catch {
    // ignore
  }
}

// 창 위장: WebRTC 실제 IP 차단 + 매 페이지 로드 시 navigator를 크롬처럼 위장 주입.
// (CDP 디버거 방식은 일부 환경에서 hang 위험이 있어 dom-ready 주입으로 처리)
function hardenWindow(win: BrowserWindow) {
  try {
    win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  } catch {
    // ignore
  }
  const inject = () => {
    win.webContents.executeJavaScript(STEALTH_JS, true).catch(() => {});
  };
  win.webContents.on('dom-ready', inject);
  win.webContents.on('did-navigate', inject);
  win.webContents.on('did-navigate-in-page', inject);

  // 에디터에 글을 쓴 뒤 다른 질문으로 이동하면 페이지가 이탈 경고(beforeunload)를 띄우는데,
  // 그러면 Electron이 네이티브 모달을 열고 loadURL이 영원히 끝나지 않는다(= 자동발행 정지).
  // 항상 '이동 허용'으로 처리해 모달 자체가 뜨지 않게 한다.
  win.webContents.on('will-prevent-unload', (e) => {
    e.preventDefault();
  });

  // 페이지 로딩이 실패하면 흰 화면 대신 이유를 보여준다 (프록시 문제를 바로 알 수 있게).
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 = 사용자가 취소한 정상 중단
    const proxyIssue = /PROXY|TUNNEL|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i.test(errorDescription || '');
    const msg = proxyIssue
      ? '프록시 연결에 실패했습니다.<br>계정·프록시 탭에서 주소·포트·아이디·비밀번호가 맞는지, 프록시가 살아있는지 확인하세요.'
      : '페이지를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
    const html = `<!doctype html><meta charset="utf-8"><body style="font-family:'Malgun Gothic',sans-serif;padding:48px;color:#191f28">
      <div style="font-size:20px;font-weight:700;margin-bottom:12px">연결 실패</div>
      <div style="font-size:15px;line-height:1.7;color:#4e5968">${msg}</div>
      <div style="margin-top:20px;font-size:13px;color:#8b95a1">오류: ${String(errorDescription || '').replace(/</g, '')} (${errorCode})</div>
    </body>`;
    win.webContents
      .loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
      .catch(() => {});
  });
}

/** executeJavaScript에 시간 제한 — 렌더러가 멈춰도 무한 대기하지 않도록. 초과 시 fallback 반환. */
async function evalJs<T>(win: BrowserWindow, js: string, fallback: T, ms = 15000): Promise<T> {
  return (await Promise.race([
    win.webContents.executeJavaScript(js),
    new Promise<T>((res) => setTimeout(() => res(fallback), ms)),
  ]).catch(() => fallback)) as T;
}

// 계정별 프록시 인증 정보 (login 이벤트에서 사용)
const proxyCredById = new Map<number, { user: string; pass: string }>();
// 어떤 창(webContents)이 어떤 계정 것인지 — 프록시 인증을 '그 계정 것'으로 보내기 위함
const accountByWebContentsId = new Map<number, number>();

/** 이 창이 어느 계정 소속인지 기록 (프록시 인증을 계정별로 정확히 보내기 위해 필수) */
function bindWindowAccount(win: BrowserWindow, accountId: number) {
  try {
    const id = win.webContents.id;
    accountByWebContentsId.set(id, accountId);
    win.on('closed', () => accountByWebContentsId.delete(id));
  } catch {
    // ignore
  }
}

app.on('login', (event, webContents, _request, authInfo, callback) => {
  if (authInfo.isProxy) {
    // 반드시 '요청한 창의 계정' 프록시 자격증명을 사용해야 한다.
    // (예전엔 등록된 첫 계정 것을 무조건 보내서, 2번째 이후 계정은 인증 실패 → 흰 화면)
    const accId = webContents ? accountByWebContentsId.get(webContents.id) : undefined;
    const cred = accId != null ? proxyCredById.get(accId) : undefined;
    if (cred && cred.user) {
      event.preventDefault();
      callback(cred.user, cred.pass);
      return;
    }
    // 계정을 못 찾았고 등록된 자격증명이 딱 하나뿐이면 그것만 사용 (모호할 땐 보내지 않음)
    if (accId == null && proxyCredById.size === 1) {
      const only = proxyCredById.values().next().value;
      if (only && only.user) {
        event.preventDefault();
        callback(only.user, only.pass);
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
  // 크롬으로 위장(UA + 한국어 + client-hint 헤더). 한국 계정 fingerprint 일치.
  applySessionSpoof(ses);
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

/** 지식인 질문 URL 정규화: http→https, 상대경로 보정, 호스트 고정 (ERR_FAILED 방지) */
export function normalizeKinUrl(u: string): string {
  let s = (u || '').trim();
  if (!s) return s;
  if (s.startsWith('//')) s = 'https:' + s;
  else if (s.startsWith('/')) s = 'https://kin.naver.com' + s;
  s = s.replace(/^http:\/\//i, 'https://');
  if (!/^https:\/\//i.test(s)) s = 'https://' + s.replace(/^https?:\/\//i, '');
  return s;
}

// ===== questionList '답변 대기 질문' 위젯 인페이지 조작 (실측 검증됨) =====
// 반드시 #questionAll(답변 대기 질문) 위젯만 사용. #questionInterest(관심질문)는 절대 사용 금지.
// 검색창 = #questionAll 안의 input._search_input (폼 없음 → URL 안 바뀜)
// 검색버튼 = a._search_button, 최신순 = button._sort_option._param('recent')

// #questionAll 위젯을 찾는 JS 조각 (없으면 관심 아닌 첫 위젯으로 폴백)
const BOX_JS = `(document.querySelector('#questionAll .content_wrap._noanswer_wrap') || document.querySelector('#questionAll') || [...document.querySelectorAll('.content_wrap._noanswer_wrap')].find(w=>!/interest/i.test((w.closest('[id]')||{}).id||'')) || document.querySelector('.content_wrap._noanswer_wrap'))`;

// 로그인 시 기본 탭이 '관심질문'이라, 먼저 '답변을 기다리는 질문' 탭(#contentsOfMain)을 눌러 활성화해야 함.
const ACTIVATE_TAB_JS = `
  (function () {
    const b = document.querySelector('#contentsOfMain')
      || Array.from(document.querySelectorAll('button[role="tab"]')).find((x) => x.getAttribute('aria-controls') === 'questionQna')
      || Array.from(document.querySelectorAll('button[role="tab"]')).find((x) => (x.textContent || '').replace(/\\s+/g, '').startsWith('답변을기다리는질문'));
    if (b) { b.click(); return true; }
    return false;
  })();
`;

/** 위젯 검색창에 키워드 입력 후 검색 실행 (URL 변화 없이 목록만 갱신) */
function searchInPageJS(keyword: string): string {
  return `
    (function () {
      const box = ${BOX_JS};
      if (!box) return 'no-box';
      const inp = box.querySelector('input._search_input, input.search_input');
      if (!inp) return 'no-input';
      inp.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${JSON.stringify(keyword)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      const btn = box.querySelector('a._search_button, ._search_button');
      if (btn) btn.click();
      ['keydown', 'keypress', 'keyup'].forEach((t) =>
        inp.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })),
      );
      return btn ? 'searched' : 'no-btn';
    })();
  `;
}

/** 위젯의 '최신순' 정렬 버튼 클릭 (#questionAll 내부만) */
const SORT_RECENT_JS = `
  (function () {
    const box = ${BOX_JS} || document;
    const btns = Array.from(box.querySelectorAll('button, a'));
    const b = btns.find((e) => (e.className || '').toString().includes("_param('recent')")) ||
              btns.find((e) => (e.textContent || '').replace(/\\s+/g, '') === '최신순');
    if (b) { b.click(); return true; }
    return false;
  })();
`;

/** '답변 대기 질문' 위젯(#questionAll)에서 질문 목록 추출 (미답변만) */
const SCRAPE_NOANSWER_JS = `
  (function () {
    const box = ${BOX_JS} || document;
    const out = []; const seen = new Set();
    const keyOf = (h) => { const m = h.match(/dirId=(\\d+)[\\s\\S]*?docId=(\\d+)/) || h.match(/docId=(\\d+)/); return m ? m.slice(1).join('-') : h; };
    box.querySelectorAll('a[href*="detail.naver"]').forEach((a) => {
      const href = a.href || ''; if (!/docId=/.test(href)) return;
      const key = keyOf(href); if (seen.has(key)) return;
      // 앵커 텍스트는 "제목 새 창 본문스니펫" 형태 → '새 창' 기준으로 제목/본문 분리
      const raw = (a.textContent || '').replace(/\\s+/g, ' ').trim();
      const parts = raw.split('새 창');
      const title = (parts[0] || '').trim();
      const content = parts.slice(1).join(' ').trim();
      if (title.length < 4) return;
      seen.add(key);
      out.push({ kinKey: key, title: title, url: href, content: content, category: '' });
    });
    return out.slice(0, 40);
  })();
`;

/**
 * 다음 페이지로 이동 (URL 안 바뀜).
 *  - 번호 페이지(a._page._param('N'))가 있으면 그걸 우선 클릭(블록 내 이동)
 *  - 없으면 '다음' 버튼(a._nextPage) 클릭 — 검색+최신순 결과는 '다음'만 뜸
 *  - 더 갈 곳이 없으면 false
 */
function advancePageJS(nextNum: number): string {
  return `
    (function () {
      const scope = ${BOX_JS} || document;
      const want = "_param('" + ${nextNum} + "')";
      // 1) 번호 페이지가 있으면 우선
      const pages = Array.from(scope.querySelectorAll('a._page'));
      const numbered = pages.find((a) => (a.className || '').toString().includes(want))
        || pages.find((a) => (a.textContent || '').trim() === String(${nextNum}));
      if (numbered) { numbered.click(); return 'numbered'; }
      // 2) 번호가 없으면 '다음' 버튼 (검색결과는 다음만 표시)
      const next = scope.querySelector('a._nextPage, a.next._nextPage')
        || document.querySelector("#pagingArea0 a._nextPage, ._pagingArea a._nextPage, a._nextPage");
      if (next) {
        const cls = (next.className || '').toString();
        const st = (next.getAttribute('style') || '');
        if (/disabled|_disabled/.test(cls) || /display\\s*:\\s*none/.test(st)) return false;
        next.click();
        return 'next';
      }
      return false;
    })();
  `;
}

/** 현재 열린 목록 창에서 페이지를 돌며 질문을 모아 중복 제거.
 *  limit이 있으면 '실제로 쓸 수 있는(=이미 수집하지 않은)' 질문 기준으로 그만큼 모이면 종료.
 *  isNew가 주어지면 이미 DB에 있는 질문은 목표 개수에 세지 않고 계속 페이지를 넘긴다.
 *  (예전엔 이미 있는 질문까지 목표에 포함시켜, 앞 페이지가 다 기존 질문이면 신규를 거의 못 가져왔음) */
async function scrapePagesInWin(
  win: BrowserWindow,
  maxPages: number,
  limit?: number,
  isNew?: (kinKey: string) => boolean,
): Promise<CollectedQuestion[]> {
  const all: CollectedQuestion[] = [];
  const seen = new Set<string>();
  let scanned = 0; // 훑어본 질문 총수(이미 있는 것 포함)
  const pages = Math.max(1, Math.min(20, Math.floor(maxPages) || 1));
  for (let p = 1; p <= pages; p++) {
    if (p > 1) {
      // p번째 페이지로 이동 (번호가 있으면 번호, 없으면 '다음')
      const moved = await win.webContents.executeJavaScript(advancePageJS(p)).catch(() => false);
      if (!moved) break; // 더 갈 페이지 없음 → 종료
      await humanDelay(2000, 3200); // 페이지 전환 AJAX 대기
      await win.webContents.executeJavaScript('window.scrollBy(0, 400);').catch(() => {});
      await humanDelay(400, 900);
    }
    const r = (await win.webContents.executeJavaScript(SCRAPE_NOANSWER_JS).catch(() => [])) as CollectedQuestion[];
    if (!Array.isArray(r)) continue;
    let uniqueOnPage = 0; // 이 페이지에서 처음 본 질문 수 (같은 목록 반복 감지용)
    for (const q of r) {
      if (seen.has(q.kinKey)) continue;
      seen.add(q.kinKey);
      uniqueOnPage++;
      scanned++;
      // 이미 수집한 질문은 목표 개수에 세지 않는다 (계속 다음 페이지로 더 찾음)
      if (isNew && !isNew(q.kinKey)) continue;
      all.push(q);
    }
    // 쓸 수 있는 질문이 목표만큼 모였으면 종료
    if (limit && all.length >= limit) break;
    // 2페이지 이상인데 처음 보는 질문이 하나도 없으면(같은 목록 반복 신호) 중단
    if (p > 1 && uniqueOnPage === 0) break;
  }
  lastScanCount = scanned;
  return limit ? all.slice(0, limit) : all;
}

/** 직전 수집에서 실제로 훑어본 질문 수 (진단용 — 몇 개 중 몇 개가 신규였는지 알려주기 위함) */
let lastScanCount = 0;
export function getLastScanCount(): number {
  return lastScanCount;
}

/**
 * 답변 대기 질문 목록 수집.
 * keyword가 있으면 지식인 검색 결과(답변 대기)에서, 없으면 전체 대기 목록에서 수집.
 * account가 있으면 해당 세션/프록시로, 없으면 기본 세션으로 수집(로그인 불필요).
 * limit이 있으면 그 개수만큼 모이도록 페이지를 넘겨가며 수집.
 * maxPages > 1이면 하단 페이지 번호를 눌러가며 여러 페이지를 모음.
 */
export async function collectQuestions(opts: {
  keyword?: string;
  account?: AccountProxy;
  maxPages?: number;
  limit?: number;
  /** 이미 수집한 질문인지 판별 — 있으면 목표 개수에 세지 않고 다음 페이지에서 더 찾는다 */
  isNew?: (kinKey: string) => boolean;
}): Promise<CollectedQuestion[]> {
  const ses = opts.account
    ? await getAccountSession(opts.account)
    : session.fromPartition('persist:kin-collect');
  if (!opts.account) applySessionSpoof(ses); // 수집 세션도 크롬으로 위장 (account면 getAccountSession에서 이미 적용)

  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: { session: ses, offscreen: false },
  });
  if (opts.account) bindWindowAccount(win, opts.account.id);
  await hardenWindow(win);

  try {
    // 항상 questionList 페이지의 '답변 대기 질문' 위젯을 사용.
    // 키워드가 있으면 위젯 내 검색창에 입력(URL 안 바뀜) → 최신순 정렬 → 목록 수집.
    await win.loadURL(QUESTION_LIST_URL);
    await humanDelay(2500, 3800); // 목록 렌더 대기

    // 먼저 '답변을 기다리는 질문' 탭 활성화 (로그인 시 기본이 관심질문이라 필수)
    await win.webContents.executeJavaScript(ACTIVATE_TAB_JS).catch(() => false);
    await humanDelay(1500, 2500);

    if (opts.keyword) {
      await win.webContents.executeJavaScript(searchInPageJS(opts.keyword)).catch(() => false);
      await humanDelay(2800, 3800); // 검색 결과 AJAX 대기
      await win.webContents.executeJavaScript(SORT_RECENT_JS).catch(() => false);
      await humanDelay(2200, 3200); // 최신순 재정렬 대기
    }
    await win.webContents.executeJavaScript('window.scrollBy(0, 500);').catch(() => {});
    await humanDelay(600, 1200);

    // limit이 있으면 '신규' 질문을 그만큼 채우도록 최대 20페이지까지 넘겨가며 수집.
    // 없으면 maxPages(기본 1)만큼만 수집.
    const pageCap = opts.limit ? 20 : opts.maxPages ?? 1;
    const result = await scrapePagesInWin(win, pageCap, opts.limit, opts.isNew);
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
): Promise<{ title?: string; body?: string; askedAt?: string }> {
  try {
    const res = await fetch(normalizeKinUrl(url), {
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
    // 질문 작성일: <span class="blind">작성일</span>2026.07.15
    const askedAt =
      pick(/작성일<\/span>\s*([0-9.]{8,}(?:\s*[0-9:]+)?)/i) ||
      pick(/작성일[^0-9]{0,20}(20\d\d\.\s?\d\d?\.\s?\d\d?\.?[^<]*)/i);
    return {
      title: title || undefined,
      body: body || undefined,
      askedAt: askedAt || undefined,
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
  bindWindowAccount(win, opts.account.id);
  await hardenWindow(win);

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
  bindWindowAccount(win, acc.id);
  await hardenWindow(win);

  // 로그인 진행 중 주기적으로, 그리고 창 닫을 때 쿠키를 영구 저장
  const timer = setInterval(() => {
    persistNaverCookies(ses).catch(() => {});
  }, 5000);
  win.on('closed', () => {
    clearInterval(timer);
    persistNaverCookies(ses).catch(() => {});
  });

  // 실패해도 예외로 던지지 않는다 — did-fail-load가 창에 원인을 보여준다(흰 화면 방지)
  await win.loadURL('https://nid.naver.com/nidlogin.login').catch(() => {});
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
    // '답변을 기다리는 질문' 탭 활성화 (관심질문 아님)
    await win.webContents.executeJavaScript(ACTIVATE_TAB_JS).catch(() => false);
    await humanDelay(1400, 2400);
    // 무조건 최신순 유지 — 일상 경로도 최신순으로 정렬 (버튼 없으면 no-op)
    await win.webContents.executeJavaScript(SORT_RECENT_JS).catch(() => false);
    await humanDelay(1400, 2200);
    return true;
  } catch {
    return false;
  }
}

/** '답변을 기다리는 질문' 목록에서 질문 추출 (JS 렌더링되므로 실제 창에서 스크랩).
 *  maxPages > 1이면 하단 페이지 번호를 눌러가며 여러 페이지를 모음. */
export async function autoScrapeWaitingList(win: BrowserWindow, maxPages = 1): Promise<CollectedQuestion[]> {
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

  // '답변 대기 질문' 위젯에서 1..maxPages 페이지를 돌며 추출 (검증된 공통 스크래퍼)
  return scrapePagesInWin(win, maxPages);
}

/** 현재 화면에 표시된 '그 페이지'의 질문만 추출 (페이지 이동 없음).
 *  지연 페이징용: 페이지1을 보고 답할 게 있으면 여기서 끝, 없을 때만 다음으로 넘긴다. */
export async function autoScrapeCurrentPage(win: BrowserWindow): Promise<CollectedQuestion[]> {
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
  await humanDelay(500, 1100);
  const r = await win.webContents.executeJavaScript(SCRAPE_NOANSWER_JS).catch(() => []);
  return Array.isArray(r) ? r : [];
}

/** 다음 페이지로 한 칸 이동 (번호 있으면 번호, 없으면 '다음'). 더 갈 곳 없으면 false */
export async function autoAdvancePage(win: BrowserWindow, nextNum: number): Promise<boolean> {
  const moved = await win.webContents.executeJavaScript(advancePageJS(nextNum)).catch(() => false);
  if (!moved) return false;
  await humanDelay(2000, 3200); // 페이지 전환 AJAX 대기
  await win.webContents.executeJavaScript('window.scrollBy(0, 400);').catch(() => {});
  await humanDelay(400, 900);
  return true;
}

/** 지식인 검색창에 키워드 검색 → 최신순 정렬 (홍보용) */
export async function autoSearchKeyword(win: BrowserWindow, keyword: string): Promise<boolean> {
  try {
    // questionList '답변 대기 질문' 위젯에서 인페이지 검색 → 최신순 (URL 안 바뀜, 미답변+키워드만).
    await win.loadURL(QUESTION_LIST_URL);
    await humanDelay(2500, 3800);
    // 먼저 '답변을 기다리는 질문' 탭 활성화 (로그인 시 기본이 관심질문)
    await win.webContents.executeJavaScript(ACTIVATE_TAB_JS).catch(() => false);
    await humanDelay(1500, 2500);
    await win.webContents.executeJavaScript(searchInPageJS(keyword)).catch(() => false);
    await humanDelay(2800, 3800); // 검색 AJAX 대기
    await win.webContents.executeJavaScript(SORT_RECENT_JS).catch(() => false);
    await humanDelay(2200, 3200); // 최신순 재정렬 대기
    await win.webContents.executeJavaScript('window.scrollBy(0, 400);').catch(() => {});
    await humanDelay(500, 1000);
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
  const r = await evalJs<{ x: number; y: number } | null>(
    win,
    `
      (function () {
        const big = (el) => { const r = el.getBoundingClientRect(); return r.width > 20 && r.height > 15; };
        // 지식인 답변창은 SmartEditor ONE — contenteditable 속성이 없고 자체 커서를 그린다.
        // 그래서 SE 전용 선택자까지 포함해서 찾는다.
        // 실제 키 입력을 받는 건 contenteditable 요소다. (v0.4.4에서 .se-text-paragraph를
        // 1순위로 바꿨다가 포커스가 안 잡혀 입력이 전부 실패했음 — 성공하던 순서로 복구)
        const SEL = [
          '[contenteditable="true"]',
          '.se-text-paragraph',
          '.se-module-text',
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

        // 1순위: 모든 프레임에서 contenteditable 을 먼저 찾는다.
        // (지식인 SmartEditor의 실제 입력 대상은 iframe 안의 body[contenteditable]이며
        //  크기가 0이거나 화면 밖일 수 있으므로 크기 필터를 적용하면 안 된다)
        let target = null, offX = 0, offY = 0, doc = document;
        const topCE = document.querySelector('[contenteditable="true"]');
        if (topCE) target = topCE;
        if (!target) {
          for (const f of document.querySelectorAll('iframe')) {
            try {
              const d = f.contentDocument; if (!d) continue;
              const ce = d.querySelector('[contenteditable="true"]')
                || ((d.body && d.body.isContentEditable) ? d.body : null);
              if (ce) {
                target = ce; doc = d;
                const fr = f.getBoundingClientRect(); offX = fr.left; offY = fr.top;
                try { f.contentWindow.focus(); } catch (e) {}
                try { ce.focus(); } catch (e) {}
                break;
              }
            } catch (e) {}
          }
        }
        // 2순위: contenteditable 이 없으면 SmartEditor 시각 요소
        if (!target) target = findIn(document);
        if (!target) return null;

        // 클릭 좌표는 '보이는' 편집영역 기준으로 잡는다 (실제 입력 대상이 숨겨져 있을 수 있음)
        let clickEl = document.querySelector('.se-text-paragraph, .se-module-text, .se-section-text');
        if (!clickEl || clickEl.getBoundingClientRect().height < 5) clickEl = null;

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

        // 보이는 편집영역이 있으면 그 좌표를, 없으면 대상 요소 좌표를 클릭 지점으로
        if (clickEl) {
          const c = clickEl.getBoundingClientRect();
          return {
            x: Math.round(c.left + Math.min(Math.max(c.width / 2, 30), 220)),
            y: Math.round(c.top + Math.min(Math.max(c.height / 2, 10), 30)),
          };
        }
        const b = target.getBoundingClientRect();
        return {
          x: Math.round(offX + b.left + Math.min(Math.max(b.width / 2, 30), 220)),
          y: Math.round(offY + b.top + Math.min(Math.max(b.height / 3, 15), 50)),
        };
      })();
    `,
    null,
  );
  return r && typeof r.x === 'number' ? r : null;
}

/** 에디터 안 글자 수 (입력 성공 검증용) — SmartEditor(.__se-node) 포함 */
async function editorTextLength(win: BrowserWindow): Promise<number> {
  return await evalJs<number>(
    win,
    `
      (function () {
        // 가장 확실한 신호: SmartEditor는 입력칸이 비면 .se-is-empty 를 붙이고, 글이 들어가면 뗀다.
        const unit = document.querySelector('.se-module-text.__se-unit')
          || document.querySelector('.se-module-text');
        if (unit) return unit.classList.contains('se-is-empty') ? 0 : 1;

        // SmartEditor 안내문(.se-placeholder)은 실제 입력이 아니므로 반드시 제외한다.
        const textOf = (el) => {
          if (!el) return 0;
          const clone = el.cloneNode(true);
          clone.querySelectorAll('.se-placeholder, .__se_placeholder').forEach((p) => p.remove());
          return (clone.innerText || clone.textContent || '').replace(/\\u200B/g, '').trim().length;
        };
        const readIn = (root) => {
          // 표시해둔 답변칸이 있으면 그것만 측정 (질문 본문 오염 방지)
          const marked = root.querySelector('[data-kin-editor="1"]');
          if (marked) return textOf(marked);
          // 입력된 실제 텍스트는 .__se-node 안에 들어감 (안내문 span 은 제외됨)
          const se = root.querySelectorAll('.__se-node');
          if (se.length) {
            let n = 0;
            se.forEach((x) => { n += textOf(x); });
            return n;
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
    0,
  );
}

/**
 * 실제 키보드 입력으로 사람처럼 타이핑.
 * (execCommand는 iframe 안에서 커서가 안 잡히면 조용히 실패하므로, 진짜 키 이벤트를 보낸다)
 */
/** SmartEditor 커서가 실제로 잡혔는지 (깜빡이는 캐럿 또는 포커스된 편집영역) */
async function caretActive(win: BrowserWindow): Promise<boolean> {
  return await evalJs<boolean>(
    win,
    `
      (function () {
        // 가장 정확한 신호: 선택영역이 .se-is-blurred 면 포커스가 풀린 것 (se-is-focused 는 잔여 클래스라 못 믿음)
        const sel = document.querySelector('.se-selection');
        if (sel) return !sel.classList.contains('se-is-blurred');
        if (document.querySelector('.se-caret.se-is-caret-blinking')) return true;
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
    false,
  );
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
    // 창과 웹콘텐츠 모두 포커스를 확실히 준 뒤 클릭해야 에디터가 blur 상태로 남지 않음
    if (!win.isVisible()) win.show();
    win.focus();
    win.webContents.focus();
    await humanDelay(250, 500);
    click(pt.x, pt.y);
  } catch {
    // ignore
  }
  await humanDelay(500, 1000);

  // 포커스가 안 잡혔으면 지점을 바꿔가며 재시도
  let caret = await caretActive(win);
  for (let i = 0; i < 3 && !caret; i++) {
    try {
      win.webContents.focus();
    } catch {
      // ignore
    }
    click(pt.x, pt.y + i * 18);
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
  const win = new BrowserWindow({
    show: true,
    width: 1240,
    height: 920,
    title: `완전자동 · ${acc.naverId}`,
    webPreferences: { session: ses },
  });
  bindWindowAccount(win, acc.id);
  await hardenWindow(win);
  return win;
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
/** loadURL에 시간 제한 — 프록시/네트워크가 멈춰도 무한 대기하지 않도록. 초과 시 로딩 중단 후 에러. */
async function loadUrlSafe(win: BrowserWindow, url: string, ms = 35000): Promise<void> {
  await Promise.race([
    win.loadURL(url),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('페이지 로딩 시간 초과')), ms)),
  ]).catch((e: unknown) => {
    try {
      win.webContents.stop();
    } catch {
      // ignore
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (/ERR_ABORTED/i.test(msg)) return; // 정상적인 로딩 취소는 무시
    throw e;
  });
}

export async function autoOpenAndAnswer(
  win: BrowserWindow,
  url: string,
  answer: string,
  submit: boolean,
  onStep?: (s: string) => void,
): Promise<{ typed: boolean; submitted: boolean; error?: string }> {
  const step = (s: string) => {
    try {
      onStep?.(s);
    } catch {
      // ignore
    }
  };
  try {
    step('질문 페이지 여는 중');
    await loadUrlSafe(win, normalizeKinUrl(url));
    await humanDelay(1800, 3400); // 질문 읽는 시간

    // FAQ 질문(권한 있는 계정만 답변 가능)이면 건너뜀.
    // 제목 상단의 작은 'FAQ' 뱃지를 감지 (푸터 등 다른 곳의 FAQ 링크와 구분: 상단+작은 것만).
    const isFaq = await win.webContents
      .executeJavaScript(
        `
        (function () {
          const els = document.querySelectorAll('span, em, i, strong, b, a, div');
          for (const e of els) {
            if (e.children.length > 0) continue;
            if ((e.textContent || '').trim() !== 'FAQ') continue;
            const r = e.getBoundingClientRect();
            if (r.top >= 0 && r.top < 500 && r.width > 0 && r.width < 90 && r.height > 0 && r.height < 60) return true;
          }
          return false;
        })();
      `,
      )
      .catch(() => false);
    if (isFaq) {
      return { typed: false, submitted: false, error: 'FAQ 질문(권한 필요) — 건너뜀' };
    }

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
    step('답변 버튼 클릭');
    const opened = await evalJs<boolean>(
      win,
      `
        (function () {
          const b = document.querySelector('button._answerWriteButton, .endAnswerButton._answerWriteButton, ._scrollToEditor');
          if (b) { b.click(); return true; }
          return false;
        })();
      `,
      false,
    );
    if (!opened) {
      // 왜 버튼이 없는지 진단 정보를 남긴다 (로그인 풀림 / 마감된 질문 / 페이지 이상 구분)
      const d = await evalJs<{ loggedIn: boolean; closed: boolean; blocked: boolean; head: string } | null>(
        win,
        `
        (function () {
          const t = (document.body ? (document.body.innerText || '') : '').slice(0, 3000);
          return {
            loggedIn: !!document.querySelector('a[href*="logout"], .gnb_my, #gnb_logout_button, .MyView-module__link_login'),
            closed: /마감된 질문|종료된 질문|답변을 등록할 수 없|채택이 완료|질문이 삭제/.test(t),
            blocked: /보호조치|이용이 제한|로그인이 필요|비정상적인 접근/.test(t),
            head: t.replace(/\\s+/g, ' ').trim().slice(0, 80)
          };
        })();
      `,
        null,
      );
      const why = !d
        ? '페이지 확인 불가'
        : d.blocked
          ? '계정 제한/로그인 필요 상태'
          : d.closed
            ? '마감·삭제된 질문(답변 불가)'
            : !d.loggedIn
              ? '로그인 풀림'
              : `버튼 없음 (화면: ${d.head})`;
      return { typed: false, submitted: false, error: `'답변' 버튼 없음 — ${why}` };
    }
    await humanDelay(1200, 2200);

    // 에디터 대기
    step('입력칸 열림 대기');
    let hasEditor = false;
    for (let i = 0; i < 10; i++) {
      hasEditor = await evalJs<boolean>(win, HAS_EDITOR_JS, false);
      if (hasEditor) break;
      await humanDelay(600, 1100);
    }
    if (!hasEditor) return { typed: false, submitted: false, error: '답변 입력칸이 열리지 않음' };

    await humanDelay(1000, 2200);

    // 1순위: 실제 키보드 입력 (iframe/SmartEditor에서 확실히 동작)
    step('본문 입력 중');
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
    step('등록 버튼 클릭');
    const submitted = await evalJs<boolean>(
      win,
      `
        (function () {
          const b = document.querySelector('#answerRegisterButton, button._answerRegisterButton');
          if (b) { b.click(); return true; }
          return false;
        })();
      `,
      false,
    );
    if (!submitted) return { typed: true, submitted: false, error: "'등록' 버튼을 찾지 못함" };
    await humanDelay(1500, 2600); // 등록 처리 대기
    return { typed: true, submitted: true };
  } catch (e: unknown) {
    return { typed: false, submitted: false, error: e instanceof Error ? e.message : String(e) };
  }
}
