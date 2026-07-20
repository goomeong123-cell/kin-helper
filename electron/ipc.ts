import { app, BrowserWindow, type IpcMain } from 'electron';
import { getDb } from './db';
import { generateAnswer } from './claude';
import {
  collectQuestions,
  fetchQuestionDetail,
  openAnswerWindow,
  openLoginWindow,
  persistAccountLogin,
  openAutoWindow,
  autoScrapeList,
  autoOpenAndAnswer,
  autoIsLoggedIn,
  autoGoToKinAnswerList,
  autoScrapeWaitingList,
  autoSearchKeyword,
  type AccountProxy,
  type PostMode,
} from './naver';

const DEFAULT_DAILY_PROMPT =
  '당신은 특정 분야에 경험이 있는 평범한 사람입니다. 네이버 지식인에서 질문에 답합니다. ' +
  '전문성은 있되 절대 딱딱하거나 AI 같지 않게, 실제 사람이 편하게 도와주듯 자연스럽게 답하세요. ' +
  '과장·상투구·불필요한 인사말을 피하고, 질문에 실질적으로 도움이 되는 내용을 담으세요.';

const DEFAULT_PROMO_PROMPT =
  '당신은 특정 분야에 경험이 있는 평범한 사람입니다. 네이버 지식인 질문에 진짜 도움이 되는 답변을 씁니다. ' +
  '답변의 90%는 순수하게 도움되는 내용이어야 하고, 정말 맥락에 맞을 때에만 아래 제품을 경험담처럼 딱 한 번 자연스럽게 언급하세요. ' +
  '광고 티, 과장, 링크 나열, 상투구는 절대 금지. 억지스러우면 제품을 아예 빼세요. 사람이 직접 쓴 것처럼 편하게.';

function accountToProxy(a: any): AccountProxy {
  return {
    id: a.id,
    naverId: a.naver_id,
    proxyHost: a.proxy_host,
    proxyPort: a.proxy_port,
    proxyUser: a.proxy_user,
    proxyPass: a.proxy_pass,
  };
}

export function registerIpc(ipcMain: IpcMain) {
  const db = () => getDb();

  /* ---------- 브랜드 ---------- */
  ipcMain.handle('brands:list', () =>
    db().prepare('SELECT * FROM brands ORDER BY created_at ASC').all(),
  );
  ipcMain.handle('brands:create', (_e, name: string) => {
    const info = db().prepare('INSERT INTO brands (name) VALUES (?)').run([name.trim()]);
    return db().prepare('SELECT * FROM brands WHERE id = ?').get([info.lastInsertRowid]);
  });
  ipcMain.handle(
    'brands:update',
    (_e, id: number, fields: { name?: string; promo_text?: string; promo_image?: string; system_prompt?: string }) => {
      const cur = db().prepare('SELECT * FROM brands WHERE id = ?').get([id]) as any;
      if (!cur) return null;
      const next = {
        name: fields.name ?? cur.name,
        promo_text: fields.promo_text ?? cur.promo_text,
        promo_image: fields.promo_image ?? cur.promo_image,
        system_prompt: fields.system_prompt ?? cur.system_prompt,
      };
      db()
        .prepare('UPDATE brands SET name=?, promo_text=?, promo_image=?, system_prompt=? WHERE id=?')
        .run([next.name, next.promo_text, next.promo_image, next.system_prompt, id]);
      return db().prepare('SELECT * FROM brands WHERE id = ?').get([id]);
    },
  );
  ipcMain.handle('brands:remove', (_e, id: number) => {
    db().prepare('DELETE FROM brands WHERE id = ?').run([id]);
    return true;
  });

  /* ---------- 키워드 ---------- */
  ipcMain.handle('keywords:list', (_e, brandId: number) =>
    db().prepare('SELECT * FROM keywords WHERE brand_id = ? ORDER BY created_at ASC').all([brandId]),
  );
  ipcMain.handle('keywords:create', (_e, brandId: number, keyword: string) => {
    db()
      .prepare('INSERT OR IGNORE INTO keywords (brand_id, keyword) VALUES (?, ?)')
      .run([brandId, keyword.trim()]);
    return db()
      .prepare('SELECT * FROM keywords WHERE brand_id = ? ORDER BY created_at ASC')
      .all([brandId]);
  });
  ipcMain.handle('keywords:remove', (_e, id: number) => {
    db().prepare('DELETE FROM keywords WHERE id = ?').run([id]);
    return true;
  });

  /* ---------- 계정 + 프록시 ---------- */
  ipcMain.handle('accounts:list', () =>
    db().prepare('SELECT * FROM accounts ORDER BY created_at ASC').all(),
  );
  ipcMain.handle('accounts:create', (_e, naverId: string) => {
    const id = (naverId || '').trim();
    if (!id) return { ok: false, error: '네이버 ID를 입력하세요.' };
    const dup = db().prepare('SELECT id FROM accounts WHERE naver_id = ?').get([id]);
    if (dup) return { ok: false, error: '이미 등록된 ID입니다.' };
    try {
      const info = db().prepare('INSERT INTO accounts (naver_id) VALUES (?)').run([id]);
      const account = db()
        .prepare('SELECT * FROM accounts WHERE id = ?')
        .get([info.lastInsertRowid]);
      return { ok: true, account };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '계정 추가에 실패했습니다.' };
    }
  });
  ipcMain.handle('accounts:update', (_e, id: number, fields: Record<string, any>) => {
    const cur = db().prepare('SELECT * FROM accounts WHERE id = ?').get([id]) as any;
    if (!cur) return null;
    const cols = [
      'naver_id',
      'memo',
      'daily_limit',
      'status',
      'proxy_host',
      'proxy_port',
      'proxy_user',
      'proxy_pass',
    ];
    const next: Record<string, any> = {};
    for (const c of cols) next[c] = fields[c] ?? cur[c];
    db()
      .prepare(
        `UPDATE accounts SET naver_id=?, memo=?, daily_limit=?, status=?, proxy_host=?, proxy_port=?, proxy_user=?, proxy_pass=? WHERE id=?`,
      )
      .run([
        next.naver_id,
        next.memo,
        next.daily_limit,
        next.status,
        next.proxy_host,
        next.proxy_port,
        next.proxy_user,
        next.proxy_pass,
        id,
      ]);
    return db().prepare('SELECT * FROM accounts WHERE id = ?').get([id]);
  });
  ipcMain.handle('accounts:remove', (_e, id: number) => {
    db().prepare('DELETE FROM accounts WHERE id = ?').run([id]);
    return true;
  });
  ipcMain.handle('accounts:login', async (_e, id: number) => {
    const a = db().prepare('SELECT * FROM accounts WHERE id = ?').get([id]) as any;
    if (!a) return { ok: false, error: '계정을 찾을 수 없습니다.' };
    // IP 노출 방지: 프록시 없으면 로그인 창을 열지 않음
    if (!a.proxy_host || !a.proxy_port) {
      return {
        ok: false,
        error: '프록시가 없어 로그인 창을 열지 않았습니다. 실제 IP 노출을 막기 위해 먼저 프록시를 등록하세요.',
      };
    }
    await openLoginWindow(accountToProxy(a));
    return { ok: true };
  });

  /* ---------- 질문 수집 ---------- */
  ipcMain.handle(
    'questions:collect',
    async (_e, opts: { brandId?: number; accountId?: number }) => {
      let account: AccountProxy | undefined;
      if (opts.accountId) {
        const a = db().prepare('SELECT * FROM accounts WHERE id = ?').get([opts.accountId]) as any;
        if (a) account = accountToProxy(a);
      }

      const keywords: Array<{ keyword: string; brandId: number | null }> = [];
      if (opts.brandId) {
        const ks = db()
          .prepare('SELECT * FROM keywords WHERE brand_id = ?')
          .all([opts.brandId]) as any[];
        for (const k of ks) keywords.push({ keyword: k.keyword, brandId: opts.brandId });
      }
      if (keywords.length === 0) keywords.push({ keyword: '', brandId: opts.brandId ?? null });

      let inserted = 0;
      for (const k of keywords) {
        const found = await collectQuestions({ keyword: k.keyword || undefined, account });
        const ins = db().prepare(
          `INSERT OR IGNORE INTO questions (kin_key, title, url, content, category, matched_brand_id, matched_keyword)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const q of found) {
          const r = ins.run([
            q.kinKey,
            q.title,
            q.url,
            q.content || null,
            q.category,
            k.brandId,
            k.keyword || null,
          ]);
          if (r.changes > 0) inserted++;
        }
      }
      return { ok: true, inserted };
    },
  );

  ipcMain.handle('questions:list', (_e, opts: { status?: string; brandId?: number }) => {
    let sql = 'SELECT * FROM questions';
    const cond: string[] = [];
    const params: any[] = [];
    if (opts?.status) {
      cond.push('status = ?');
      params.push(opts.status);
    }
    if (opts?.brandId) {
      cond.push('matched_brand_id = ?');
      params.push(opts.brandId);
    }
    if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
    sql += ' ORDER BY collected_at DESC LIMIT 200';
    return db().prepare(sql).all(params);
  });

  ipcMain.handle('questions:setStatus', (_e, id: number, status: string) => {
    db().prepare('UPDATE questions SET status = ? WHERE id = ?').run([status, id]);
    return true;
  });

  /* ---------- 답변 생성 (Claude) ---------- */
  const getS = (k: string) =>
    (db().prepare('SELECT value FROM settings WHERE key = ?').get([k]) as any)?.value || '';

  // 질문 하나에 대한 답변 초안 생성 (단건/전체 공용)
  async function doGenerate(questionId: number, brandArg?: number, includePromo?: boolean) {
    const q = db().prepare('SELECT * FROM questions WHERE id = ?').get([questionId]) as any;
    if (!q) return { ok: false, error: '질문을 찾을 수 없습니다.' };

    const brandId = brandArg ?? q.matched_brand_id;
    let brand: any = null;
    if (brandId) brand = db().prepare('SELECT * FROM brands WHERE id = ?').get([brandId]);

    // 홍보 포함이 켜져 있고 브랜드에 홍보문구가 있을 때만 홍보 모드
    const usePromo = !!(includePromo && brand?.promo_text);
    let promoText: string | undefined;
    let systemPrompt: string;
    if (usePromo) {
      promoText = brand.promo_text;
      systemPrompt = getS('promo_prompt') || DEFAULT_PROMO_PROMPT;
    } else {
      // 일상글: 공통 일상 프롬프트 (구버전 global_prompt 값도 호환)
      systemPrompt = getS('daily_prompt') || getS('global_prompt') || DEFAULT_DAILY_PROMPT;
    }

    // 상세 페이지에서 질문 전체 본문을 읽어 답변 품질을 높임 (목록 스니펫은 잘림)
    let questionTitle = q.title;
    let questionBody = q.content || '';
    try {
      const detail = await fetchQuestionDetail(q.url);
      if (detail.title) questionTitle = detail.title;
      if (detail.body && detail.body.length > questionBody.length) questionBody = detail.body;
    } catch {
      // 상세 로딩 실패 시 목록 스니펫으로 진행
    }

    const result = await generateAnswer({ systemPrompt, questionTitle, questionBody, promoText });
    if (!result.ok) return result;

    const info = db()
      .prepare(
        `INSERT INTO answers (question_id, brand_id, body, promo_included, mode, status)
         VALUES (?, ?, ?, ?, 'manual', 'draft')`,
      )
      .run([questionId, brandId ?? null, result.text, promoText ? 1 : 0]);
    const answer = db().prepare('SELECT * FROM answers WHERE id = ?').get([info.lastInsertRowid]);
    return { ok: true, answer };
  }

  ipcMain.handle(
    'answers:generate',
    (_e, opts: { questionId: number; brandId?: number; includePromo?: boolean }) =>
      doGenerate(opts.questionId, opts.brandId, opts.includePromo),
  );

  // 전체 답변 생성 — 메인 프로세스에서 순차 진행하므로 탭을 옮겨도 멈추지 않음.
  // 홍보 포함 여부는 홍보 비율(promo_ratio)로 자동 결정. 이미 초안 있으면 건너뜀.
  let generatingAll = false;
  ipcMain.handle('answers:generateAll', async (_e, questionIds: number[]) => {
    if (generatingAll) return { ok: false, error: '이미 전체 생성이 진행 중입니다.' };
    generatingAll = true;
    const ratio = Number(getS('promo_ratio') || '20');
    let done = 0;
    let failed = 0;
    try {
      for (const qid of questionIds) {
        const existing = db()
          .prepare("SELECT id FROM answers WHERE question_id = ? AND status='draft' LIMIT 1")
          .get([qid]);
        if (existing) {
          done++;
          continue;
        }
        const q = db().prepare('SELECT * FROM questions WHERE id = ?').get([qid]) as any;
        if (!q) {
          failed++;
          continue;
        }
        let includePromo = false;
        if (q.matched_brand_id) {
          const b = db()
            .prepare('SELECT promo_text FROM brands WHERE id = ?')
            .get([q.matched_brand_id]) as any;
          if (b?.promo_text) includePromo = Math.random() * 100 < ratio;
        }
        const r = await doGenerate(qid, q.matched_brand_id ?? undefined, includePromo);
        if (r.ok) done++;
        else failed++;
      }
    } finally {
      generatingAll = false;
    }
    return { ok: true, done, failed };
  });

  ipcMain.handle('answers:generateAllStatus', () => ({ running: generatingAll }));

  // 각 질문의 최신 초안 (탭 이동 후에도 답변이 유지되도록 로드용)
  ipcMain.handle('answers:drafts', () =>
    db()
      .prepare(
        `SELECT a.* FROM answers a
         JOIN (SELECT question_id, MAX(id) AS mid FROM answers WHERE status='draft' GROUP BY question_id) m
           ON a.id = m.mid`,
      )
      .all(),
  );

  ipcMain.handle('answers:listForQuestion', (_e, questionId: number) =>
    db()
      .prepare('SELECT * FROM answers WHERE question_id = ? ORDER BY created_at DESC')
      .all([questionId]),
  );

  ipcMain.handle('answers:updateBody', (_e, id: number, body: string) => {
    db().prepare('UPDATE answers SET body = ? WHERE id = ?').run([body, id]);
    return db().prepare('SELECT * FROM answers WHERE id = ?').get([id]);
  });

  ipcMain.handle('answers:history', () =>
    db()
      .prepare(
        `SELECT a.*, q.title AS question_title, q.url AS question_url, b.name AS brand_name, acc.naver_id AS account_naver_id
         FROM answers a
         LEFT JOIN questions q ON q.id = a.question_id
         LEFT JOIN brands b ON b.id = a.brand_id
         LEFT JOIN accounts acc ON acc.id = a.account_id
         ORDER BY a.created_at DESC LIMIT 200`,
      )
      .all(),
  );

  /* ---------- 답변 등록 ---------- */
  ipcMain.handle(
    'answers:post',
    async (_e, opts: { answerId: number; accountId: number; mode: PostMode }) => {
      const a = db().prepare('SELECT * FROM answers WHERE id = ?').get([opts.answerId]) as any;
      if (!a) return { ok: false, error: '답변을 찾을 수 없습니다.' };
      const q = db().prepare('SELECT * FROM questions WHERE id = ?').get([a.question_id]) as any;
      const acc = db().prepare('SELECT * FROM accounts WHERE id = ?').get([opts.accountId]) as any;
      if (!q || !acc) return { ok: false, error: '질문 또는 계정 정보를 찾을 수 없습니다.' };
      // IP 노출 방지: 프록시 없으면 등록 창을 열지 않음
      if (!acc.proxy_host || !acc.proxy_port) {
        return {
          ok: false,
          error: '이 계정에 프록시가 없어 등록 창을 열지 않았습니다. 실제 IP 노출을 막기 위해 먼저 프록시를 등록하세요.',
        };
      }

      const result = await openAnswerWindow({
        account: accountToProxy(acc),
        question: { url: q.url, title: q.title },
        answer: a.body,
        mode: opts.mode,
      });

      const posted = result.ok && opts.mode === 'auto' && result.needsHuman === false;
      db()
        .prepare('UPDATE answers SET account_id=?, mode=?, status=?, error=?, posted_at=? WHERE id=?')
        .run([
          opts.accountId,
          opts.mode,
          posted ? 'posted' : a.status,
          result.error ?? null,
          posted ? new Date().toISOString() : a.posted_at,
          opts.answerId,
        ]);
      if (posted) {
        db().prepare("UPDATE questions SET status='answered' WHERE id=?").run([a.question_id]);
      }
      return result;
    },
  );

  ipcMain.handle('answers:markPosted', (_e, answerId: number, accountId?: number) => {
    const a = db().prepare('SELECT * FROM answers WHERE id = ?').get([answerId]) as any;
    if (!a) return { ok: false };
    db()
      .prepare("UPDATE answers SET status='posted', account_id=?, posted_at=? WHERE id=?")
      .run([accountId ?? a.account_id, new Date().toISOString(), answerId]);
    db().prepare("UPDATE questions SET status='answered' WHERE id=?").run([a.question_id]);
    return { ok: true };
  });

  /* ---------- 설정 ---------- */
  ipcMain.handle('settings:get', (_e, key: string) => {
    const row = db().prepare('SELECT value FROM settings WHERE key = ?').get([key]) as any;
    return row?.value ?? null;
  });
  ipcMain.handle('settings:set', (_e, key: string, value: string) => {
    db()
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run([key, value]);
    return true;
  });

  /* ---------- 앱 정보 ---------- */
  ipcMain.handle('app:version', () => app.getVersion());

  // 모든 계정의 로그인 쿠키를 디스크에 영구 저장 (앱 종료 전 호출 → 재시작/업데이트 후 로그인 유지)
  const persistAllLogins = async () => {
    try {
      const accs = db().prepare('SELECT * FROM accounts').all() as any[];
      for (const a of accs) {
        await persistAccountLogin(accountToProxy(a)).catch(() => 0);
      }
    } catch {
      // ignore
    }
  };
  ipcMain.handle('accounts:persistLogins', persistAllLogins);
  app.on('before-quit', () => {
    void persistAllLogins();
  });

  /* ---------- 완전자동 (Autopilot) ---------- */
  let autoRunning = false;
  let autoStop = false;
  let autoStatus = '대기';
  let autoCount = 0;
  let autoWin: BrowserWindow | null = null;
  let autoNextResolve: (() => void) | null = null;
  const autoLog: string[] = [];

  // 상태를 갱신하면서 로그로도 남김 (어디서 멈추는지 화면에서 바로 보이게)
  const pushLog = (msg: string) => {
    autoStatus = msg;
    const t = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    autoLog.unshift(`[${t}] ${msg}`);
    if (autoLog.length > 12) autoLog.pop();
  };

  const sleepRnd = (a: number, b: number) =>
    new Promise((r) => setTimeout(r, a + Math.floor(Math.random() * (b - a))));

  // 남은 시간을 초 단위로 보여주며 대기 (중지 누르면 즉시 빠져나옴)
  const waitWithCountdown = async (ms: number) => {
    const end = Date.now() + ms;
    while (!autoStop && Date.now() < end) {
      const remain = Math.max(0, Math.round((end - Date.now()) / 1000));
      const m = Math.floor(remain / 60);
      const s = remain % 60;
      autoStatus = `다음 질문까지 ${m > 0 ? `${m}분 ` : ''}${s}초 대기…`;
      await new Promise((r) => setTimeout(r, 1000));
    }
  };

  ipcMain.handle('auto:status', () => ({
    running: autoRunning,
    status: autoStatus,
    count: autoCount,
    waiting: !!autoNextResolve,
    log: autoLog.slice(),
  }));

  ipcMain.handle('auto:next', () => {
    if (autoNextResolve) {
      const r = autoNextResolve;
      autoNextResolve = null;
      r();
    }
    return true;
  });

  ipcMain.handle('auto:stop', () => {
    autoStop = true;
    if (autoNextResolve) {
      const r = autoNextResolve;
      autoNextResolve = null;
      r();
    }
    if (autoWin && !autoWin.isDestroyed()) {
      try {
        autoWin.close();
      } catch {
        // ignore
      }
    }
    return true;
  });

  ipcMain.handle('auto:start', async (_e, opts: { accountId: number; submit: boolean }) => {
    if (autoRunning) return { ok: false, error: '이미 실행 중입니다.' };
    const acc = db().prepare('SELECT * FROM accounts WHERE id = ?').get([opts.accountId]) as any;
    if (!acc) return { ok: false, error: '계정을 찾을 수 없습니다.' };
    if (!acc.proxy_host || !acc.proxy_port) {
      return { ok: false, error: '프록시 없는 계정은 완전자동을 실행할 수 없습니다.' };
    }
    autoRunning = true;
    autoStop = false;
    autoCount = 0;
    pushLog('시작 중…');
    runAutopilot(opts.accountId, opts.submit)
      .catch((e) => {
        pushLog('오류: ' + (e instanceof Error ? e.message : String(e)));
      })
      .finally(() => {
        autoRunning = false;
        autoNextResolve = null;
        if (autoWin && !autoWin.isDestroyed()) {
          try {
            autoWin.close();
          } catch {
            // ignore
          }
        }
        autoWin = null;
      });
    return { ok: true };
  });

  async function runAutopilot(accountId: number, submit: boolean) {
    const acc = db().prepare('SELECT * FROM accounts WHERE id = ?').get([accountId]) as any;
    const proxy = accountToProxy(acc);
    const ratio = Number(getS('promo_ratio') || '20');
    const dailyLimit = acc.daily_limit || 5;

    autoWin = await openAutoWindow(proxy);
    autoWin.on('closed', () => {
      autoStop = true;
      autoWin = null;
    });

    // 1~2단계: 네이버 접속 후 로그인 상태 확인 (비밀번호 자동입력은 하지 않음)
    pushLog('네이버 접속 · 로그인 상태 확인 중…');
    const login = await autoIsLoggedIn(autoWin);
    if (autoStop) return;
    if (!login.ok) {
      // 오판 가능성이 있으므로 중단하지 않고 일단 진행 — 실제로 안 되면 '답변' 버튼 단계에서 잡힘
      pushLog(`⚠ 로그인 확인 실패 (${login.detail}) — 일단 진행해 봅니다`);
    } else {
      pushLog(`로그인 확인됨 ✓ (${login.detail})`);
    }

    while (!autoStop) {
      if (!autoWin || autoWin.isDestroyed()) break;

      const today = db()
        .prepare(
          "SELECT COUNT(*) n FROM answers WHERE account_id=? AND status='posted' AND date(posted_at)=date('now','localtime')",
        )
        .get([accountId]) as any;
      if ((today?.n || 0) >= dailyLimit) {
        pushLog(`하루 한도(${dailyLimit}) 도달 — 종료`);
        break;
      }

      // 홍보/일상 결정
      let keyword: string | undefined;
      let brandId: number | undefined;
      const wantPromo = Math.random() * 100 < ratio;
      if (wantPromo) {
        const brandsWithPromo = db()
          .prepare("SELECT * FROM brands WHERE promo_text IS NOT NULL AND promo_text != ''")
          .all() as any[];
        if (brandsWithPromo.length) {
          const b = brandsWithPromo[Math.floor(Math.random() * brandsWithPromo.length)];
          const kws = db().prepare('SELECT keyword FROM keywords WHERE brand_id=?').all([b.id]) as any[];
          if (kws.length) {
            keyword = kws[Math.floor(Math.random() * kws.length)].keyword;
            brandId = b.id;
          }
        }
      }
      const isPromo = !!(keyword && brandId);

      let list: Awaited<ReturnType<typeof autoScrapeList>> = [];
      if (isPromo) {
        // 10~11단계: 키워드 검색 → 최신순
        pushLog(`홍보: '${keyword}' 검색 → 최신순`);
        await autoSearchKeyword(autoWin, keyword!);
        if (autoStop || !autoWin || autoWin.isDestroyed()) break;
        list = await autoScrapeWaitingList(autoWin);
      } else {
        // 3~6단계: 네이버 → 지식iN → 답변하기 → '답변을 기다리는 질문'
        pushLog('일상: 지식iN 답변하기 목록으로 이동');
        await autoGoToKinAnswerList(autoWin);
        if (autoStop || !autoWin || autoWin.isDestroyed()) break;
        list = await autoScrapeWaitingList(autoWin);
      }
      pushLog(`질문 ${list.length}개 발견`);
      if (autoStop || !autoWin || autoWin.isDestroyed()) break;

      // 아직 우리가 답변 안 한 질문 고르기
      const fresh = list.find((q) => {
        const row = db().prepare('SELECT status FROM questions WHERE kin_key=?').get([q.kinKey]) as any;
        return !row || row.status !== 'answered';
      });
      if (!fresh) {
        pushLog('새 질문 없음 — 잠시 대기');
        await sleepRnd(15000, 30000);
        continue;
      }

      db()
        .prepare(
          `INSERT OR IGNORE INTO questions (kin_key, title, url, content, category, matched_brand_id, matched_keyword)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run([fresh.kinKey, fresh.title, fresh.url, fresh.content || null, '', brandId ?? null, keyword || null]);
      const qrow = db().prepare('SELECT * FROM questions WHERE kin_key=?').get([fresh.kinKey]) as any;

      // 질문 본문을 실제로 가져왔는지 확인해 로그에 남김
      try {
        const d = await fetchQuestionDetail(fresh.url);
        pushLog(
          `질문 확인: 제목 ${(d.title || fresh.title || '').length}자 / 본문 ${(d.body || fresh.content || '').length}자`,
        );
      } catch {
        // ignore
      }
      pushLog(`답변 생성 중: ${fresh.title.slice(0, 24)}`);
      const gen = (await doGenerate(qrow.id, brandId, isPromo)) as any;
      if (!gen.ok || !gen.answer) {
        pushLog('생성 실패 — 다음');
        await sleepRnd(5000, 10000);
        continue;
      }
      if (autoStop || !autoWin || autoWin.isDestroyed()) break;

      pushLog('사람처럼 답변 작성 중…');
      const res = await autoOpenAndAnswer(autoWin, fresh.url, gen.answer.body, submit);
      if (res.error) {
        pushLog('작성 실패: ' + res.error);
        await sleepRnd(6000, 12000);
        continue;
      }

      if (submit && res.submitted) {
        db()
          .prepare("UPDATE answers SET account_id=?, status='posted', mode='auto', posted_at=? WHERE id=?")
          .run([accountId, new Date().toISOString(), gen.answer.id]);
        db().prepare("UPDATE questions SET status='answered' WHERE id=?").run([qrow.id]);
        autoCount++;
        // 설정된 간격(기본 90~240초) 안에서 랜덤 대기 — 사람처럼 일정하지 않게
        const minS = Math.max(5, Number(getS('auto_min_interval') || '90'));
        const maxS = Math.max(minS, Number(getS('auto_max_interval') || '240'));
        const waitMs = (minS + Math.random() * (maxS - minS)) * 1000;
        pushLog(`등록 완료 (${autoCount}) — 다음까지 약 ${Math.round(waitMs / 1000)}초 대기`);
        await waitWithCountdown(waitMs);
      } else {
        // 관전 모드: 등록 직전 멈춤. 사람이 확인 후 [다음]
        db()
          .prepare("UPDATE answers SET account_id=?, mode='auto' WHERE id=?")
          .run([accountId, gen.answer.id]);
        pushLog('등록 대기 — 브라우저에서 확인·등록 후 [다음]을 누르세요');
        await new Promise<void>((resolve) => {
          autoNextResolve = resolve;
        });
        if (autoStop) break;
        autoCount++;
        await sleepRnd(4000, 10000);
      }
    }
    autoStatus = autoStop ? '중지됨' : autoStatus;
  }
}
