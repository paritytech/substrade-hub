import { create } from "zustand";

export type ToastType = "pending" | "success" | "error";

interface Toast {
  id: number;
  type: ToastType;
  message: string;
  createdAt: number;
  link?: { label: string; href: string };
  sticky?: boolean;
}

interface ToastState {
  toasts: Toast[];
  addToast: (type: ToastType, message: string, opts?: { link?: Toast["link"]; sticky?: boolean }) => number;
  removeToast: (id: number) => void;
  updateToast: (id: number, type: ToastType, message: string, opts?: { link?: Toast["link"]; sticky?: boolean }) => void;
}

let nextId = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (type, message, opts) => {
    const id = nextId++;
    set((s) => ({
      toasts: [...s.toasts, { id, type, message, createdAt: Date.now(), ...opts }],
    }));
    if (type !== "pending" && !opts?.sticky) {
      const delay = type === "error" ? 12000 : 5000;
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, delay);
    }
    return id;
  },
  removeToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  updateToast: (id, type, message, opts) => {
    set((s) => ({
      toasts: s.toasts.map((t) =>
        t.id === id
          ? { ...t, type, message, ...opts, ...(type !== t.type ? { createdAt: Date.now() } : {}) }
          : t,
      ),
    }));
    if (type !== "pending" && !opts?.sticky) {
      const delay = type === "error" ? 12000 : 5000;
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, delay);
    }
  },
}));
