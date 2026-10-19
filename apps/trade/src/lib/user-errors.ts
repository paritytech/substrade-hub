/**
 * Errors the app shows the user. Only two kinds are shown: user errors the user can act on (a cancelled
 * signature, too little balance, a transaction still pending, no liquidity) and decoded contract errors.
 * Both are thrown as `UserFacingError` where the failure is understood. Anything else (RPC, host,
 * wallet or app internals) shows a generic message, and its details go to the console only.
 */
export class UserFacingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UserFacingError";
  }
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
