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
    // 워밍업 진행(세션 수·다음 시각·읽는 중)이 바뀌는 게 보이도록 주기 갱신
    const t = window.setInterval(() => {
      if (!document.hidden) load();
    }, 10000);
    return () => window.clearInterval(t);
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
          <div className="note danger" style={{ marginTop: 10, fontSize: 13, padding: '10px 12px' }}>
            로그인 실패·추가 인증·보호조치가 표시되면 작업을 중단하고 화면 안내를 확인하세요.
            <br />프록시·기기 진단은 측정 결과이며, 계정 안전이나 보호조치 예방을 보장하지 않습니다.
          </div>
        </div>
        <div className="btn-group">
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

const hm = (ms: number) => new Date(ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

// 워밍업 진행 상황: 경과 바 + 세션 수 + 마지막/다음 세션
function WarmupProgress({ account }: { account: Account }) {
  const end = new Date(account.warmup_until || 0).getTime();
  const start = account.warmup_started_at ? new Date(account.warmup_started_at).getTime() : end - 3 * 86400000;
  const now = Date.now();
  const pct = Math.max(0, Math.min(100, ((now - start) / (end - start)) * 100));
  const elapsedH = Math.max(0, Math.floor((now - start) / 3600000));
  const totalH = Math.round((end - start) / 3600000);
  const busy = !!account.warmup_busy;
  const next = account.warmup_next_at ?? null;
  const last = account.warmup_last_at ? new Date(account.warmup_last_at).getTime() : null;
  const h = new Date().getHours();
  const offHours = h < 8 || h >= 23;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 520 }}>
      <div className={`progress ${busy ? 'busy' : ''}`} aria-label="워밍업 진행률">
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="muted" style={{ fontSize: 12.5, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <b style={{ color: 'var(--text)' }}>
          {Math.floor(elapsedH / 24)}일 {elapsedH % 24}시간 / {Math.round(totalH / 24)}일
        </b>
        <span>· 읽기 세션 {account.warmup_sessions ?? 0}회</span>
        {!!account.warmup_today_total && (
          <span>
            · 오늘 {account.warmup_today_done ?? 0}/{account.warmup_today_total}회
          </span>
        )}
        {last != null && <span>· 마지막 {hm(last)}</span>}
        {busy ? (
          <span style={{ color: 'var(--blue-dark)', fontWeight: 700 }}>· 지금 크롬에서 읽는 중</span>
        ) : account.warmup_rest_day ? (
          <span>· 오늘은 쉬는 날</span>
        ) : offHours ? (
          <span>· 밤엔 쉼</span>
        ) : next != null ? (
          <span>· 다음 {next <= now ? '곧' : `~${hm(next)}`}</span>
        ) : (
          <span>· 곧 첫 세션</span>
        )}
      </div>
    </div>
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
    clockSkewSec?: number | null;
    line?: { netname: string; org: string; type: 'carrier' | 'hosting' | 'unknown' };
  } | null>(null);
  const [checkingIp, setCheckingIp] = useState(false);
  const [fpInfo, setFpInfo] = useState<{
    webglRenderer: string; vmLike: boolean; cores: number | null; memory: number | null;
    screen: string; canvasHash: string; fingerprintHash: string; webrtcLeak: boolean; leakedPublicIps: string[];
  } | null>(null);
  const [checkingFp, setCheckingFp] = useState(false);
  const [f, setF] = useState({
    naver_id: account.naver_id,
    memo: account.memo || '',
    daily_limit: account.daily_limit,
    status: account.status,
    proxy_host: account.proxy_host || '',
    proxy_port: account.proxy_port || '',
    proxy_user: account.proxy_user || '',
    proxy_pass: account.proxy_pass || '',
    clear_password: false,
    naver_pw: '', // 비워두면 기존 비밀번호 유지 (화면으로는 절대 불러오지 않음)
  });

  async function save() {
    const result = await window.api.accounts.update(account.id, f);
    if (!result || 'error' in result) { toast(result && 'error' in result ? result.error : '계정을 저장하지 못했습니다.'); return; }
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
        clockSkewSec: r.clockSkewSec,
        line: r.line,
      });
      if (r.line?.type === 'hosting') toast('⚠ 서버 호스팅(IDC) 대역 IP입니다 — 통신사 회선 프록시로 바꾸세요');
      if (r.anonymous === false) toast('검사 응답에서 전달 헤더가 발견됐습니다');
      else toast(r.stable ? `측정 중 IP 동일 ${r.distinct?.[0]}` : `⚠ IP가 다르거나 일부 측정에 실패했습니다 (${r.distinct?.length}개)`);
    } finally {
      setCheckingIp(false);
    }
  }

  // 이 계정의 실제 크롬이 네이버에 보여주는 기기 지문 (읽기 전용). GPU가 VM처럼 보이는지 확인용.
  async function checkFp() {
    setCheckingFp(true);
    setFpInfo(null);
    try {
      const r = await window.api.accounts.fingerprint(account.id);
      if (!r.ok) {
        toast(r.error || '지문 측정 실패');
        return;
      }
      setFpInfo({
        webglRenderer: r.webglRenderer || '', vmLike: !!r.vmLike, cores: r.cores ?? null, memory: r.memory ?? null,
        screen: r.screen || '', canvasHash: r.canvasHash || '', fingerprintHash: r.fingerprintHash || '',
        webrtcLeak: !!r.webrtcLeak, leakedPublicIps: r.leakedPublicIps || [],
      });
      toast(r.vmLike ? '⚠ GPU가 VM/소프트웨어 렌더러로 잡힙니다' : '기기 지문 측정 완료');
    } finally {
      setCheckingFp(false);
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
      else toast(mode === 'login' ? '로그인 확인됨 · Chrome을 닫지 않고 작업을 시작하세요.' : '브라우저를 열었습니다.');
    } finally {
      setLoggingIn(false);
    }
  }

  const hasProxy = !!(account.proxy_host && account.proxy_port);
  // 워밍업: 답변 없이 지식인만 읽는 기간. 기간 종료 후에도 답변 시작 시 로그인을 별도로 확인한다.
  const warmupEnd = account.warmup_until ? new Date(account.warmup_until).getTime() : 0;
  const warming = warmupEnd > Date.now();
  const warmupDaysLeft = warming ? Math.ceil((warmupEnd - Date.now()) / 86400000) : 0;
  const [warmingNow, setWarmingNow] = useState(false);

  async function setWarmup(days: number | null) {
    const until = days ? new Date(Date.now() + days * 86400000).toISOString() : '';
    await window.api.accounts.update(account.id, { warmup_until: until });
    onChange();
    toast(days ? `워밍업 ${days}일 시작 — 이 기간엔 답변하지 않고 읽기만 합니다` : '워밍업 종료 — 답변 시작 시 로그인 상태를 별도로 확인합니다');
  }
  async function warmupNow() {
    setWarmingNow(true);
    try {
      const r = await window.api.accounts.warmupNow(account.id);
      toast(r.ok ? '워밍업 세션 완료' : r.error || '워밍업 실패');
    } finally {
      setWarmingNow(false);
    }
  }

  if (!edit) {
    return (
      <div className="card">
        <div className="row" style={{ borderBottom: 'none', padding: 0, alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: '1 1 320px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: 15.5 }}>{account.naver_id}</span>
              <span className={`badge ${STATUS_BADGE[account.status]}`}>
                {STATUS_LABEL[account.status]}
              </span>
              {!hasProxy && <span className="badge red">프록시 없음 · 로그인 차단</span>}
              {warming && (
                <span className="badge amber" title="답변 없이 지식인만 읽는 기간. 기간 종료는 계정 안전성 확인을 뜻하지 않습니다">
                  워밍업 중 · {warmupDaysLeft}일 남음
                </span>
              )}
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              프록시:{' '}
              {hasProxy ? (
                `${account.proxy_host}:${account.proxy_port}${account.proxy_user ? ' (인증)' : ''}`
              ) : (
                <span style={{ color: 'var(--red-ink)' }}>연결 안 됨 (IP 노출 방지로 로그인·등록 불가)</span>
              )}
              {' · '}일일 한도 {account.daily_limit}건{account.memo ? ` · ${account.memo}` : ''}
            </div>
            {warming && <WarmupProgress account={account} />}
            {fpInfo && (
              <div className={`note ${fpInfo.vmLike || fpInfo.webrtcLeak ? 'danger' : ''}`}>
                GPU: <b>{fpInfo.webglRenderer || '(없음)'}</b>
                {fpInfo.vmLike ? (
                  <>
                    <br />⚠ <b>소프트웨어 렌더러 관련 문자열이 관측됐습니다.</b>
                    이 결과만으로 계정 안전이나 보호조치 여부를 판단할 수 없습니다.
                  </>
                ) : (
                  ' · GPU 문자열 확인'
                )}
                <br />
                코어 {fpInfo.cores ?? '?'} · 메모리 {fpInfo.memory ?? '?'}GB · 화면 {fpInfo.screen} · 캔버스 {fpInfo.canvasHash} ·{' '}
                지문 해시 <b>{fpInfo.fingerprintHash}</b>
                <span className="muted"> (브라우저 정보 비교용 · 안전 판정 아님)</span>
                {fpInfo.webrtcLeak && (
                  <>
                    <br />⚠ WebRTC로 프록시 밖 IP가 보입니다: {fpInfo.leakedPublicIps.join(', ')}
                  </>
                )}
              </div>
            )}
            {ipInfo && (
              <div className={`note ${ipInfo.stable && ipInfo.anonymous !== false && ipInfo.line?.type !== 'hosting' ? '' : 'danger'}`}>
                {ipInfo.line && (
                  <>
                    회선:{' '}
                    {ipInfo.line.type === 'carrier' ? (
                      <b>통신사 회선 ✓</b>
                    ) : ipInfo.line.type === 'hosting' ? (
                      <b>⚠ 서버 호스팅(IDC) 대역</b>
                    ) : (
                      <b>판별 불가</b>
                    )}
                    {ipInfo.line.netname ? ` (${ipInfo.line.netname})` : ''}
                    {ipInfo.line.type === 'hosting' && (
                      <> — 네이버가 가정용 회선과 바로 구분합니다. 판매처에 <b>KT/SK/LG 유선 또는 LTE 회선</b>인지 확인하고 교체하세요.</>
                    )}
                    {ipInfo.line.type === 'unknown' && ' — 대역명으로 판별되지 않았습니다. 판매처에 회선 종류를 직접 확인하세요.'}
                    <br />
                  </>
                )}
                {ipInfo.anonymous === false ? (
                  <>
                    ⚠ 이 프록시는 <b>자기 흔적 헤더</b>를 붙입니다 (
                    {(ipInfo.leakHeaders || []).map((h) => h.name).join(', ')})
                    <br />
                    검사 서비스가 응답한 헤더입니다. <b>네이버의 계정 판단 결과는 아닙니다.</b>
                    {(ipInfo.leakHeaders || []).some((h) => /forwarded-for|real-ip|client-ip/i.test(h.name)) && (
                      <>
                        <br />
                        이 헤더에는 <b>접속 경로의 IP 정보</b>가 포함될 수 있습니다.
                      </>
                    )}
                  </>
                ) : ipInfo.stable ? (
                  <>
                    측정 중 출구 IP 동일 <b>{ipInfo.distinct[0]}</b>
                    {ipInfo.anonymous ? ' · 검사한 헤더 미검출' : ''}
                    {typeof ipInfo.clockSkewSec === 'number' &&
                      (Math.abs(ipInfo.clockSkewSec) > 60 ? (
                        <>
                          <br />
                          <span style={{ color: 'var(--red-ink)' }}>
                            ⚠ VM 시계가 <b>{ipInfo.clockSkewSec}초</b> 어긋남 — 세션이 끊길 수 있습니다.
                            Windows 시간 동기화를 켜주세요.
                          </span>
                        </>
                      ) : (
                        ' · 측정 시 시각 차이 60초 이내'
                      ))}
                  </>
                ) : (
                  <>
                    ⚠ 측정이 불완전하거나 서로 다른 IP <b>{ipInfo.distinct.length}개</b>가 관측됐습니다 ({ipInfo.distinct.join(', ')})
                    <br />
                    <b>프록시 연결 상태를 확인하세요.</b> 이 결과만으로 로그아웃 원인을 확정할 수 없습니다.
                  </>
                )}
              </div>
            )}
          </div>
          <div className="btn-group">
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
              onClick={checkFp}
              disabled={!hasProxy || checkingFp}
              title="이 계정의 실제 크롬이 네이버에 보여주는 GPU·화면·캔버스 지문을 측정합니다 (위장 아님, 읽기 전용)"
            >
              {checkingFp ? '측정 중…' : '지문 진단'}
            </button>
            <button
              className="btn sm"
              onClick={() => openChrome('browse')}
              disabled={!hasProxy || loggingIn}
              title="이 계정의 Chrome을 그냥 엽니다 (프로필 설정·둘러보기·워밍업용)"
            >
              브라우저 열기
            </button>
            {warming ? (
              <>
                <button
                  className="btn sm"
                  onClick={warmupNow}
                  disabled={!hasProxy || warmingNow}
                  title="지금 바로 워밍업 세션 한 번 (3~6분 읽기만). 평소엔 08~23시에 90~180분마다 자동으로 돕니다"
                >
                  {warmingNow ? '읽는 중…' : '지금 한 번'}
                </button>
                <button className="btn sm" onClick={() => setWarmup(null)} title="워밍업 예약을 종료합니다. 답변 시작 시 로그인을 별도로 확인합니다">
                  워밍업 종료
                </button>
              </>
            ) : (
              <button
                className="btn sm"
                onClick={() => setWarmup(3)}
                disabled={!hasProxy}
                title="3일간 이 계정의 Chrome·프록시로 읽기 작업을 예약합니다. 로그인 상태가 불명확하거나 변경되면 중단합니다. 보호조치 예방 효과는 확인되지 않았습니다."
              >
                워밍업 3일
              </button>
            )}
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
        <div style={{ gridColumn: '1 / -1' }}>
          <label className="label">
            네이버 비밀번호 (선택){' '}
            {account.has_password && (
              <span className="badge green" style={{ fontSize: 11 }}>
                저장됨
              </span>
            )}
          </label>
          <input
            className="field"
            type="password"
            placeholder={account.has_password ? '저장돼 있음 · 바꾸려면 새로 입력' : '입력하면 로그인 시 자동으로 입력됩니다'}
            disabled={f.clear_password}
            value={f.naver_pw}
            onChange={(e) => setF({ ...f, naver_pw: e.target.value })}
          />
          <div className="muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.6 }}>
            이 PC에서만 풀리도록 <b>OS 암호화(Windows DPAPI)로 저장</b>됩니다. 평문으로 저장하지 않고, 화면으로 다시 불러오지도 않습니다.
            <br />
            로그인할 때 <b>쿠키가 없을 때만 1회</b> 자동 입력합니다. 캡차·2차인증·보호조치가 뜨면 즉시 멈추고 창을 넘겨드립니다.
            <br />빈칸으로 저장하면 기존 비밀번호가 유지됩니다.
          </div>
          {account.has_password && (
            <label className="muted">
              <input type="checkbox" checked={f.clear_password} onChange={(e) => setF({ ...f, clear_password: e.target.checked, naver_pw: '' })} />
              저장된 비밀번호 삭제 (저장 버튼을 누르면 적용)
            </label>
          )}
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
