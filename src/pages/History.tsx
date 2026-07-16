import { useEffect, useState } from 'react';
import type { Answer } from '../env';

type Row = Answer & {
  question_title: string;
  question_url: string;
  brand_name: string | null;
  account_naver_id: string | null;
};

const STATUS: Record<Answer['status'], { label: string; cls: string }> = {
  draft: { label: '초안', cls: '' },
  posted: { label: '등록됨', cls: 'green' },
  failed: { label: '실패', cls: 'red' },
};

export default function History() {
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    window.api.answers.history().then(setRows);
  }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">답변 이력</div>
          <div className="page-sub">생성·등록한 답변 기록입니다.</div>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty">아직 이력이 없습니다.</div>
      ) : (
        <div className="card" style={{ padding: '4px 20px' }}>
          {rows.map((r) => (
            <div className="row" key={r.id}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className={`badge ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
                  {r.brand_name && <span className="badge blue">{r.brand_name}</span>}
                  {r.promo_included ? <span className="badge amber">홍보</span> : null}
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    {r.account_naver_id || '계정 미지정'} · {new Date(r.created_at).toLocaleString('ko-KR')}
                  </span>
                </div>
                <a
                  href={r.question_url}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontWeight: 600, fontSize: 14.5, color: 'var(--text)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {r.question_title}
                </a>
                <div className="muted" style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 620 }}>
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
