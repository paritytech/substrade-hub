// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { create } from "zustand";
import type { TxStep } from "../lib/tx-progress";

export type ToastType = "pending" | "success" | "error";

interface Toast {
  id: number;
  type: ToastType;
  message: string;
  createdAt: number;
  link?: { label: string; href: string };
  sticky?: boolean;
  /** Buttons under the message; the first is the primary one. */
  actions?: { label: string; onClick: () => void }[];
}

/** `sticky` keeps the toast until closed; `durationMs` overrides how long a finished toast stays. */
type ToastOptions = { link?: Toast["link"]; sticky?: boolean; durationMs?: number };

interface ToastState {
  toasts: Toast[];
  addToast: (type: ToastType, message: string, opts?: ToastOptions) => number;
  removeToast: (id: number) => void;
  updateToast: (id: number, type: ToastType, message: string, opts?: ToastOptions) => void;
}

let nextId = 0;

/** One dismissal timer per toast, replaced on every update so a later step restarts the countdown. */
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export const useToastStore = create<ToastState>((set) => {
  const scheduleRemoval = (id: number, type: ToastType, opts?: ToastOptions) => {
    clearTimeout(timers.get(id));
    timers.delete(id);
    if (type === "pending" || opts?.sticky) return;
    const delay = opts?.durationMs ?? (type === "error" ? 12000 : 5000);
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, delay),
    );
  };

  return {
    toasts: [],
    addToast: (type, message, opts) => {
      const id = nextId++;
      const { link, sticky } = opts ?? {};
      set((s) => ({
        toasts: [...s.toasts, { id, type, message, createdAt: Date.now(), link, sticky }],
      }));
      scheduleRemoval(id, type, opts);
      return id;
    },
    removeToast: (id) => {
      clearTimeout(timers.get(id));
      timers.delete(id);
      onClose.get(id)?.();
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },
    updateToast: (id, type, message, opts) => {
      const { link, sticky } = opts ?? {};
      let exists = false;
      set((s) => ({
        toasts: s.toasts.map((t) => {
          if (t.id !== id) return t;
          exists = true;
          return {
            ...t,
            type,
            message,
            actions: undefined,
            ...(link !== undefined ? { link } : {}),
            ...(sticky !== undefined ? { sticky } : {}),
            ...(type !== t.type ? { createdAt: Date.now() } : {}),
          };
        }),
      }));
      if (exists) scheduleRemoval(id, type, opts);
    },
  };
});

/** Called when the user closes a toast, for a question that closing answers. */
const onClose = new Map<number, () => void>();

/**
 * Ask a yes/no question on toast `id`, with `confirm` and "Cancel" buttons; resolves true for `confirm`,
 * false for "Cancel" or closing the toast. A pending toast stays until answered. The app asks in a toast
 * because a host's sandboxed frame may block `window.confirm`.
 */
export function confirmToast(id: number, message: string, confirm: string): Promise<boolean> {
  return new Promise((resolve) => {
    const answer = (yes: boolean) => {
      onClose.delete(id);
      resolve(yes);
    };
    onClose.set(id, () => answer(false));
    useToastStore.getState().updateToast(id, "pending", message);
    useToastStore.setState((s) => ({
      toasts: s.toasts.map((t) =>
        t.id === id
          ? {
              ...t,
              actions: [
                { label: confirm, onClick: () => answer(true) },
                { label: "Cancel", onClick: () => answer(false) },
              ],
            }
          : t,
      ),
    }));
  });
}

/**
 * Show a transaction's steps on toast `id`. While it is signed and submitted the toast stays pending with
 * `pending` ("Placing buy order"). With `done` ("Buy order placed"), inclusion marks it a success; without
 * `done` (an intermediate step such as an approval) the toast stays pending. Finality is not shown: the
 * transaction library reports no failure after inclusion, so a finality step could only ever confirm. A
 * toast closed by the user stays closed.
 */
export function txProgressToast(
  id: number,
  labels: { pending: string; done?: string },
): (step: TxStep) => void {
  const { updateToast } = useToastStore.getState();
  return (step) => {
    if (step === "signed") updateToast(id, "pending", `${labels.pending}: signed...`);
    else if (step === "submitted") updateToast(id, "pending", `${labels.pending}: submitted...`);
    else if (step === "in-block") {
      if (labels.done) updateToast(id, "success", labels.done);
      else updateToast(id, "pending", `${labels.pending}: included in a block...`);
    }
  };
}
