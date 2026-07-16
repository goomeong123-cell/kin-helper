import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

const ToastCtx = createContext<(msg: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);

  const show = useCallback((m: string) => {
    setMsg(m);
    window.setTimeout(() => setMsg(null), 2600);
  }, []);

  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && <div className="toast">{msg}</div>}
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
