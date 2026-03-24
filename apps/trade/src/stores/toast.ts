import { create } from "zustand";

export type ToastType = "pending" | "success" | "error";

interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastState {
  toasts: Toast[];
  addToast: (type: ToastType, message: string) => number;
  removeToast: (id: number) => void;
  updateToast: (id: number, type: ToastType, message: string) => void;
}

let nextId = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (type, message) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, type, message }] }));
    if (type !== "pending") {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, 5000);
    }
    return id;
  },
  removeToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  updateToast: (id, type, message) => {
    set((s) => ({
      toasts: s.toasts.map((t) => (t.id === id ? { ...t, type, message } : t)),
    }));
    if (type !== "pending") {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, 5000);
    }
  },
}));
