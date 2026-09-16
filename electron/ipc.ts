import { app, BrowserWindow, type IpcMain } from 'electron';
import { getDb } from './db';
import { generateAnswer } from './claude';
import {
  collectQuestions,
  fetchQuestionDetail,
  openAnswerWindow,
  openLoginWindow,
  openAutoWindow,
  autoScrapeList,
  autoOpenAndAnswer,
  normalizeKinUrl,
  autoIsLoggedIn,
  autoGoToKinAnswerList,
  autoScrapeWaitingList,
  getLastScanCount,
  autoScrapeCurrentPage,
  autoAdvancePage,
  autoSearchKeyword,
  type AccountProxy,
  type PostMode,
} from './naver';
import { loginWithRealChrome, checkProxyExitIp, hasOpenAccountContext } from './pwlogin';
import { proxyFor } from './network-config';
import { lookupIpLine } from './ip-line';
import { requireAuthenticated } from './session-auth';
import { decryptSecret, encryptSecret, hasSecret, isEncryptionAvailable } from './secret';
import {
  getAccountContext,
  closeAccountContext,
  closeAllKinContexts,
  pwIsLoggedIn,
  pwFindQuestion,
  pwAnswerQuestion,
  pwCheckBrowserExitIp,
  pwDetectSuspension,
  pwOpenQuestion,
  pwReadOpenQuestion,
  pwFingerprintDiag,
  runWarmupSession,
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

export function registerIpc(ipcMain: IpcMain) {
  const db = () => getDb();
  // Single browser operation at a time; scheduled tasks never borrow a manual window.
  let foregroundBusy = false;
  function handleBrowser(name: string, handler: Parameters<IpcMain['handle']>[1]) {
    ipcMain.handle(name, async (event, ...args) => {
      if (foregroundBusy || autoRunning || warmupBusy != null) {
        return { ok: false, error: '다른 브라우저 작업이 진행 중입니다. 작업을 마친 후 다시 시도해 주세요.' };
      }
      foregroundBusy = true;
      try { return await handler(event, ...args); }
      catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
      finally { foregroundBusy = false; }
    });
  }


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
  ipcMain.handle('accounts:list', () => {
    const rows = db().prepare('SELECT * FROM accounts ORDER BY created_at ASC').all() as any[];
    // 비밀번호는 화면으로 절대 내보내지 않는다. 저장 여부만 알려준다.
    return rows.map((r) => {
      const { naver_pw, ...rest } = r;
      return {
        ...rest,
        has_password: hasSecret(naver_pw),
        // 워밍업 진행 표시용 (메모리 상태)
        warmup_busy: warmupBusy === r.id,
        ...warmupPlanInfo(r),
      };
    });
  });
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
    // 워밍업 종료 시각: ISO 문자열이면 새로 시작(진행 카운터 초기화), 빈 문자열이면 해제, 없으면 유지
    if (typeof fields.warmup_until === 'string') {
      const on = fields.warmup_until !== '';
      db()
        .prepare(
          'UPDATE accounts SET warmup_until=?, warmup_started_at=?, warmup_sessions=0, warmup_last_at=NULL WHERE id=?',
        )
        .run([on ? fields.warmup_until : null, on ? new Date().toISOString() : null, id]);
      warmupPlan.delete(id); // 계획 초기화 → 다음 tick에서 오늘 계획을 새로 뽑는다
    }
    // Empty/omitted input preserves the encrypted value. Deletion requires an explicit action.
    let pwToSave = cur.naver_pw ?? null;
    if (fields.clear_password === true) {
      if (fields.naver_pw) return { error: '새 비밀번호 입력과 삭제를 동시에 선택할 수 없습니다.' };
      pwToSave = null;
    } else if (typeof fields.naver_pw === 'string' && fields.naver_pw !== '') {
      const enc = encryptSecret(fields.naver_pw);
      if (enc === null) return { error: '이 PC에서 안전한 암호화를 쓸 수 없어 비밀번호를 저장하지 않았습니다.' };
      pwToSave = enc;
    }
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
    db().prepare('UPDATE accounts SET naver_pw=? WHERE id=?').run([pwToSave, id]);
    const row = db().prepare('SELECT * FROM accounts WHERE id = ?').get([id]) as any;
    const { naver_pw, ...rest } = row;
    return { ...rest, has_password: hasSecret(naver_pw) };
  });
  ipcMain.handle('accounts:canStorePassword', () => isEncryptionAvailable());
  ipcMain.handle('accounts:remove', (_e, id: number) => {
    db().prepare('DELETE FROM accounts WHERE id = ?').run([id]);
    return true;
  });
  handleBrowser('accounts:login', async (_e, id: number) => {
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
    return loginWithRealChrome(accP, (message) => pushLog('[' + a.naver_id + '] ' + message), decryptSecret(a.naver_pw) || undefined);

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
          `[${a.naver_id}] ⚠ 같은 프록시를 쓰는 계정이 또 있습니다: ${dup.map((d) => d.naver_id).join(', ')} — 설정을 확인해 주세요`,
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
      `[${a.naver_id}] 프록시 IP ${r.stable ? '측정 중 동일 ' + r.distinct[0] : '측정 불완전 또는 IP 변동: ' + r.distinct.join(', ')}`,
    );
    if (r.anonymous === false) {
      pushLog(
        `[${a.naver_id}] ⚠ 프록시가 흔적 헤더를 붙임: ${(r.leakHeaders || []).map((h) => h.name).join(', ')}`,
      );
    } else if (r.anonymous === true) {
      pushLog(`[${a.naver_id}] 검사 응답에서 전달 헤더 미검출`);
    }
    if (typeof r.clockSkewSec === 'number' && Math.abs(r.clockSkewSec) > 60) {
      pushLog(`[${a.naver_id}] ⚠ VM 시계가 실제보다 ${r.clockSkewSec}초 어긋남 — 세션 끊김 원인이 될 수 있음`);
    }
    // 출구 IP가 통신사 회선인지 서버 호스팅 대역인지 (공개 RDAP, 네이버 무관)
    const line = r.distinct[0] ? await lookupIpLine(r.distinct[0]) : undefined;
    if (line) {
      const label = line.type === 'carrier' ? '통신사 회선' : line.type === 'hosting' ? '⚠ 서버 호스팅(IDC) 대역' : '회선 종류 판별 불가';
      pushLog(`[${a.naver_id}] 출구 IP 대역: ${label}${line.netname ? ' (' + line.netname + ')' : ''}`);
    }
    return {
      ok: true, ips: r.ips, distinct: r.distinct, stable: r.stable,
      anonymous: r.anonymous, leakHeaders: r.leakHeaders, clockSkewSec: r.clockSkewSec, line,
    };
  });

  // 이 계정의 '실제 크롬'이 네이버에 보여주는 기기 지문을 측정 (읽기 전용 — 위장 아님)
  handleBrowser('accounts:fingerprint', async (_e, id: number) => {
    const a = db().prepare('SELECT * FROM accounts WHERE id = ?').get([id]) as any;
    if (!a) return { ok: false, error: '계정을 찾을 수 없습니다.' };
    if (!a.proxy_host || !a.proxy_port) return { ok: false, error: '프록시를 먼저 등록하세요.' };
    try {
      pushLog(`[${a.naver_id}] 기기 지문 측정 중… (약 10초)`);
      const ctx = await getAccountContext(accountToProxy(a));
      const fp = await pwFingerprintDiag(ctx);
      pushLog(
        `[${a.naver_id}] 지문: GPU="${fp.webglRenderer.slice(0, 60)}" ${fp.vmLike ? '⚠ VM/소프트웨어 GPU 의심' : '(실제 GPU)'} · 코어 ${fp.cores} · 메모리 ${fp.memory}GB · 화면 ${fp.screen} · 해시 ${fp.fingerprintHash}` +
          (fp.webrtcLeak ? ` · ⚠ WebRTC 누수: ${fp.leakedPublicIps.join(',')}` : ' · WebRTC 누수 없음 ✓'),
      );
      return { ok: true, ...fp };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 계정 전용 크롬을 그냥 열어보기 (프로필 설정·둘러보기·워밍업용).
  // 로그인 여부와 상관없이 열리고, 창을 닫으면 그때 세션이 저장된다.
  handleBrowser('accounts:openBrowser', async (_e, id: number) => {
    const a = db().prepare('SELECT * FROM accounts WHERE id = ?').get([id]) as any;
    if (!a) return { ok: false, error: '계정을 찾을 수 없습니다.' };
    if (!a.proxy_host || !a.proxy_port) {
      return {
        ok: false,
        error: '프록시가 없어 브라우저를 열지 않았습니다. 실제 IP 노출을 막기 위해 먼저 프록시를 등록하세요.',
      };
    }
    const accP = accountToProxy(a);
    return loginWithRealChrome(accP, (message) => pushLog('[' + a.naver_id + '] ' + message), undefined, 'browse');

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

      try { proxyFor(account); }
      catch (e) { return { ok: false, inserted: 0, error: e instanceof Error ? e.message : '프록시 설정을 확인해 주세요.' }; }

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
          let found: Awaited<ReturnType<typeof collectQuestions>>;
          try { found = await collectQuestions({
            keyword: kw || undefined,
            account,
            limit: need + 5,
            isNew,
          }); } catch (e) {
            return { ok: false, inserted, error: e instanceof Error ? e.message : '질문 수집에 실패했습니다.' };
          }
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
              } catch (e) {
                return { ok: false, inserted, error: e instanceof Error ? e.message : '질문 상세 조회에 실패했습니다.' };
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
    // 크롬에서 이미 읽어둔 질문 내용. 있으면 별도 요청을 만들지 않는다(브라우저와 다른 지문의 요청 방지)
    preloaded?: { title?: string; body?: string },
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
      const detail = preloaded ?? (detailProxy ? await fetchQuestionDetail(q.url, detailProxy) : {});
      if (detail.title) questionTitle = detail.title;
      if (detail.body && detail.body.length > questionBody.length) questionBody = detail.body;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '질문 상세 조회에 실패했습니다.' };
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
  handleBrowser(
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
        ok: !r.error && (r.typed || r.submitted),
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

  // Compatibility for old renderer callers. Chrome persists its own profile.
  ipcMain.handle('accounts:persistLogins', () => ({ ok: true }));

  let autoRunning = false;
  let autoStop = false;
  let autoStatus = '대기';
  let autoCount = 0;
  let autoNextResolve: (() => void) | null = null;
  const autoLog: string[] = [];
  // 워밍업 세션이 돌고 있는 계정 id (완전자동과 크롬을 동시에 잡지 않도록)
  let warmupBusy: number | null = null;

  /**
   * 계정별 '오늘의 계획' — 오늘 몇 번, 정확히 몇 시 몇 분에 들를지를 아침에 한 번 뽑는다.
   * 핵심: 하루 구간에 방문 시각을 무작위로 흩뿌리면 간격이 저절로 지수분포(포아송)가 된다.
   * 즉 '10분 만에 또 들어옴'과 '5시간 안 들어옴'이 자연히 섞인다 — 고정 간격보다 훨씬 사람답다.
   */
  type DayPlan = { day: string; times: number[]; done: number; rest: boolean };
  const warmupPlan = new Map<number, DayPlan>();
  const rnd = (a: number, b: number) => a + Math.floor(Math.random() * (b - a));

  function makeDayPlan(): DayPlan {
    const now = new Date();
    const day = now.toDateString();
    // 사람은 매일 들어오지 않는다 — 15%는 통째로 쉬는 날
    if (Math.random() < 0.15) return { day, times: [], done: 0, rest: true };
    // 시작·종료 시각도 매일 흔들린다 (07~10시 시작, 21~24시 끝)
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const from = midnight.getTime() + (7 + Math.random() * 3) * 3600_000;
    const to = midnight.getTime() + (21 + Math.random() * 3) * 3600_000;
    const n = rnd(3, 10); // 하루 3~9회
    const times = Array.from({ length: n }, () => from + Math.random() * (to - from)).sort((a, b) => a - b);
    return { day, times, done: 0, rest: false };
  }

  /** 화면에 보여줄 오늘 계획 요약 (워밍업 중이 아니면 빈 값) */
  function warmupPlanInfo(row: any) {
    const on = !!row.warmup_until && new Date(row.warmup_until).getTime() > Date.now();
    if (!on) return { warmup_next_at: null, warmup_today_total: 0, warmup_today_done: 0, warmup_rest_day: false };
    const p = dayPlanFor(row.id);
    return {
      warmup_next_at: p.rest ? null : (p.times[p.done] ?? null),
      warmup_today_total: p.times.length,
      warmup_today_done: Math.min(p.done, p.times.length),
      warmup_rest_day: p.rest,
    };
  }

  // 오늘 계획을 얻는다 (날짜가 바뀌었으면 새로 뽑음)
  function dayPlanFor(id: number): DayPlan {
    const today = new Date().toDateString();
    let p = warmupPlan.get(id);
    if (!p || p.day !== today) {
      p = makeDayPlan();
      warmupPlan.set(id, p);
    }
    return p;
  }

  // 상태를 갱신하면서 로그로도 남김 (어디서 멈추는지 화면에서 바로 보이게)
  const pushLog = (msg: string) => {
    autoStatus = msg;
    const t = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    autoLog.unshift(`[${t}] ${msg}`);
    if (autoLog.length > 12) autoLog.pop();
  };

  // 워밍업 중인 계정인지 (warmup_until 이 미래면 아직 답변 금지)
  const inWarmup = (id: number) => {
    const a = db().prepare('SELECT warmup_until FROM accounts WHERE id=?').get([id]) as any;
    return !!a?.warmup_until && new Date(a.warmup_until).getTime() > Date.now();
  };

  /* ---------- 워밍업: 답변 없이 사람처럼 지식인만 읽는다 (계정/프록시별) ---------- */
  // 한 세션 = 그 계정의 크롬(로그인한 프로필·프록시)으로 3~6분 읽기. 답변 절대 안 함.
  async function runWarmupOnce(accountId: number): Promise<{ ok: boolean; error?: string }> {
    if (foregroundBusy || hasOpenAccountContext()) return { ok: false, error: '열린 Chrome 창이나 진행 중인 작업이 있어 워밍업을 시작하지 않습니다.' };
    if (autoRunning) return { ok: false, error: '완전자동 실행 중에는 워밍업을 돌리지 않습니다.' };
    if (warmupBusy != null) return { ok: false, error: '다른 계정 워밍업이 진행 중입니다.' };
    const a = db().prepare('SELECT * FROM accounts WHERE id = ?').get([accountId]) as any;
    if (!a) return { ok: false, error: '계정을 찾을 수 없습니다.' };
    if (!a.proxy_host || !a.proxy_port) return { ok: false, error: '프록시가 없는 계정은 워밍업하지 않습니다.' };
    warmupBusy = accountId;
    try {
      const ctx = await getAccountContext(accountToProxy(a));
      // 로그인 전/후 읽기를 허용하되, 실제 페이지에서 인증 상태를 먼저 확인한다.
      // 로그인 후에는 계정 자체의 읽기 이력이 쌓인다. 둘 다 답변은 하지 않는다.
      pushLog(`[${a.naver_id}] 워밍업 시작 · 로그인 상태부터 확인합니다`);
      // 검색형 세션에서 쓸 관심 키워드 (등록한 브랜드 키워드를 그대로 씀)
      const kws = (db().prepare('SELECT keyword FROM keywords').all() as any[])
        .map((k) => String(k.keyword || '').trim())
        .filter(Boolean);
      const r = await runWarmupSession(ctx, (s) => pushLog(`[${a.naver_id}] 워밍업 · ${s}`), { keywords: kws });
      if (r.suspended) {
        db().prepare("UPDATE accounts SET status='suspect', warmup_until=NULL WHERE id=?").run([accountId]);
        pushLog(`⛔ [${a.naver_id}] 워밍업 중 보호조치/정지 감지 — 워밍업 중단 ("${r.suspended}")`);
        return { ok: false, error: r.suspended };
      }
      const kindLabel = r.kind === 'skim' ? '목록 훑기' : r.kind === 'search' ? '검색해 보기' : '깊게 읽기';
      pushLog(`[${a.naver_id}] 워밍업 세션 끝 (${kindLabel}) · 질문 ${r.opened}개 읽음`);
      db()
        .prepare('UPDATE accounts SET warmup_sessions=warmup_sessions+1, warmup_last_at=? WHERE id=?')
        .run([new Date().toISOString(), accountId]);
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Stop scheduled retries after any failure; the user can review and restart.
      db().prepare('UPDATE accounts SET warmup_until=NULL WHERE id=?').run([accountId]);
      warmupPlan.delete(accountId);
      pushLog(`[${a.naver_id}] 워밍업 오류: ${msg} · 예약을 해제했습니다. 확인 후 다시 시작해 주세요.`);
      return { ok: false, error: msg };
    } finally {
      await closeAccountContext(accountId).catch(() => {});
      warmupBusy = null;
    }
  }

  // 1분마다: 오늘 계획에서 시각이 된 계정 하나를 골라 세션 실행.
  // ponytail: 계정 하나씩 순차 실행 — 크롬 창 하나만 뜨게. 계정이 많아 세션이 밀리면 간격을 줄일 것.
  setInterval(() => {
    if (autoRunning || warmupBusy != null || foregroundBusy || hasOpenAccountContext()) return;
    const rows = db()
      .prepare("SELECT id FROM accounts WHERE warmup_until IS NOT NULL AND status='active' AND proxy_host IS NOT NULL")
      .all() as any[];
    const now = Date.now();
    for (const r of rows) {
      if (!inWarmup(r.id)) {
        // 기간 끝 → 투입 가능으로 전환
        const a = db().prepare('SELECT naver_id FROM accounts WHERE id=?').get([r.id]) as any;
        db().prepare('UPDATE accounts SET warmup_until=NULL WHERE id=?').run([r.id]);
        warmupPlan.delete(r.id);
        pushLog(`✅ [${a?.naver_id}] 워밍업 기간 종료 — 계정 안전성 확인을 뜻하지 않습니다. 답변 작업 시작 시 로그인을 별도로 확인합니다`);
        continue;
      }
      const plan = dayPlanFor(r.id);
      if (plan.rest) continue;
      // 앱이 꺼져 있던 동안 지나간 예정은 버린다 (켜자마자 몰아서 들어가지 않게)
      while (plan.done < plan.times.length && plan.times[plan.done] < now - 60 * 60 * 1000) plan.done++;
      if (plan.done < plan.times.length && plan.times[plan.done] <= now) {
        plan.done++;
        runWarmupOnce(r.id).catch(() => {});
        return;
      }
    }
  }, 60 * 1000);

  ipcMain.handle('accounts:warmupNow', (_e, id: number) => runWarmupOnce(id));

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
    if (!autoRunning) return true;
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
    if (foregroundBusy) return { ok: false, error: '로그인 또는 수동 작업을 먼저 마쳐주세요.' };
    if (autoRunning) return { ok: false, error: '이미 실행 중입니다.' };
    if (warmupBusy != null) return { ok: false, error: '워밍업 세션이 진행 중입니다. 몇 분 뒤 다시 시작하세요.' };
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
    // 워밍업 중인 계정은 답변에 투입하지 않는다 (읽기 이력만 쌓는 기간)
    const ready = proxied.filter((a) => !inWarmup(a.id));
    const warming = proxied.length - ready.length;
    if (!ready.length) {
      return { ok: false, error: '선택한 계정이 모두 워밍업 중입니다. 기간 종료 후 작업 시작 시 로그인을 별도로 확인합니다.' };
    }
    const skipped = accs.length - proxied.length;
    const useIds = ready.map((a) => a.id as number);
    autoRunning = true;
    autoStop = false;
    autoCount = 0;
    pushLog(useIds.length > 1 ? `시작 중… (${useIds.length}개 계정 교대)` : '시작 중…');
    if (skipped) pushLog(`⚠ 프록시 없는 계정 ${skipped}개는 제외했습니다`);
    if (warming) pushLog(`워밍업 중인 계정 ${warming}개는 답변에서 제외했습니다`);
    runAutopilot(useIds, opts.submit, opts.brandId, opts.useCollected)
      .catch((e) => {
        pushLog('오류: ' + (e instanceof Error ? e.message : String(e)));
      })
      .finally(async () => {
        autoNextResolve = null;
        await closeAllKinContexts().catch(() => {});
        autoRunning = false;
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
      const authPage = kinCtx.pages()[0] || await kinCtx.newPage();
      await authPage.goto('https://www.naver.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await requireAuthenticated(kinCtx, authPage, 8000);
      const okLogin = true;
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

      // 질문은 '열려 있는 크롬 탭'에서 읽는다 (별도 요청 없음 — 브라우저와 다른 지문의 요청이 섞이지 않게).
      // 수집 발행처럼 아직 안 열렸으면 여기서 연다. 이미 열려 있으면 그대로.
      let preloaded: { title?: string; body?: string } = {};
      if (kinCtx) {
        await pwOpenQuestion(kinCtx, targetUrl).catch(() => {});
        const openPages = (kinCtx as import('playwright').BrowserContext).pages();
        await requireAuthenticated(kinCtx, openPages[openPages.length - 1]);
        preloaded = await pwReadOpenQuestion(kinCtx);
        pushLog(
          `질문 확인: 제목 ${(preloaded.title || targetTitle || '').length}자 / 본문 ${(preloaded.body || '').length}자`,
        );
      }
      pushLog(`답변 생성 중: ${String(targetTitle).slice(0, 24)}`);
      const gen = (await doGenerate(
        qrow.id,
        brandId,
        isPromo,
        accountToProxy(acc),
        preloaded.title || preloaded.body ? preloaded : undefined,
      )) as any;
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
      // 시간 초과 시 Chrome을 닫고 전체 작업을 중단한다. 이전 입력과 다음 작업이 겹치지 않도록 한다.
      let res: { typed: boolean; submitted: boolean; error?: string };
      let answerTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        res = await Promise.race([
          pwAnswerQuestion(kinCtx!, targetUrl, gen.answer.body, submit, (s) => pushLog('· ' + s)),
          new Promise<never>((_, rej) =>
            answerTimer = setTimeout(
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
        await closeAccountContext(accountId).catch(() => {});
        autoStop = true;
        res = { typed: false, submitted: false, error: e instanceof Error ? e.message : String(e) };
      } finally {
        clearTimeout(answerTimer);
      }
      if (res.error?.includes('[AUTH_STOP]')) autoStop = true;
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
        if (autoStop) {
          pushLog(res.error);
          break;
        }
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
        if (e instanceof Error && e.message.includes('[AUTH_STOP]')) {
          autoStop = true;
          pushLog(e.message);
          break;
        }
        pushLog('이 질문 처리 중 오류 — 건너뛰고 계속: ' + (e instanceof Error ? e.message : String(e)));
        await sleepRnd(4000, 8000);
      }
    }
    autoStatus = autoStop ? '중지됨' : autoStatus;
  }
}
