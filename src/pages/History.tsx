import { useEffect, useState } from 'react';
import type { Answer, Brand } from '../env';

type Row = Answer & {
  question_title: string;
  question_url: string;
  question_asked_at: string | null;
  brand_name: string | null;
  account_naver_id: string | null;
};

const STATUS: Record<Answer['status'], { label: string; cls: string }> = {
  draft: { label: '초안', cls: '' },
  posted: { label: '등록됨', cls: 'green' },
  failed: { label: '실패', cls: 'red' },
};

type TypeFilter = 'all' | 'promo' | 'daily';

export default function History() {
  const [rows, setRows] = useState<Row[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [type, setType] = useState<TypeFilter>('all');
  const [brandId, setBrandId] = useState<number | 'all'>('all');
  const [date, setDate] = useState('');

  async function load() {
    const r = await window.api.answers.history({
      type: type === 'all' ? undefined : type,
      brandId: type === 'daily' || brandId === 'all' ? undefined : brandId,
      date: date || undefined,
    });
    setRows(r);
  }

  useEffect(() => {
    window.api.brands.list().then(setBrands);
  }, []);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, brandId, date]);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">답변 이력</div>
          <div className="page-sub">생성·등록한 답변 기록입니다. 홍보/일상, 브랜드, 날짜로 걸러 볼 수 있어요.</div>
        </div>
      </div>

      {/* 필터 */}
      <div
        className="card"
        style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', padding: 14 }}
      >
        <div className="segmented">
          {(['all', 'promo', 'daily'] as TypeFilter[]).map((t) => (
            <button
              key={t}
              className={type === t ? 'active' : ''}
              onClick={() => {
                setType(t);
                if (t === 'daily') setBrandId('all');
              }}
            >
              {t === 'all' ? '전체' : t === 'promo' ? '홍보글' : '일상글'}
            </button>
          ))}
        </div>

        {type !== 'daily' && (
          <select
            className="field"
            style={{ width: 180 }}
            value={brandId}
            onChange={(e) => setBrandId(e.target.value === 'all' ? 'all' : Number(e.target.value))}
          >
            <option value="all">브랜드 전체</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className="label" style={{ margin: 0 }}>
            날짜
          </span>
          <input
            className="field"
            type="date"
            style={{ width: 160 }}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          {date && (
            <button className="btn sm ghost" onClick={() => setDate('')}>
              전체 기간
            </button>
          )}
        </div>

        <span className="badge blue" style={{ marginLeft: 'auto' }}>
          {rows.length}건
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="empty">해당 조건의 이력이 없습니다.</div>
      ) : (
        <div className="card" style={{ padding: '4px 20px' }}>
          {rows.map((r) => (
            <div className="row" key={r.id}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className={`badge ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
                  {r.promo_included ? (
                    <span className="badge amber">홍보{r.brand_name ? ` · ${r.brand_name}` : ''}</span>
                  ) : (
                    <span className="badge">일상</span>
                  )}
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    {r.account_naver_id || '계정 미지정'} ·{' '}
                    {new Date(r.posted_at || r.created_at).toLocaleString('ko-KR')}
                    {r.question_asked_at ? ` · 질문작성 ${r.question_asked_at}` : ''}
                  </span>
                </div>
                <a
                  href={r.question_url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    fontWeight: 600,
                    fontSize: 14.5,
                    color: 'var(--text)',
                    textDecoration: 'none',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {r.question_title}
                </a>
                <div
                  className="muted"
                  style={{
                    fontSize: 13,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: 620,
                  }}
                >
                  {r.body.slice(0, 120)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
