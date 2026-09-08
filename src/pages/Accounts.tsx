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
    const id = newId.trim();
    if (!id) {
      toast('네이버 ID를 입력하세요.');
      return;
    }
    try {
      const res = await window.api.accounts.create(id);
      if (!res.ok) {
        toast(res.error || '계정 추가 실패');
        return;
      }
      setNewId('');
      await load();
      toast('계정 추가됨');
    } catch (e) {
      toast('계정 추가 중 오류: ' + (e instanceof Error ? e.message : String(e)));
    }
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
  const [loggingIn, setLoggingIn] = useState(false);
  const [ipInfo, setIpInfo] = useState<{
    stable: boolean;
    distinct: string[];
    anonymous?: boolean;
    leakHeaders?: Array<{ name: string; value: string }>;
  } | null>(null);
  const [checkingIp, setCheckingIp] = useState(false);
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
  // 프록시로 실제 나가는 IP가 고정인지 확인.
  // IP가 바뀌면 네이버가 세션을 끊고 계정을 잠근다("클릭하니 로그아웃"의 대표 원인).
  async function checkIp() {
    setCheckingIp(true);
    setIpInfo(null);
    try {
      const r = await window.api.accounts.checkProxyIp(account.id);
      if (!r.ok) {
        toast(r.error || 'IP 확인 실패');
        return;
      }
      setIpInfo({
        stable: !!r.stable,
        distinct: r.distinct || [],
        anonymous: r.anonymous,
        leakHeaders: r.leakHeaders,
      });
      if (r.anonymous === false) toast('⚠ 프록시가 흔적 헤더를 붙입니다 — 네이버가 프록시를 알아챕니다');
      else toast(r.stable ? `프록시 정상 ✓ ${r.distinct?.[0]}` : `⚠ IP가 바뀝니다 (${r.distinct?.length}개)`);
    } finally {
      setCheckingIp(false);
    }
  }

  // 진짜 Chrome 창을 연다. 로그인하든 그냥 둘러보든, 창을 닫으면 세션이 저장된다.
  async function openChrome(mode: 'login' | 'browse') {
    setLoggingIn(true);
    try {
      const res =
        mode === 'login'
          ? await window.api.accounts.login(account.id)
          : await window.api.accounts.openBrowser(account.id);
      if (!res.ok) toast(res.error || '브라우저 열기 실패');
      else toast('브라우저를 닫았습니다 — 세션 저장됨');
    } finally {
      setLoggingIn(false);
    }
  }

  const hasProxy = !!(account.proxy_host && account.proxy_port);

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
              {!hasProxy && <span className="badge red">프록시 없음 · 로그인 차단</span>}
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              프록시:{' '}
              {hasProxy ? (
                `${account.proxy_host}:${account.proxy_port}${account.proxy_user ? ' (인증)' : ''}`
              ) : (
                <span style={{ color: 'var(--red)' }}>연결 안 됨 (IP 노출 방지로 로그인·등록 불가)</span>
              )}
              {' · '}일일 한도 {account.daily_limit}건{account.memo ? ` · ${account.memo}` : ''}
            </div>
            {ipInfo && (
              <div
                style={{
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  color: ipInfo.stable && ipInfo.anonymous !== false ? 'var(--text-sub)' : 'var(--red, #e5484d)',
                  background: ipInfo.stable && ipInfo.anonymous !== false ? 'var(--bg-soft)' : 'rgba(229,72,77,0.07)',
                  border: `1px solid ${ipInfo.stable && ipInfo.anonymous !== false ? 'var(--border)' : 'rgba(229,72,77,0.18)'}`,
                  borderRadius: 8,
                  padding: '6px 10px',
                }}
              >
                {ipInfo.anonymous === false ? (
                  <>
                    ⚠ 이 프록시는 <b>자기 흔적 헤더</b>를 붙입니다 (
                    {(ipInfo.leakHeaders || []).map((h) => h.name).join(', ')})
                    <br />
                    IP가 고정이어도 네이버는 <b>프록시 접속임을 바로 알아챕니다.</b> 익명(elite) 프록시로 교체하세요.
                    {(ipInfo.leakHeaders || []).some((h) => /forwarded-for|real-ip|client-ip/i.test(h.name)) && (
                      <>
                        <br />
                        특히 이 헤더엔 <b>내 실제 IP가 담겨</b> 전달됩니다.
                      </>
                    )}
                  </>
                ) : ipInfo.stable ? (
                  <>출구 IP 고정 ✓ <b>{ipInfo.distinct[0]}</b>{ipInfo.anonymous ? ' · 익명성 정상 ✓' : ''} — 세션 끊김 원인 아님</>
                ) : (
                  <>
                    ⚠ 출구 IP가 <b>{ipInfo.distinct.length}개</b>로 바뀝니다 ({ipInfo.distinct.join(', ')})
                    <br />
                    네이버가 세션 탈취로 보고 로그인을 끊습니다. <b>고정 IP 프록시로 교체해야 합니다.</b>
                  </>
                )}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn sm primary"
              onClick={() => openChrome('login')}
              disabled={!hasProxy || loggingIn}
              title={hasProxy ? '실제 Chrome이 열립니다. 로그인하면 자동 감지하고, 창은 계속 쓰다가 닫으면 됩니다' : '프록시를 먼저 등록해야 로그인할 수 있습니다'}
            >
              {loggingIn ? '브라우저 사용 중…' : '로그인 (실제 Chrome)'}
            </button>
            <button
              className="btn sm"
              onClick={checkIp}
              disabled={!hasProxy || checkingIp}
              title="프록시로 나가는 IP가 고정인지 확인합니다. IP가 바뀌면 네이버가 로그인을 끊습니다"
            >
              {checkingIp ? '진단 중…' : '프록시 진단'}
            </button>
            <button
              className="btn sm"
              onClick={() => openChrome('browse')}
              disabled={!hasProxy || loggingIn}
              title="이 계정의 Chrome을 그냥 엽니다 (프로필 설정·둘러보기·워밍업용)"
            >
              브라우저 열기
            </button>
            <button className="btn sm" onClick={() => setEdit(true)}>
              {hasProxy ? '수정' : '프록시 등록'}
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
