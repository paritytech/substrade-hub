import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { txProgressToast, useToastStore } from "./toast";

const toast = (id: number) => useToastStore.getState().toasts.find((t) => t.id === id);

beforeEach(() => {
  vi.useFakeTimers();
  useToastStore.setState({ toasts: [] });
});
afterEach(() => vi.useRealTimers());

describe("txProgressToast", () => {
  it("walks a placed transaction from pending to confirmed", () => {
    const id = useToastStore.getState().addToast("pending", "Placing buy order: waiting for signature...");
    const progress = txProgressToast(id, { pending: "Placing buy order", done: "Buy order placed" });

    progress("signed");
    expect(toast(id)).toMatchObject({ type: "pending", message: "Placing buy order: signed..." });
    progress("submitted");
    expect(toast(id)).toMatchObject({ type: "pending", message: "Placing buy order: submitted..." });
    progress("in-block");
    expect(toast(id)).toMatchObject({ type: "success", message: "Buy order placed. Awaiting finality..." });

    // Waiting for finality outlasts the usual success duration.
    vi.advanceTimersByTime(30_000);
    expect(toast(id)).toBeDefined();
    progress("finalized");
    expect(toast(id)).toMatchObject({ type: "success", message: "Buy order placed. Confirmed." });
    vi.advanceTimersByTime(5_000);
    expect(toast(id)).toBeUndefined();
  });

  it("keeps an intermediate step pending and ignores its finality", () => {
    const id = useToastStore.getState().addToast("pending", "Approving token spend: waiting for signature...");
    const progress = txProgressToast(id, { pending: "Approving token spend" });
    progress("in-block");
    expect(toast(id)).toMatchObject({ type: "pending", message: "Approving token spend: included in a block..." });
    progress("finalized");
    expect(toast(id)).toMatchObject({ type: "pending", message: "Approving token spend: included in a block..." });
  });

  it("does not bring back a toast the user closed", () => {
    const id = useToastStore.getState().addToast("pending", "Placing buy order: waiting for signature...");
    const progress = txProgressToast(id, { pending: "Placing buy order", done: "Buy order placed" });
    progress("in-block");
    useToastStore.getState().removeToast(id);
    progress("finalized");
    expect(toast(id)).toBeUndefined();
  });
});
