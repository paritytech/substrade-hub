import { useToastStore, type ToastType } from "../../stores/toast";
import { Spinner } from "./Spinner";

const styles: Record<ToastType, string> = {
  pending: "border-brand bg-surface-raised text-text-primary",
  success: "border-buy bg-surface-raised text-buy",
  error: "border-sell bg-surface-raised text-sell",
};

const icons: Record<ToastType, React.ReactNode> = {
  pending: <Spinner className="h-6 w-6" />,
  success: (
    <svg className="h-6 w-6 shrink-0" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 1a7 7 0 110 14A7 7 0 018 1zm3.22 4.72a.75.75 0 00-1.06-1.06L7 7.82 5.84 6.66a.75.75 0 10-1.06 1.06l1.69 1.69a.75.75 0 001.06 0l3.69-3.69z" />
    </svg>
  ),
  error: (
    <svg className="h-6 w-6 shrink-0" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 1a7 7 0 110 14A7 7 0 018 1zm-1 4v4a1 1 0 102 0V5a1 1 0 10-2 0zm1 7.5a1 1 0 100-2 1 1 0 000 2z" />
    </svg>
  ),
};

export function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed inset-x-0 bottom-8 z-50 flex flex-col items-center gap-3">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`flex w-[480px] max-w-[90vw] items-center gap-4 rounded-2xl border-2 px-6 py-5 text-base font-medium shadow-2xl ${styles[toast.type]}`}
        >
          {icons[toast.type]}
          <span className="flex-1">{toast.message}</span>
          {toast.type !== "pending" && (
            <button
              onClick={() => removeToast(toast.id)}
              className="ml-2 text-lg text-text-muted opacity-60 hover:opacity-100"
            >
              &times;
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
