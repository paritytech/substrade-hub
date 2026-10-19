/**
 * Errors the app shows the user. Only two kinds are shown: user errors the user can act on (a cancelled
 * signature, too little balance, a transaction still pending, no liquidity) and decoded contract errors.
 * Both are thrown as `UserFacingError` where the failure is understood. Anything else (RPC, host,
 * wallet or app internals) shows a generic message, and its details go to the console only.
 */
export class UserFacingError extends Error {
  /** Set when a caller may replace the message with one that fits its context (see `EMPTY_REVERT`). */
  readonly code?: "empty-revert";

  constructor(message: string, options?: { cause?: unknown; code?: "empty-revert" }) {
    super(message, options);
    this.name = "UserFacingError";
    this.code = options?.code;
  }
}

/** `err` is a revert with no reason, whose likely cause depends on the call that made it. */
export function isEmptyRevert(err: unknown): boolean {
  return err instanceof UserFacingError && err.code === "empty-revert";
}

export const GENERIC_ERROR = "Something went wrong. Please try again.";

/** The text to show for `err`: its message when it is a `UserFacingError`, else `fallback`. */
export function messageFor(err: unknown, fallback = GENERIC_ERROR): string {
  return err instanceof UserFacingError ? err.message : fallback;
}

/** `messageFor`, logging the error's details to the console. Use it once per failure (e.g. a toast). */
export function userMessage(err: unknown, fallback = GENERIC_ERROR): string {
  if (err instanceof UserFacingError) {
    if (err.cause !== undefined) console.warn(`[error] ${err.message}`, err.cause);
  } else {
    console.error("[error] not shown to the user:", err);
  }
  return messageFor(err, fallback);
}
