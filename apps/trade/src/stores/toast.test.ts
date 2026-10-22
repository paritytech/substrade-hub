// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmToast, txProgressToast, useToastStore } from "./toast";

const toast = (id: number) => useToastStore.getState().toasts.find((t) => t.id === id);

beforeEach(() => {
  vi.useFakeTimers();
  useToastStore.setState({ toasts: [] });
});
afterEach(() => vi.useRealTimers());

describe("txProgressToast", () => {
  it("walks a placed transaction from pending to success at inclusion", () => {
    const id = useToastStore.getState().addToast("pending", "Placing buy order: waiting for signature...");
    const progress = txProgressToast(id, { pending: "Placing buy order", done: "Buy order placed" });

    progress("signed");
    expect(toast(id)).toMatchObject({ type: "pending", message: "Placing buy order: signed..." });
    progress("submitted");
    expect(toast(id)).toMatchObject({ type: "pending", message: "Placing buy order: submitted..." });
    progress("in-block");
    expect(toast(id)).toMatchObject({ type: "success", message: "Buy order placed" });

    // Finality leaves the success as it is, and the toast closes after the usual duration.
    progress("finalized");
    expect(toast(id)).toMatchObject({ type: "success", message: "Buy order placed" });
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

describe("confirmToast", () => {
  it("resolves with the button pressed, or false when the toast is closed", async () => {
    const { addToast, removeToast } = useToastStore.getState();
    const id = addToast("pending", "Preparing...");
    const yes = confirmToast(id, "Go ahead?", "Go");
    const toast = () => useToastStore.getState().toasts.find((t) => t.id === id);
    expect(toast()?.message).toBe("Go ahead?");
    expect(toast()?.actions?.map((a) => a.label)).toEqual(["Go", "Cancel"]);
    toast()!.actions![0]!.onClick();
    expect(await yes).toBe(true);

    const no = confirmToast(id, "Again?", "Go");
    toast()!.actions![1]!.onClick();
    expect(await no).toBe(false);

    const closed = confirmToast(id, "Once more?", "Go");
    removeToast(id);
    expect(await closed).toBe(false);
  });

  it("drops the buttons when the toast moves on", () => {
    const { addToast, updateToast } = useToastStore.getState();
    const id = addToast("pending", "Preparing...");
    void confirmToast(id, "Go ahead?", "Go");
    updateToast(id, "pending", "Signing...");
    expect(useToastStore.getState().toasts.find((t) => t.id === id)?.actions).toBeUndefined();
  });
});
