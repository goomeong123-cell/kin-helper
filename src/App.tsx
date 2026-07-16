import { useState } from 'react';
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
