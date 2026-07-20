import { useEffect, useState } from 'react';
import { ToastProvider } from './lib/toast';
import Questions from './pages/Questions';
import Brands from './pages/Brands';
import Accounts from './pages/Accounts';
import History from './pages/History';
import Settings from './pages/Settings';

type Page = 'questions' | 'brands' | 'accounts' | 'history' | 'settings';

const NAV: { key: Page; label: string; ico: string }[] = [
  { key: 'questions', label: '질문·답변', ico: '📥' },
  { key: 'brands', label: '브랜드·제품', ico: '🏷️' },
  { key: 'accounts', label: '계정·프록시', ico: '👤' },
  { key: 'history', label: '답변 이력', ico: '🕘' },
  { key: 'settings', label: '설정', ico: '⚙️' },
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
          <div className="logo">지식인 헬퍼</div>
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
          <div style={{ marginTop: 'auto', padding: '10px 12px' }}>
            <div style={{ fontSize: 12, color: 'var(--text-mute)', fontWeight: 700 }}>
              {version ? `ver ${version}` : ''}
            </div>
            {updText && (
              <div style={{ fontSize: 11, color: 'var(--text-sub)', marginTop: 4, lineHeight: 1.4 }}>
                {updText}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              {upd.status === 'downloaded' ? (
                <button
                  className="btn sm primary"
                  style={{ fontSize: 11, padding: '5px 10px' }}
                  onClick={() => window.api.update.install()}
                >
                  지금 설치
                </button>
              ) : (
                <button
                  className="btn sm"
                  style={{ fontSize: 11, padding: '5px 10px' }}
                  onClick={() => window.api.update.check().then(setUpd)}
                >
                  업데이트 확인
                </button>
              )}
            </div>
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
