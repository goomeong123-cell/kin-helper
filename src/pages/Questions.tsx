import { useEffect, useState } from 'react';
import type { Account, Answer, Brand, Question, PostMode } from '../env';
import { useToast } from '../lib/toast';

const MODE_LABEL: Record<PostMode, string> = {
  manual: '사람 검토',
  semi: '반자동',
  auto: '완전 자동',
};
const MODE_HINT: Record<PostMode, string> = {
  manual: '답변을 확인·수정 후 창에서 직접 등록',
  semi: '에디터에 자동 입력, 등록 버튼만 직접',
  auto: '입력·등록까지 자동 (정지 위험 큼)',
};

export default function Questions() {
  const toast = useToast();
  const [brands, setBrands] = useState<Brand[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeBrand, setActiveBrand] = useState<number | 'all'>('all');
  const [questions, setQuestions] = useState<Question[]>([]);
  // 질문별 최신 초안 — DB에서 로드하므로 탭을 옮겼다 와도 유지됨
  const [answersByQ, setAnswersByQ] = useState<Record<number, Answer>>({});
  const [mode, setMode] = useState<PostMode>('manual');
  const [accountId, setAccountId] = useState<number | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [promoRatio, setPromoRatio] = useState(20);
  const [genAll, setGenAll] = useState(false);

  async function loadDrafts() {
    const drafts = await window.api.answers.drafts();
    const map: Record<number, Answer> = {};
    for (const d of drafts) map[d.question_id] = d;
    setAnswersByQ(map);
  }

  async function refresh() {
    const b = await window.api.brands.list();
    setBrands(b);
    const acc = await window.api.accounts.list();
    setAccounts(acc);
    if (acc.length && accountId === null) setAccountId(acc[0].id);
    const r = await window.api.settings.get('promo_ratio');
    setPromoRatio(r ? Number(r) : 20);
    const qs = await window.api.questions.list({
      status: 'new',
      brandId: activeBrand === 'all' ? undefined : activeBrand,
    });
    setQuestions(qs);
    await loadDrafts();
    // 전체 생성이 돌고 있으면(탭 이동 후 복귀) 진행 상태를 이어받음
    const st = await window.api.answers.generateAllStatus();
    setGenAll(st.running);
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBrand]);

  // 전체 생성 진행 중엔 주기적으로 초안을 갱신 (진행 상황이 보이게)
  useEffect(() => {
    if (!genAll) return;
    const t = window.setInterval(async () => {
      await loadDrafts();
      const st = await window.api.answers.generateAllStatus();
      if (!st.running) {
        setGenAll(false);
        toast('전체 답변 생성 완료');
      }
    }, 3000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genAll]);

  async function collect() {
    setCollecting(true);
    try {
      const res = await window.api.questions.collect({
        brandId: activeBrand === 'all' ? undefined : activeBrand,
        accountId: accountId ?? undefined,
      });
      toast(res.ok ? `질문 ${res.inserted}건 수집` : '수집 실패');
      await refresh();
    } finally {
      setCollecting(false);
    }
  }

  function generateAll() {
    const targets = questions.filter((q) => !answersByQ[q.id]);
    if (targets.length === 0) {
      toast('이미 모든 질문에 답변 초안이 있습니다.');
      return;
    }
    setGenAll(true);
    toast(`${targets.length}건 답변 생성 시작 (탭 옮겨도 계속됩니다)`);
    // await 하지 않음 — 메인 프로세스에서 계속 도므로 탭을 옮겨도 진행됨
    window.api.answers
      .generateAll(questions.map((q) => q.id))
      .then(async (res) => {
        await loadDrafts();
        setGenAll(false);
        if (!res.ok) toast(res.error || '전체 생성 실패');
        else toast(`전체 생성 완료 · 성공 ${res.done} / 실패 ${res.failed}`);
      })
      .catch(() => setGenAll(false));
  }

  async function skip(q: Question) {
    await window.api.questions.setStatus(q.id, 'skipped');
    setQuestions((prev) => prev.filter((x) => x.id !== q.id));
  }

  const pending = questions.filter((q) => !answersByQ[q.id]).length;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">질문·답변</div>
          <div className="page-sub">답변 대기 질문을 수집하고, 자연스러운 답변을 만들어 등록합니다.</div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div className="segmented">
            {(['manual', 'semi', 'auto'] as PostMode[]).map((m) => (
              <button
                key={m}
                className={mode === m ? 'active' : ''}
                onClick={() => setMode(m)}
                title={MODE_HINT[m]}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
          <button className="btn" onClick={collect} disabled={collecting}>
            {collecting ? <span className="spinner" /> : '질문 수집'}
          </button>
          <button
            className="btn primary"
            onClick={generateAll}
            disabled={genAll || questions.length === 0}
            title="답변이 없는 질문 전체에 답변을 생성합니다"
          >
            {genAll ? <span className="spinner" /> : `전체 답변 생성${pending ? ` (${pending})` : ''}`}
          </button>
        </div>
      </div>

      <div style={{ marginBottom: 6 }} className="page-sub">
        등록 모드: <b>{MODE_LABEL[mode]}</b> · {MODE_HINT[mode]}
        {genAll && ' · 전체 생성 진행 중… (다른 탭 가도 계속됩니다)'}
      </div>

      {/* 브랜드 탭 */}
      <div className="tabs">
        <button
          className={`tab ${activeBrand === 'all' ? 'active' : ''}`}
          onClick={() => setActiveBrand('all')}
        >
          전체
        </button>
        {brands.map((b) => (
          <button
            key={b.id}
            className={`tab ${activeBrand === b.id ? 'active' : ''}`}
            onClick={() => setActiveBrand(b.id)}
          >
            {b.name}
          </button>
        ))}
      </div>

      {/* 계정 선택 */}
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14 }}>
        <span className="label" style={{ margin: 0 }}>
          등록 계정
        </span>
        {accounts.length === 0 ? (
          <span className="muted">계정·프록시 탭에서 네이버 계정을 먼저 등록하세요.</span>
        ) : (
          <select
            className="field"
            style={{ maxWidth: 260 }}
            value={accountId ?? ''}
            onChange={(e) => setAccountId(Number(e.target.value))}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.naver_id} {a.proxy_host ? `· ${a.proxy_host}` : '· 프록시 없음(등록 불가)'}
              </option>
            ))}
          </select>
        )}
      </div>

      {questions.length === 0 ? (
        <div className="empty">
          답변 대기 질문이 없습니다.
          <br />
          상단의 “질문 수집”을 눌러 가져오세요.
        </div>
      ) : (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {questions.map((q) => (
            <QuestionCard
              key={q.id}
              q={q}
              brands={brands}
              mode={mode}
              accountId={accountId}
              promoRatio={promoRatio}
              answer={answersByQ[q.id]}
              onGenerated={(a) => setAnswersByQ((prev) => ({ ...prev, [q.id]: a }))}
              onSkip={() => skip(q)}
              onAnswered={() => setQuestions((prev) => prev.filter((x) => x.id !== q.id))}
            />
          ))}
        </div>
      )}
    </>
  );
}

function QuestionCard({
  q,
  brands,
  mode,
  accountId,
  promoRatio,
  answer,
  onGenerated,
  onSkip,
  onAnswered,
}: {
  q: Question;
  brands: Brand[];
  mode: PostMode;
  accountId: number | null;
  promoRatio: number;
  answer?: Answer;
  onGenerated: (a: Answer) => void;
  onSkip: () => void;
  onAnswered: () => void;
}) {
  const toast = useToast();
  const [body, setBody] = useState(answer?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [brandId, setBrandId] = useState<number | null>(q.matched_brand_id);

  const brand = brands.find((b) => b.id === brandId) || null;
  const brandHasPromo = !!brand?.promo_text;

  // 비율에 따라 이 질문의 홍보 포함 기본값 결정 (질문마다 랜덤 → 전체적으로 비율 수렴)
  const [includePromo, setIncludePromo] = useState(false);
  useEffect(() => {
    if (brandHasPromo) setIncludePromo(Math.random() * 100 < promoRatio);
    else setIncludePromo(false);
  }, [brandId, brandHasPromo, promoRatio]);

  // 초안이 (전체 생성 등으로) 새로 들어오면 본문 동기화
  useEffect(() => {
    if (answer) setBody(answer.body);
  }, [answer?.id]);

  async function generate() {
    setBusy(true);
    try {
      const res = await window.api.answers.generate({
        questionId: q.id,
        brandId: brandId ?? undefined,
        includePromo: brandHasPromo && includePromo,
      });
      if (!res.ok || !res.answer) {
        toast(res.error || '생성 실패');
        return;
      }
      onGenerated(res.answer);
      setBody(res.answer.body);
    } finally {
      setBusy(false);
    }
  }

  async function post() {
    if (!answer) return;
    if (!accountId) {
      toast('등록 계정을 먼저 선택하세요.');
      return;
    }
    setBusy(true);
    try {
      if (body !== answer.body) await window.api.answers.updateBody(answer.id, body);
      const res = await window.api.answers.post({ answerId: answer.id, accountId, mode });
      if (!res.ok) {
        toast(res.error || '등록 창 열기 실패');
        return;
      }
      if (mode === 'auto' && res.needsHuman === false) {
        toast('자동 등록 완료');
        onAnswered();
      } else {
        toast(res.error || '등록 창을 열었습니다. 창에서 마무리해 주세요.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function markDone() {
    if (!answer) return;
    await window.api.answers.markPosted(answer.id, accountId ?? undefined);
    toast('등록 완료로 표시');
    onAnswered();
  }

  return (
    <div className="card q-card">
      <div className="q-title">{q.title}</div>
      <div className="q-meta">
        <span className="badge">지식인</span>
        {q.matched_keyword && <span className="badge blue">{q.matched_keyword}</span>}
        {answer && <span className="badge green">답변 준비됨</span>}
        <a href={q.url} target="_blank" rel="noreferrer" className="muted">
          원문 보기 ↗
        </a>
      </div>

      {!answer ? (
        <div className="q-actions">
          <select
            className="field"
            style={{ maxWidth: 180 }}
            value={brandId ?? ''}
            onChange={(e) => setBrandId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">브랜드 없음</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          {brandHasPromo && (
            <button
              className={`btn sm ${includePromo ? 'primary' : 'ghost'}`}
              onClick={() => setIncludePromo((v) => !v)}
              title="이 답변에 제품 홍보를 섞을지 (설정의 홍보 비율로 기본값 결정)"
            >
              {includePromo ? '✓ 제품 홍보 포함' : '제품 홍보 끔'}
            </button>
          )}
          <button className="btn primary" onClick={generate} disabled={busy}>
            {busy ? <span className="spinner" /> : '답변 생성'}
          </button>
          <button className="btn ghost" onClick={onSkip}>
            건너뛰기
          </button>
        </div>
      ) : (
        <>
          <textarea
            className="field"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
          />
          {answer.promo_included ? (
            <span className="badge amber" style={{ alignSelf: 'flex-start' }}>
              제품 노출 포함
            </span>
          ) : (
            <span className="badge" style={{ alignSelf: 'flex-start' }}>
              일상글 (홍보 없음)
            </span>
          )}
          <div className="q-actions">
            <button className="btn primary" onClick={post} disabled={busy}>
              {busy ? <span className="spinner" /> : `${MODE_LABEL[mode]}로 등록`}
            </button>
            <button className="btn" onClick={generate} disabled={busy}>
              다시 생성
            </button>
            <button className="btn sm ghost" onClick={markDone}>
              등록 완료 표시
            </button>
          </div>
        </>
      )}
    </div>
  );
}
