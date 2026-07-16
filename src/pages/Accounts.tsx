import { useEffect, useState } from 'react';
import type { Account } from '../env';
import { useToast } from '../lib/toast';

const STATUS_BADGE: Record<Account['status'], string> = {
  active: 'green',
  rest: 'amber',
  suspect: 'red',
};
const STATUS_LABEL: Record<Account['status'], string> = {
  active: '활성',
  rest: '휴식',
  suspect: '정지의심',
};

export default function Accounts() {
  const toast = useToast();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [newId, setNewId] = useState('');

  async function load() {
    setAccounts(await window.api.accounts.list());
  }
  useEffect(() => {
    load();
  }, []);

  async function add() {
    if (!newId.trim()) return;
    await window.api.accounts.create(newId.trim());
    setNewId('');
    load();
    toast('계정 추가');
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">계정·프록시</div>
          <div className="page-sub">네이버 ID마다 프록시 IP를 1:1로 연결합니다. 로그인은 각 계정 창에서 직접 하세요.</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="field"
            style={{ width: 200 }}
            placeholder="네이버 ID"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button className="btn primary" onClick={add}>
            계정 추가
          </button>
        </div>
      </div>

      {accounts.length === 0 ? (
        <div className="empty">등록된 계정이 없습니다.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {accounts.map((a) => (
            <AccountCard key={a.id} account={a} onChange={load} />
          ))}
        </div>
      )}
    </>
  );
}

function AccountCard({ account, onChange }: { account: Account; onChange: () => void }) {
  const toast = useToast();
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({
    naver_id: account.naver_id,
    memo: account.memo || '',
    daily_limit: account.daily_limit,
    status: account.status,
    proxy_host: account.proxy_host || '',
    proxy_port: account.proxy_port || '',
    proxy_user: account.proxy_user || '',
    proxy_pass: account.proxy_pass || '',
  });

  async function save() {
    await window.api.accounts.update(account.id, f);
    setEdit(false);
    onChange();
    toast('저장됨');
  }
  async function del() {
    if (!confirm(`'${account.naver_id}' 계정을 삭제할까요? (로그인 세션도 함께 사용 불가)`)) return;
    await window.api.accounts.remove(account.id);
    onChange();
  }
  async function login() {
    const res = await window.api.accounts.login(account.id);
    if (!res.ok) toast(res.error || '로그인 창 열기 실패');
  }

  if (!edit) {
    return (
      <div className="card">
        <div className="row" style={{ borderBottom: 'none', padding: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 15.5 }}>{account.naver_id}</span>
              <span className={`badge ${STATUS_BADGE[account.status]}`}>
                {STATUS_LABEL[account.status]}
              </span>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              프록시:{' '}
              {account.proxy_host
                ? `${account.proxy_host}:${account.proxy_port}${account.proxy_user ? ' (인증)' : ''}`
                : '연결 안 됨'}
              {' · '}일일 한도 {account.daily_limit}건{account.memo ? ` · ${account.memo}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn sm primary" onClick={login}>
              로그인 창
            </button>
            <button className="btn sm" onClick={() => setEdit(true)}>
              수정
            </button>
            <button className="btn sm danger" onClick={del}>
              삭제
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="grid2">
        <div>
          <label className="label">네이버 ID</label>
          <input className="field" value={f.naver_id} onChange={(e) => setF({ ...f, naver_id: e.target.value })} />
        </div>
        <div>
          <label className="label">상태</label>
          <select
            className="field"
            value={f.status}
            onChange={(e) => setF({ ...f, status: e.target.value as Account['status'] })}
          >
            <option value="active">활성</option>
            <option value="rest">휴식</option>
            <option value="suspect">정지의심</option>
          </select>
        </div>
        <div>
          <label className="label">프록시 호스트</label>
          <input className="field" placeholder="1.2.3.4" value={f.proxy_host} onChange={(e) => setF({ ...f, proxy_host: e.target.value })} />
        </div>
        <div>
          <label className="label">프록시 포트</label>
          <input className="field" placeholder="8080" value={f.proxy_port} onChange={(e) => setF({ ...f, proxy_port: e.target.value })} />
        </div>
        <div>
          <label className="label">프록시 아이디 (선택)</label>
          <input className="field" value={f.proxy_user} onChange={(e) => setF({ ...f, proxy_user: e.target.value })} />
        </div>
        <div>
          <label className="label">프록시 비밀번호 (선택)</label>
          <input className="field" type="password" value={f.proxy_pass} onChange={(e) => setF({ ...f, proxy_pass: e.target.value })} />
        </div>
        <div>
          <label className="label">일일 답변 한도</label>
          <input
            className="field"
            type="number"
            value={f.daily_limit}
            onChange={(e) => setF({ ...f, daily_limit: Number(e.target.value) })}
          />
        </div>
        <div>
          <label className="label">메모</label>
          <input className="field" value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} />
        </div>
      </div>
      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <button className="btn primary" onClick={save}>
          저장
        </button>
        <button className="btn ghost" onClick={() => setEdit(false)}>
          취소
        </button>
      </div>
    </div>
  );
}
