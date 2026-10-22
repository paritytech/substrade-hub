// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
/** Order book polling interval in milliseconds */
export const POLL_INTERVAL_MS = 2_000;

/** Max order book depth levels per side */
export const MAX_OB_LEVELS = 20;

/** Price/amount decimals (ERC20 standard) */
export const TOKEN_DECIMALS = 18;

/** 1e18 as bigint */
export const WAD = 10n ** 18n;

/** Safety margin multiplier for gas/storage estimates */
export const GAS_MARGIN = 2n;

/** How long a limit order placed from the app rests before it expires, in seconds. */
export const ORDER_LIFETIME_S = 24 * 60 * 60;
