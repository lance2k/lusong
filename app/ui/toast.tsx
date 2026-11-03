"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

const ToastContext = createContext<(text: string) => void>(() => {});

export const useToast = () => useContext(ToastContext);

const SHOWN_MS = 5000;

/** One toast at a time, announced politely, gone after 5 s; hovering or focusing it pauses the clock. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ text: string; n: number } | null>(null);
  const [paused, setPaused] = useState(false);
  const counter = useRef(0);
  const show = useCallback((text: string) => {
    counter.current += 1;
    setToast({ text, n: counter.current });
  }, []);

  useEffect(() => {
    if (!toast || paused) return;
    const id = setTimeout(() => setToast(null), SHOWN_MS);
    return () => clearTimeout(id);
  }, [toast, paused]);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-4 top-[calc(var(--top-band)+8px)] z-30 flex justify-center lg:left-[432px]">
        {toast && (
          <p
            key={toast.n}
            tabIndex={0}
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
            onFocus={() => setPaused(true)}
            onBlur={() => setPaused(false)}
            className="pointer-events-auto max-w-md rounded-control bg-ink px-4 py-3 text-[15px] font-medium text-ground shadow-lg"
          >
            {toast.text}
          </p>
        )}
      </div>
    </ToastContext.Provider>
  );
}
