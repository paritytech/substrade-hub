// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { useEffect, useState } from "react";
import { useToastStore, type ToastType } from "../../stores/toast";
import { ExternalLink } from "./ExternalLink";

const borderColors: Record<ToastType, string> = {
  pending: "border-brand/60",
  success: "border-buy/60",
  error: "border-sell/60",
};

const progressColors: Record<ToastType, string> = {
  pending: "bg-brand",
  success: "bg-buy",
  error: "bg-sell",
};

const icons: Record<ToastType, React.ReactNode> = {
  pending: (
    <svg className="h-5 w-5 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 019.75 7.75" strokeLinecap="round" />
    </svg>
  ),
  success: (
    <svg className="h-5 w-5 shrink-0" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 1a7 7 0 110 14A7 7 0 018 1zm3.22 4.72a.75.75 0 00-1.06-1.06L7 7.82 5.84 6.66a.75.75 0 10-1.06 1.06l1.69 1.69a.75.75 0 001.06 0l3.69-3.69z" />
    </svg>
  ),
  error: (
    <svg className="h-5 w-5 shrink-0" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 1a7 7 0 110 14A7 7 0 018 1zm-1 4v4a1 1 0 102 0V5a1 1 0 10-2 0zm1 7.5a1 1 0 100-2 1 1 0 000 2z" />
    </svg>
  ),
};

/** Estimated tx duration in ms — progress bar fills over this period */
const ESTIMATED_DURATION_MS = 4000;

function ProgressBar({ type, createdAt }: { type: ToastType; createdAt: number }) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (type !== "pending") {
      setProgress(100);
      return;
    }
    const interval = setInterval(() => {
      const elapsed = Date.now() - createdAt;
      // Ease out: fast start, slows near 95% (never reaches 100 while pending)
      const raw = elapsed / ESTIMATED_DURATION_MS;
      const eased = Math.min(95, raw * 100 * (1 - raw * 0.3));
      setProgress(eased);
    }, 50);
    return () => clearInterval(interval);
  }, [type, createdAt]);

  return (
    <div className="absolute bottom-0 left-0 right-0 h-1 overflow-hidden rounded-b-xl">
      <div
        className={`h-full transition-all duration-300 ease-out ${progressColors[type]}`}
        style={{ width: `${progress}%` }}
      />
    </div>
  );
}

export function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
      <div className="flex flex-col gap-3 pointer-events-auto">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`relative flex w-[420px] max-w-[90vw] items-center gap-3 rounded-xl border px-5 py-4 text-sm font-medium shadow-2xl bg-surface-raised text-text-primary ${borderColors[toast.type]}`}
          >
            <span className={toast.type === "error" ? "text-sell" : toast.type === "success" ? "text-buy" : "text-brand"}>
              {icons[toast.type]}
            </span>
            <div className="flex-1 leading-snug">
              <div>{toast.message}</div>
              {toast.actions && (
                <div className="mt-3 flex gap-2">
                  {toast.actions.map((action, i) => (
                    <button
                      key={action.label}
                      onClick={action.onClick}
                      className={
                        i === 0
                          ? "rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-light"
                          : "rounded-lg bg-surface-overlay px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
                      }
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              )}
              {toast.link && (
                <ExternalLink
                  href={toast.link.href}
                  className="mt-1 inline-block text-xs text-text-secondary hover:text-text-primary underline decoration-dotted"
                >
                  {toast.link.label}
                </ExternalLink>
              )}
            </div>
            <button
              onClick={() => removeToast(toast.id)}
              className="ml-1 text-lg text-text-muted opacity-60 hover:opacity-100"
            >
              &times;
            </button>
            <ProgressBar type={toast.type} createdAt={toast.createdAt} />
          </div>
        ))}
      </div>
    </div>
  );
}
