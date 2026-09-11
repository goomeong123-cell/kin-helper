import { useEffect, useState } from 'react';
import { ToastProvider } from './lib/toast';
import Questions from './pages/Questions';
import Brands from './pages/Brands';
import Accounts from './pages/Accounts';
import History from './pages/History';
import Settings from './pages/Settings';

type Page = 'questions' | 'brands' | 'accounts' | 'history' | 'settings';

// 아이콘은 한 벌로 그린 선 아이콘 (동일 굵기·크기)
const I = {
  questions: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8A2.5 2.5 0 0 1 17.5 16H10l-5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5z" />
      <path d="M9 9.5h6M9 12.5h4" />
    </svg>
  ),
  brands: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 12.2V5.5a2 2 0 0 1 2-2h6.7a2 2 0 0 1 1.4.6l6.9 6.9a2 2 0 0 1 0 2.8l-6.7 6.7a2 2 0 0 1-2.8 0l-6.9-6.9a2 2 0 0 1-.6-1.4z" />
      <circle cx="8.5" cy="8.5" r="1.4" />
    </svg>
  ),
  accounts: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20.5c.8-3.6 3.8-5.5 7.5-5.5s6.7 1.9 7.5 5.5" />
    </svg>
  ),
  history: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
      <path d="M3.5 3.5v4.5H8M12 7.5V12l3 2" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2.5" />
      <circle cx="10" cy="17" r="2.5" />
    </svg>
  ),
};

const NAV: { key: Page; label: string; ico: JSX.Element }[] = [
  { key: 'questions', label: '질문·답변', ico: I.questions },
  { key: 'brands', label: '브랜드·제품', ico: I.brands },
  { key: 'accounts', label: '계정·프록시', ico: I.accounts },
  { key: 'history', label: '답변 이력', ico: I.history },
  { key: 'settings', label: '설정', ico: I.settings },
];

export default function App() {
  const [page, setPage] = useState<Page>('questions');
  const [version, setVersion] = useState('');
  const [upd, setUpd] = useState<{ status: string; version?: string; percent?: number; error?: string }>({
    status: 'idle',
  });

  useEffect(() => {
    window.api.app
      .version()
      .then(setVersion)
      .catch(() => {});
    const t = window.setInterval(() => {
      window.api.update
        .status()
        .then(setUpd)
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(t);
  }, []);

  const updText = (() => {
    switch (upd.status) {
      case 'checking':
        return '업데이트 확인 중…';
      case 'available':
        return `새 버전 ${upd.version} 발견`;
      case 'downloading':
        return `내려받는 중 ${upd.percent ?? 0}%`;
      case 'downloaded':
        return `설치 준비 완료 (${upd.version})`;
      case 'latest':
        return '최신 버전입니다';
      case 'error':
        return `업데이트 오류: ${(upd.error || '').slice(0, 40)}`;
      case 'dev':
        return '개발 모드(자동 업데이트 없음)';
      default:
        return '';
    }
  })();

  return (
    <ToastProvider>
      <div className="app">
        <aside className="sidebar">
          <div className="logo">
            <span className="mark" aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-5 4v-4H6a2 2 0 0 1-2-2z" />
              </svg>
            </span>
            지식인 헬퍼
          </div>
          {NAV.map((n) => (
            <button
              key={n.key}
              className={`nav-item ${page === n.key ? 'active' : ''}`}
              onClick={() => setPage(n.key)}
            >
              <span className="ico">{n.ico}</span>
              {n.label}
            </button>
          ))}
          <div className="sidebar-foot">
            <div className="ver">{version ? `ver ${version}` : ''}</div>
            {updText && <div className="upd">{updText}</div>}
            {upd.status === 'downloaded' ? (
              <button className="btn sm primary" onClick={() => window.api.update.install()}>
                지금 설치
              </button>
            ) : (
              <button className="btn sm" onClick={() => window.api.update.check().then(setUpd)}>
                업데이트 확인
              </button>
            )}
          </div>
        </aside>
        <main className="main">
          {page === 'questions' && <Questions />}
          {page === 'brands' && <Brands />}
          {page === 'accounts' && <Accounts />}
          {page === 'history' && <History />}
          {page === 'settings' && <Settings />}
        </main>
      </div>
    </ToastProvider>
  );
}
