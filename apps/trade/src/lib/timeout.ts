// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
/** Settle with `promise`, or with `onTimeout()` if it has not settled within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T | Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => Promise.resolve().then(onTimeout).then(resolve, reject), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
