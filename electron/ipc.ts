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
  normalizeKinUrl,
  autoIsLoggedIn,
  autoGoToKinAnswerList,
  autoScrapeWaitingList,
  importCookiesToAccountSession,
  getLastScanCount,
  autoScrapeCurrentPage,
  autoAdvancePage,
  autoSearchKeyword,
  type AccountProxy,
  type PostMode,
} from './naver';
import { loginWithRealChrome, checkProxyExitIp } from './pwlogin';
import {
  getAccountContext,
  closeAccountContext,
  closeAllKinContexts,
  pwIsLoggedIn,
  pwFindQuestion,
  pwAnswerQuestion,
  pwCheckBrowserExitIp,
  pwDetectSuspension,
} from './pwkin';

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

// 제외 키워드 문자열(줄바꿈/쉼표 구분) → 항목 배열
function parseExcludeTerms(raw: any): string[] {
  return String(raw || '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 제목에 제외 키워드가 하나라도 포함되면 true (단순 부분일치, 영문은 대소문자 무시)
function titleExcluded(title: string, terms: string[]): boolean {
  if (!terms.length) return false;
  const hay = String(title || '').toLowerCase();
  return terms.some((t) => hay.includes(t.toLowerCase()));
}

/**
 * 모든 계정 세션의 네이버 로그인 쿠키를 디스크에 영구화한다.
 * 네이버는 사용 중 NID_SES를 '만료 없는 세션 쿠키'로 계속 새로 발급하는데,
 * 그 상태로 앱이 종료(=업데이트 설치)되면 사라져서 다음 실행 때 로그아웃으로 보인다.
 * → 주기적으로, 그리고 업데이트 설치 직전에 호출해 만료일을 붙여 저장한다.
 */
export async function persistAllAccountSessions(): Promise<number> {
  let n = 0;
  try {
    const rows = getDb().prepare('SELECT * FROM accounts').all() as any[];
    for (const a of rows) {
      try {
        n += await persistAccountLogin(accountToProxy(a));
      } catch {
        // 계정 하나 실패해도 나머지는 계속
      }
    }
  } catch {
    // DB 미초기화 등 — 무시
  }
  return n;
}

export function registerIpc(ipcMain: IpcMain) {
  const db = () => getDb();

  // 브랜드 제외 키워드 로드: brandId 지정 시 그 브랜드, 없으면(일상 등) 모든 브랜드 합집합
  const loadExcludeTerms = (brandId?: number | null): string[] => {
    try {
      const rows = brandId
        ? (db().prepare('SELECT exclude_keywords FROM brands WHERE id = ?').all([brandId]) as any[])
        : (db().prepare('SELECT exclude_keywords FROM brands').all() as any[]);
      const terms: string[] = [];
      for (const r of rows) terms.push(...parseExcludeTerms(r.exclude_keywords));
      return Array.from(new Set(terms));
    } catch {
      return [];
    }
  };

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
    (
      _e,
      id: number,
      fields: {
        name?: string;
        promo_text?: string;
        promo_image?: string;
        system_prompt?: string;
        exclude_keywords?: string;
      },
    ) => {
      const cur = db().prepare('SELECT * FROM brands WHERE id = ?').get([id]) as any;
      if (!cur) return null;
      const next = {
        name: fields.name ?? cur.name,
        promo_text: fields.promo_text ?? cur.promo_text,
        promo_image: fields.promo_image ?? cur.promo_image,
        system_prompt: fields.system_prompt ?? cur.system_prompt,
        exclude_keywords: fields.exclude_keywords ?? cur.exclude_keywords,
      };
      db()
        .prepare(
          'UPDATE brands SET name=?, promo_text=?, promo_image=?, system_prompt=?, exclude_keywords=? WHERE id=?',
        )
        .run([next.name, next.promo_text, next.promo_image, next.system_prompt, next.exclude_keywords, id]);
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
    // 로그인은 '진짜 Chrome'(Playwright)으로 한다.
    // Electron 창은 크롬 흉내라 로그인 시점에 봇으로 탐지되기 쉬움 → 로그인만 실물 크롬 사용.
    const accP = accountToProxy(a);
    // 로그인이 확인되는 즉시 앱 세션에 반영한다(창은 계속 열려 있어도 됨).
    let applied = 0;
    const res = await loginWithRealChrome(
      accP,
      (s) => pushLog('[' + a.naver_id + '] ' + s),
      async (cookies) => {
        applied = await importCookiesToAccountSession(accP, cookies);
        pushLog(`[${a.naver_id}] 세션 적용됨 (쿠키 ${applied}개) — 창은 편하게 쓰다가 닫으세요`);
      },
    );
    if (!res.ok || !res.cookies) {
      return { ok: false, error: res.error || '로그인에 실패했습니다.' };
    }
    // 창을 닫을 때 최신 쿠키로 한 번 더 갱신 (로그인 후 더 둘러본 내용까지 반영)
    const n = await importCookiesToAccountSession(accP, res.cookies);
    pushLog(`[${a.naver_id}] 브라우저 종료 — 세션 저장 완료 (쿠키 ${n}개)`);
    return { ok: true };
  });

  // 프록시로 실제 나가는 IP가 고정인지 확인 (로그인 세션이 끊기는 대표 원인 진단)
  ipcMain.handle('accounts:checkProxyIp', async (_e, id: number) => {
    const a = db().prepare('SELECT * FROM accounts WHERE id = ?').get([id]) as any;
    if (!a) return { ok: false, error: '계정을 찾을 수 없습니다.' };
    // 같은 프록시를 여러 계정이 공유하면 그 자체로 네이버가 계정을 묶는다 → 먼저 경고
    try {
      const dup = db()
        .prepare(
          "SELECT naver_id FROM accounts WHERE id != ? AND proxy_host = ? AND proxy_port = ? AND proxy_host IS NOT NULL",
        )
        .all([id, a.proxy_host, a.proxy_port]) as any[];
      if (dup.length) {
        pushLog(
          `[${a.naver_id}] ⚠ 같은 프록시를 쓰는 계정이 또 있습니다: ${dup.map((d) => d.naver_id).join(', ')} — 계정이 서로 묶입니다`,
        );
      }
    } catch {
      // ignore
    }
    pushLog(`[${a.naver_id}] 프록시 IP 확인 중… (약 15초)`);
    const r = await checkProxyExitIp(accountToProxy(a), 6);
    if (!r.ok) {
      pushLog(`[${a.naver_id}] 프록시 IP 확인 실패: ${r.error || ''}`);
      return { ok: false, error: r.error };
    }
    pushLog(
      `[${a.naver_id}] 프록시 IP ${r.stable ? '고정 ✓ ' + r.distinct[0] : '⚠ 변동함: ' + r.distinct.join(', ')}`,
    );
    if (r.anonymous === false) {
      pushLog(
        `[${a.naver_id}] ⚠ 프록시가 흔적 헤더를 붙임: ${(r.leakHeaders || []).map((h) => h.name).join(', ')}`,
      );
    } else if (r.anonymous === true) {
      pushLog(`[${a.naver_id}] 프록시 익명성 정상 ✓ (흔적 헤더 없음)`);
    }
    if (typeof r.clockSkewSec === 'number' && Math.abs(r.clockSkewSec) > 60) {
      pushLog(`[${a.naver_id}] ⚠ VM 시계가 실제보다 ${r.clockSkewSec}초 어긋남 — 세션 끊김 원인이 될 수 있음`);
    }
    return {
      ok: true, ips: r.ips, distinct: r.distinct, stable: r.stable,
      anonymous: r.anonymous, leakHeaders: r.leakHeaders, clockSkewSec: r.clockSkewSec,
    };
  });

  // 계정 전용 크롬을 그냥 열어보기 (프로필 설정·둘러보기·워밍업용).
  // 로그인 여부와 상관없이 열리고, 창을 닫으면 그때 세션이 저장된다.
  ipcMain.handle('accounts:openBrowser', async (_e, id: number) => {
    const a = db().prepare('SELECT * FROM accounts WHERE id = ?').get([id]) as any;
    if (!a) return { ok: false, error: '계정을 찾을 수 없습니다.' };
    if (!a.proxy_host || !a.proxy_port) {
      return {
        ok: false,
        error: '프록시가 없어 브라우저를 열지 않았습니다. 실제 IP 노출을 막기 위해 먼저 프록시를 등록하세요.',
      };
    }
    const accP = accountToProxy(a);
    const res = await loginWithRealChrome(
      accP,
      (s) => pushLog('[' + a.naver_id + '] ' + s),
      async (cookies) => {
        const k = await importCookiesToAccountSession(accP, cookies);
        pushLog(`[${a.naver_id}] 세션 적용됨 (쿠키 ${k}개)`);
      },
    );
    // 로그인 안 하고 그냥 둘러보다 닫아도 정상 종료로 본다
    if (res.ok && res.cookies) {
      const n = await importCookiesToAccountSession(accP, res.cookies);
      pushLog(`[${a.naver_id}] 브라우저 종료 — 세션 저장 완료 (쿠키 ${n}개)`);
    } else {
      pushLog(`[${a.naver_id}] 브라우저 종료`);
    }
    return { ok: true };
  });

  /* ---------- 질문 수집 ---------- */
  ipcMain.handle(
    'questions:collect',
    async (_e, opts: { brandId?: number; accountId?: number; limit?: number }) => {
      let account: AccountProxy | undefined;
      if (opts.accountId) {
        const a = db().prepare('SELECT * FROM accounts WHERE id = ?').get([opts.accountId]) as any;
        if (a) account = accountToProxy(a);
      }

      // 수집 목표 개수
      const targetTotal = Math.max(1, Math.min(500, Math.floor(Number(opts.limit ?? getS('collect_count') ?? 20)) || 20));

      // 브랜드의 검색 키워드 목록
      const kwOf = (bid: number): string[] =>
        (db()
          .prepare("SELECT keyword FROM keywords WHERE brand_id = ? AND TRIM(keyword) != ''")
          .all([bid]) as any[]).map((r) => r.keyword as string);

      // 브랜드별 수집 할당량 계산
      type BrandPlan = { brandId: number | null; keywords: string[]; quota: number };
      const plans: BrandPlan[] = [];

      if (opts.brandId) {
        // 특정 브랜드 → 목표 전부 그 브랜드에서
        const ks = kwOf(opts.brandId);
        if (ks.length === 0) {
          return {
            ok: false,
            inserted: 0,
            error: '이 브랜드에 등록된 검색 키워드가 없습니다. 브랜드·제품 탭에서 키워드를 먼저 추가하세요.',
          };
        }
        plans.push({ brandId: opts.brandId, keywords: ks, quota: targetTotal });
      } else {
        // 전체 → 키워드가 있는 모든 브랜드에 1/N 균등 분배 (나머지는 앞쪽 브랜드부터 1개씩)
        const brands = db().prepare('SELECT id FROM brands ORDER BY created_at ASC').all() as any[];
        const withKw = brands
          .map((b) => ({ brandId: b.id as number, keywords: kwOf(b.id) }))
          .filter((x) => x.keywords.length > 0);
        if (withKw.length === 0) {
          // 키워드 있는 브랜드가 하나도 없으면 기존처럼 전체 답변대기 목록에서 수집
          plans.push({ brandId: null, keywords: [''], quota: targetTotal });
        } else {
          const per = Math.floor(targetTotal / withKw.length);
          const rem = targetTotal % withKw.length;
          withKw.forEach((x, i) => {
            const quota = per + (i < rem ? 1 : 0);
            if (quota > 0) plans.push({ brandId: x.brandId, keywords: x.keywords, quota });
          });
        }
      }

      const ins = db().prepare(
        `INSERT OR IGNORE INTO questions (kin_key, title, url, content, category, matched_brand_id, matched_keyword, asked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      let inserted = 0;
      let excludedCount = 0;
      let scannedCount = 0;
      const usedKeywords: string[] = [];

      // 이미 수집한 질문인지 판별 — 목표 개수에 세지 않고 다음 페이지에서 더 찾게 함
      const isNew = (kinKey: string) =>
        !db().prepare('SELECT id FROM questions WHERE kin_key = ?').get([kinKey]);

      for (const plan of plans) {
        const excludeTerms = loadExcludeTerms(plan.brandId);
        let brandInserted = 0;
        for (const kw of plan.keywords) {
          if (brandInserted >= plan.quota) break;
          const need = plan.quota - brandInserted;
          // 제외 키워드로 빠지는 걸 감안해 목표보다 조금 더 긁어옴(버퍼)
          const found = await collectQuestions({
            keyword: kw || undefined,
            account,
            limit: need + 5,
            isNew,
          });
          scannedCount += getLastScanCount();
          if (kw) usedKeywords.push(kw);
          for (const q of found) {
            if (brandInserted >= plan.quota) break;
            if (titleExcluded(q.title, excludeTerms)) {
              excludedCount++;
              continue;
            }
            // 새로 들어올 질문만 상세 페이지에서 작성 시각을 가져옴 (중복은 건너뜀)
            const exists = db().prepare('SELECT id FROM questions WHERE kin_key = ?').get([q.kinKey]);
            let askedAt: string | null = null;
            if (!exists) {
              try {
                const d = await fetchQuestionDetail(q.url, account);
                askedAt = d.askedAt || null;
              } catch {
                // ignore
              }
            }
            const r = ins.run([
              q.kinKey,
              q.title,
              normalizeKinUrl(q.url),
              q.content || null,
              q.category,
              plan.brandId,
              kw || null,
              askedAt,
            ]);
            if (r.changes > 0) {
              inserted++;
              brandInserted++;
            }
          }
        }
      }

      return {
        ok: true,
        inserted,
        keywords: Array.from(new Set(usedKeywords)),
        excluded: excludedCount,
        scanned: scannedCount, // 훑어본 질문 총수 (이미 수집한 것 포함)
        target: targetTotal,
        brands: plans.length,
      };
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

  // 수집한 질문 1건 삭제 (등록 이력이 있는 질문은 보호)
  ipcMain.handle('questions:remove', (_e, id: number) => {
    const posted = db()
      .prepare("SELECT id FROM answers WHERE question_id=? AND status='posted' LIMIT 1")
      .get([id]);
    if (posted) {
      return { ok: false, error: '이미 등록한 답변이 있는 질문이라 삭제하지 않았습니다(이력 보호).' };
    }
    db().prepare('DELETE FROM questions WHERE id = ?').run([id]);
    return { ok: true };
  });

  // 수집 목록 비우기 — 아직 등록하지 않은 질문만 삭제 (등록 이력은 보존)
  ipcMain.handle('questions:clearCollected', (_e, opts: { brandId?: number }) => {
    let sql =
      "DELETE FROM questions WHERE status='new' AND id NOT IN (SELECT question_id FROM answers WHERE status='posted')";
    const params: any[] = [];
    if (opts?.brandId) {
      sql += ' AND matched_brand_id = ?';
      params.push(opts.brandId);
    }
    const r = db().prepare(sql).run(params);
    return { ok: true, deleted: r.changes };
  });

  ipcMain.handle('questions:setStatus', (_e, id: number, status: string) => {
    db().prepare('UPDATE questions SET status = ? WHERE id = ?').run([status, id]);
    return true;
  });

  /* ---------- 답변 생성 (Claude) ---------- */
  const getS = (k: string) =>
    (db().prepare('SELECT value FROM settings WHERE key = ?').get([k]) as any)?.value || '';

  // 질문 하나에 대한 답변 초안 생성 (단건/전체 공용)
  async function doGenerate(
    questionId: number,
    brandArg?: number,
    includePromo?: boolean,
    // 질문 상세를 읽을 때 쓸 프록시 (없으면 프록시 없이 나가 VM 실제 IP가 노출되므로 가급적 전달)
    detailProxy?: AccountProxy,
  ) {
    const q = db().prepare('SELECT * FROM questions WHERE id = ?').get([questionId]) as any;
    if (!q) return { ok: false, error: '질문을 찾을 수 없습니다.' };

    const brandId = brandArg ?? q.matched_brand_id;
    let brand: any = null;
    if (brandId) brand = db().prepare('SELECT * FROM brands WHERE id = ?').get([brandId]);

    // 홍보 모드: 해당 브랜드에 '홍보용 프롬프트'가 설정돼 있을 때만
    const brandPromoPrompt = String(brand?.system_prompt || '').trim();
    const usePromo = !!(includePromo && brandPromoPrompt);
    const promoText: string | undefined = undefined; // 홍보문구는 폐지 (프롬프트에 제품을 기술)
    let systemPrompt: string;
    if (usePromo) {
      systemPrompt = brandPromoPrompt;
    } else {
      // 일상글: 공통 일상 프롬프트 (구버전 global_prompt 값도 호환)
      systemPrompt = getS('daily_prompt') || getS('global_prompt') || DEFAULT_DAILY_PROMPT;
    }

    // 상세 페이지에서 질문 전체 본문을 읽어 답변 품질을 높임 (목록 스니펫은 잘림)
    let questionTitle = q.title;
    let questionBody = q.content || '';
    try {
      const detail = await fetchQuestionDetail(q.url, detailProxy);
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
      .run([questionId, brandId ?? null, result.text, usePromo ? 1 : 0]);
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
            .prepare('SELECT system_prompt FROM brands WHERE id = ?')
            .get([q.matched_brand_id]) as any;
          if (b?.system_prompt && String(b.system_prompt).trim()) includePromo = Math.random() * 100 < ratio;
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

  ipcMain.handle(
    'answers:history',
    (_e, opts?: { type?: 'promo' | 'daily'; brandId?: number; date?: string }) => {
      const cond: string[] = [];
      const params: any[] = [];
      if (opts?.type === 'promo') cond.push('a.promo_included = 1');
      else if (opts?.type === 'daily') cond.push('a.promo_included = 0');
      if (opts?.brandId) {
        cond.push('a.brand_id = ?');
        params.push(opts.brandId);
      }
      if (opts?.date) {
        // 등록일 우선, 없으면 생성일 기준으로 해당 날짜 필터 (YYYY-MM-DD)
        cond.push("date(COALESCE(a.posted_at, a.created_at), 'localtime') = ?");
        params.push(opts.date);
      }
      const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
      return db()
        .prepare(
          `SELECT a.*, q.title AS question_title, q.url AS question_url, q.asked_at AS question_asked_at,
                  b.name AS brand_name, acc.naver_id AS account_naver_id
           FROM answers a
           LEFT JOIN questions q ON q.id = a.question_id
           LEFT JOIN brands b ON b.id = a.brand_id
           LEFT JOIN accounts acc ON acc.id = a.account_id
           ${where}
           ORDER BY a.created_at DESC LIMIT 300`,
        )
        .all(params);
    },
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

      // ★ 등록도 '로그인한 그 크롬'에서 해야 한다.
      //   Electron 창으로 로그인 쿠키를 옮겨 쓰면 네이버가 세션 탈취로 보고 계정을 끊는다.
      const accP = accountToProxy(acc);
      const ctx = await getAccountContext(accP);
      const submit = opts.mode === 'auto';
      const r = await pwAnswerQuestion(ctx, q.url, a.body, submit, (m) =>
        pushLog(`[${acc.naver_id}] ${m}`),
      );
      const result = {
        ok: r.typed || r.submitted,
        error: r.error,
        needsHuman: submit ? !r.submitted : true,
      };

      const posted = r.submitted;
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

  /* ---------- 프롬프트 테스트 (지식인에 등록하지 않고 출력만 확인) ---------- */
  ipcMain.handle(
    'prompts:test',
    async (_e, opts: { prompt: string; questionTitle: string; questionBody?: string }) => {
      const systemPrompt = (opts.prompt || '').trim() || DEFAULT_DAILY_PROMPT;
      const title = (opts.questionTitle || '').trim();
      if (!title) return { ok: false, error: '테스트할 질문 제목을 입력하세요.' };
      return generateAnswer({
        systemPrompt,
        questionTitle: title,
        questionBody: opts.questionBody || '',
      });
    },
  );

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
    closeAllKinContexts().catch(() => {});
    return true;
  });

  ipcMain.handle(
    'auto:start',
    async (
      _e,
      opts: { accountId?: number; accountIds?: number[]; submit: boolean; brandId?: number; useCollected?: boolean },
    ) => {
    if (autoRunning) return { ok: false, error: '이미 실행 중입니다.' };
    // 여러 계정(교대) 또는 단일 계정 모두 지원
    const rawIds =
      opts.accountIds && opts.accountIds.length
        ? opts.accountIds
        : opts.accountId != null
          ? [opts.accountId]
          : [];
    const ids = Array.from(new Set(rawIds));
    if (!ids.length) return { ok: false, error: '계정을 선택하세요.' };
    const accs = ids
      .map((id) => db().prepare('SELECT * FROM accounts WHERE id = ?').get([id]) as any)
      .filter(Boolean);
    if (!accs.length) return { ok: false, error: '계정을 찾을 수 없습니다.' };
    const proxied = accs.filter((a) => a.proxy_host && a.proxy_port);
    if (!proxied.length) {
      return { ok: false, error: '프록시 없는 계정은 완전자동을 실행할 수 없습니다.' };
    }
    const skipped = accs.length - proxied.length;
    const useIds = proxied.map((a) => a.id as number);
    autoRunning = true;
    autoStop = false;
    autoCount = 0;
    pushLog(useIds.length > 1 ? `시작 중… (${useIds.length}개 계정 교대)` : '시작 중…');
    if (skipped) pushLog(`⚠ 프록시 없는 계정 ${skipped}개는 제외했습니다`);
    runAutopilot(useIds, opts.submit, opts.brandId, opts.useCollected)
      .catch((e) => {
        pushLog('오류: ' + (e instanceof Error ? e.message : String(e)));
      })
      .finally(() => {
        autoRunning = false;
        autoNextResolve = null;
        closeAllKinContexts().catch(() => {});
      });
    return { ok: true };
  });

  async function runAutopilot(accountIds: number[], submit: boolean, onlyBrandId?: number, useCollected?: boolean) {
    const ratio = Number(getS('promo_ratio') || '20');
    const rotate = accountIds.length > 1;
    let rotPtr = 0;
    // 현재 교대 중인 계정 (switchAccount가 갱신)
    let accountId = -1;
    let acc: any = null;
    let dailyLimit = 5;
    let prevAccountId: number | null = null;
    // 이번 실행에서 보호조치가 감지돼 제외된 계정들 (더 건드리지 않는다)
    const bannedAccounts = new Set<number>();
    let kinCtx: Awaited<ReturnType<typeof getAccountContext>> | null = null;

    // 오늘 이 계정이 아직 한도가 남았는지
    const underLimit = (id: number) => {
      const a = db().prepare('SELECT daily_limit FROM accounts WHERE id=?').get([id]) as any;
      const lim = a?.daily_limit || 5;
      const t = db()
        .prepare(
          "SELECT COUNT(*) n FROM answers WHERE account_id=? AND status='posted' AND date(posted_at)=date('now','localtime')",
        )
        .get([id]) as any;
      return (t?.n || 0) < lim;
    };

    // 다음 사용 가능한 계정으로 교대. 계정이 바뀌면 그 계정의 프록시·세션으로 창을 새로 연다.
    // (사람이 계정 바꿔 로그인하는 흐름과 동일 — 한 번에 창 하나)
    async function switchAccount(): Promise<boolean> {
      let pick = -1;
      for (let i = 0; i < accountIds.length; i++) {
        const cand = accountIds[(rotPtr + i) % accountIds.length];
        if (bannedAccounts.has(cand)) continue;
        if (underLimit(cand)) {
          pick = cand;
          rotPtr = (rotPtr + i + 1) % accountIds.length;
          break;
        }
      }
      if (pick < 0) return false;
      // 같은 계정이면 열려 있는 크롬을 그대로 사용 (단일 계정은 다시 열지 않음)
      if (pick === accountId && kinCtx) return true;
      accountId = pick;
      acc = db().prepare('SELECT * FROM accounts WHERE id = ?').get([accountId]) as any;
      dailyLimit = acc.daily_limit || 5;
      // 이전 계정 크롬은 닫고, 이 계정의 크롬(로그인할 때 쓴 그 프로필)을 연다.
      // ★ 로그인과 작업을 같은 브라우저에서 해야 한다. 쿠키만 다른 브라우저로 옮기면
      //   네이버가 세션 탈취로 보고 로그아웃시킨다(예전 구조의 실제 원인).
      if (prevAccountId != null && prevAccountId !== accountId) {
        await closeAccountContext(prevAccountId).catch(() => {});
      }
      prevAccountId = accountId;
      pushLog(`[${acc.naver_id}] 크롬 여는 중 · 로그인 확인…`);
      kinCtx = await getAccountContext(accountToProxy(acc));
      // 브라우저가 '실제로' 프록시로 나가는지 확인 (옵션만 넣고 실제론 안 타는 경우 방지)
      const realIp = await pwCheckBrowserExitIp(kinCtx);
      if (realIp) {
        const expected = String(acc.proxy_host || '');
        const match = expected && realIp === expected;
        pushLog(
          `[${acc.naver_id}] 브라우저 실제 접속 IP: ${realIp}` +
            (expected ? (match ? ' (프록시와 일치 ✓)' : ` ⚠ 프록시(${expected})와 다름!`) : ''),
        );
      } else {
        pushLog(`[${acc.naver_id}] ⚠ 접속 IP 확인 실패`);
      }
      // ★ 보호조치/정지 계정으로 계속 시도하면 상황만 나빠진다 → 감지되면 즉시 제외
      const suspended = await pwDetectSuspension(kinCtx);
      if (suspended) {
        try {
          db().prepare("UPDATE accounts SET status='suspect' WHERE id=?").run([accountId]);
        } catch {
          // ignore
        }
        bannedAccounts.add(accountId);
        pushLog(`⛔ [${acc.naver_id}] 보호조치/정지 감지 — 이 계정은 이번 실행에서 제외합니다 ("${suspended}")`);
        await closeAccountContext(accountId).catch(() => {});
        kinCtx = null;
        return await switchAccount();
      }
      const okLogin = await pwIsLoggedIn(kinCtx);
      if (okLogin) pushLog(`[${acc.naver_id}] 로그인 확인됨 ✓`);
      else pushLog(`⚠ [${acc.naver_id}] 로그인 안 됨 — 계정·프록시 탭에서 로그인하세요`);
      return true;
    }

    if (!(await switchAccount())) {
      pushLog('실행 가능한 계정이 없습니다 (모두 하루 한도 도달?)');
      return;
    }
    if (autoStop) return;

    while (!autoStop) {
      if (!kinCtx) break;

      // 한 번의 예외로 전체 자동발행이 멈추지 않도록 이터레이션 단위로 감쌈.
      // 오류가 나면 로그만 남기고 다음 질문으로 계속 진행.
      try {
      // 현재 계정이 한도에 도달했으면 다음 계정으로 교대 (없으면 종료)
      if (!underLimit(accountId)) {
        pushLog(`[${acc.naver_id}] 하루 한도(${dailyLimit}) 도달`);
        if (!(await switchAccount())) {
          pushLog('모든 계정 하루 한도 도달 — 종료');
          break;
        }
        continue;
      }

      // ===== 수집 발행: DB에 수집해둔 질문을 순서대로 발행 =====
      let keyword: string | undefined;
      let brandId: number | undefined;
      let qrow: any = null;
      let targetUrl = '';
      let targetTitle = '';
      let isPromo = false;

      if (useCollected) {
        let sql = "SELECT * FROM questions WHERE status='new'";
        const params: any[] = [];
        if (onlyBrandId) {
          sql += ' AND matched_brand_id = ?';
          params.push(onlyBrandId);
        }
        sql += ' ORDER BY collected_at ASC LIMIT 1';
        qrow = db().prepare(sql).get(params);
        if (!qrow) {
          pushLog('수집한 질문을 모두 처리했습니다 — 종료 ([질문 수집]으로 더 모아주세요)');
          break;
        }
        brandId = qrow.matched_brand_id ?? undefined;
        keyword = qrow.matched_keyword ?? undefined;
        targetUrl = qrow.url;
        targetTitle = qrow.title;
        // 브랜드 제외 키워드 해당 시 발행하지 않고 건너뜀 (수집 뒤 제외어를 추가했을 수도 있어 발행 시점에도 재확인)
        if (titleExcluded(qrow.title, loadExcludeTerms(qrow.matched_brand_id ?? null))) {
          db().prepare("UPDATE questions SET status='skipped' WHERE id=?").run([qrow.id]);
          pushLog(`제외 키워드 해당 — 건너뜀: ${String(qrow.title).slice(0, 20)}`);
          continue;
        }
        if (brandId) {
          const b = db().prepare('SELECT system_prompt FROM brands WHERE id = ?').get([brandId]) as any;
          isPromo = !!(b?.system_prompt && String(b.system_prompt).trim());
        }
        const remain = db()
          .prepare(
            onlyBrandId
              ? "SELECT COUNT(*) n FROM questions WHERE status='new' AND matched_brand_id = ?"
              : "SELECT COUNT(*) n FROM questions WHERE status='new'",
          )
          .get(onlyBrandId ? [onlyBrandId] : []) as any;
        pushLog(`수집 발행 (${isPromo ? '홍보' : '일상'}) · 남은 수집글 ${remain?.n ?? 0}건`);
      }

      // ===== 완전자동: 지식인에서 실시간으로 질문을 찾아 발행 =====
      const wantPromo = Math.random() * 100 < ratio;
      if (!useCollected && wantPromo) {
        const brandsWithPromo = (
          onlyBrandId
            ? (db()
                .prepare("SELECT * FROM brands WHERE id = ? AND system_prompt IS NOT NULL AND TRIM(system_prompt) != ''")
                .all([onlyBrandId]) as any[])
            : (db()
                .prepare("SELECT * FROM brands WHERE system_prompt IS NOT NULL AND TRIM(system_prompt) != ''")
                .all() as any[])
        );
        if (brandsWithPromo.length) {
          const b = brandsWithPromo[Math.floor(Math.random() * brandsWithPromo.length)];
          const kws = db().prepare('SELECT keyword FROM keywords WHERE brand_id=?').all([b.id]) as any[];
          if (kws.length) {
            keyword = kws[Math.floor(Math.random() * kws.length)].keyword;
            brandId = b.id;
          }
        }
      }
      if (!useCollected) isPromo = !!(keyword && brandId);

      const scanPages = Math.max(1, Math.min(10, Number(getS('scan_max_pages') || '3')));
      if (!useCollected) {
        if (!kinCtx) break;
        const excludeTerms = loadExcludeTerms(brandId ?? null);
        // ★ 최신순 유지 + 지연 페이징 — 전부 '로그인한 그 크롬'에서 수행한다.
        //   페이지1(최신)부터 보고, 그 페이지에 답할 질문이 있으면 즉시 사용.
        //   없을 때만 다음 페이지로 넘어간다.
        const found = await pwFindQuestion(
          kinCtx,
          {
            keyword: isPromo ? keyword : undefined,
            scanPages,
            isUsable: (q) => {
              if (excludeTerms.length && titleExcluded(q.title, excludeTerms)) return false;
              const row = db().prepare('SELECT status FROM questions WHERE kin_key=?').get([q.kinKey]) as any;
              return !row || row.status === 'new';
            },
          },
          (msg) => pushLog(`[${acc.naver_id}] ${msg}`),
        );
        const fresh = found.picked;
        if (autoStop) break;

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
          .run([fresh.kinKey, fresh.title, normalizeKinUrl(fresh.url), fresh.content || null, '', brandId ?? null, keyword || null]);
        qrow = db().prepare('SELECT * FROM questions WHERE kin_key=?').get([fresh.kinKey]) as any;
        targetUrl = fresh.url;
        targetTitle = fresh.title;
      }

      // 질문 본문을 실제로 가져왔는지 확인해 로그에 남김
      try {
        const d = await fetchQuestionDetail(targetUrl, accountToProxy(acc));
        pushLog(
          `질문 확인: 제목 ${(d.title || targetTitle || '').length}자 / 본문 ${(d.body || '').length}자`,
        );
      } catch {
        // ignore
      }
      pushLog(`답변 생성 중: ${String(targetTitle).slice(0, 24)}`);
      const gen = (await doGenerate(qrow.id, brandId, isPromo, accountToProxy(acc))) as any;
      if (!gen.ok || !gen.answer) {
        pushLog('생성 실패 — 다음');
        await sleepRnd(5000, 10000);
        continue;
      }
      if (autoStop || !kinCtx) break;

      // 사람처럼 한 글자씩 치므로 긴 답변은 그만큼 오래 걸린다(글자당 약 70ms).
      // 고정 제한(120초)을 쓰면 긴 답변이 무조건 시간 초과되므로 길이에 맞춰 제한을 계산한다.
      const bodyLen = String(gen.answer.body || '').length;
      const capMs = Math.max(120000, Math.round(bodyLen * 85) + 90000); // 타이핑 예상 + 여유 90초
      pushLog(`사람처럼 답변 작성 중… (${bodyLen}자 · 최대 ${Math.round(capMs / 1000)}초)`);
      // 전체 안전망: 열기·입력·등록이 제한시간 내 안 끝나면(페이지/네트워크 hang) 실패 처리하고 다음으로.
      let res: { typed: boolean; submitted: boolean; error?: string };
      try {
        res = await Promise.race([
          pwAnswerQuestion(kinCtx!, targetUrl, gen.answer.body, submit, (s) => pushLog('· ' + s)),
          new Promise<never>((_, rej) =>
            setTimeout(
              () =>
                rej(
                  new Error(
                    `답변 작성 시간 초과(${Math.round(capMs / 1000)}초, 본문 ${bodyLen}자) — 페이지/네트워크 지연`,
                  ),
                ),
              capMs,
            ),
          ),
        ]);
      } catch (e) {
        res = { typed: false, submitted: false, error: e instanceof Error ? e.message : String(e) };
      }
      if (res.error) {
        // 작업 도중 보호조치가 걸렸는지 확인 — 걸렸으면 이 계정은 즉시 중단(더 시도하면 악화)
        if (kinCtx && /로그인이 풀렸|답변' 버튼 없음/.test(res.error)) {
          const sus = await pwDetectSuspension(kinCtx);
          if (sus) {
            try {
              db().prepare("UPDATE accounts SET status='suspect' WHERE id=?").run([accountId]);
            } catch {
              // ignore
            }
            bannedAccounts.add(accountId);
            pushLog(`⛔ [${acc.naver_id}] 보호조치/정지 감지 — 이 계정 중단 ("${sus}")`);
            await closeAccountContext(accountId).catch(() => {});
            kinCtx = null;
            if (!(await switchAccount())) {
              pushLog('사용 가능한 계정이 없습니다 — 종료');
              break;
            }
            continue;
          }
        }
        const isFaqErr = /FAQ/.test(res.error);
        // 답변은 실패로 기록(이력에 빨간 '실패'/'FAQ 실패'로 표시, error 저장).
        if (gen?.answer?.id)
          db()
            .prepare("UPDATE answers SET account_id=?, status='failed', mode='auto', error=? WHERE id=?")
            .run([accountId, res.error, gen.answer.id]);
        // 질문은 '시도함(skipped)'으로 표시 → 다른 계정/다음 실행에서 다시 시도하지 않고 PASS.
        // (questions.status CHECK는 new/answered/skipped만 허용 — 실패도 skipped로 통일.
        //  실패 상세는 answer row의 status='failed'+error에 남음)
        if (qrow && qrow.id)
          db().prepare("UPDATE questions SET status='skipped' WHERE id=?").run([qrow.id]);
        if (isFaqErr) {
          pushLog('건너뜀(FAQ 권한 필요): ' + res.error);
          await sleepRnd(1500, 3000);
        } else {
          pushLog('작성 실패: ' + res.error);
          await sleepRnd(6000, 12000);
        }
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
        // 여러 계정이면 다음 계정으로 교대
        if (rotate && !autoStop) {
          if (!(await switchAccount())) {
            pushLog('모든 계정 하루 한도 도달 — 종료');
            break;
          }
        }
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
        // 여러 계정이면 다음 계정으로 교대
        if (rotate && !autoStop) {
          if (!(await switchAccount())) {
            pushLog('모든 계정 하루 한도 도달 — 종료');
            break;
          }
        }
      }
      } catch (e) {
        pushLog('이 질문 처리 중 오류 — 건너뛰고 계속: ' + (e instanceof Error ? e.message : String(e)));
        await sleepRnd(4000, 8000);
      }
    }
    autoStatus = autoStop ? '중지됨' : autoStatus;
  }
}
