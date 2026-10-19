import { afterEach, describe, expect, it, vi } from "vitest";
import { GENERIC_ERROR, messageFor, userMessage, UserFacingError } from "./user-errors";

afterEach(() => vi.restoreAllMocks());

describe("messageFor", () => {
  it("shows a user-facing error's message", () => {
    expect(messageFor(new UserFacingError("Signing was cancelled."))).toBe("Signing was cancelled.");
  });

  it("hides anything else behind the fallback", () => {
    // A host error about Bulletin storage: true, but nothing a trader can act on.
    expect(messageFor(new Error("allowance not available for BULLETIN"), "Couldn't complete it.")).toBe(
      "Couldn't complete it.",
    );
    expect(messageFor("RPC error: timeout")).toBe(GENERIC_ERROR);
  });
});

describe("userMessage", () => {
  it("logs the hidden details to the console", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = new Error("dry-run failed: {}");
    expect(userMessage(raw)).toBe(GENERIC_ERROR);
    expect(error).toHaveBeenCalledWith(expect.any(String), raw);
  });
});
