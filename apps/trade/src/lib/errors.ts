import { decodeErrorResult, toFunctionSelector, type Abi } from "viem";
import { formatAbiItem } from "viem/utils";
import { toHex } from "polkadot-api/utils";
import { dlobAbi } from "../abi/dlob";
import { erc20Abi } from "../abi/erc20";
import { faucetAbi } from "../abi/faucet";
import { UserFacingError } from "./user-errors";

// Every custom-error fragment we might encounter, so a revert selector resolves regardless of which
// call produced it (e.g. a DLOB order that reverts inside the ERC20 escrow, or vice versa).
const KNOWN_ERROR_ABI: Abi = [...dlobAbi, ...erc20Abi, ...faucetAbi].filter((f) => f.type === "error");

// The 4-byte selector of an error fragment: the hash of its signature, e.g. `OrderNotActive(uint32)`.
// formatAbiItem builds that signature for errors, the way viem's own decodeErrorResult does.
function fragSelector(frag: unknown): string {
  return toFunctionSelector(formatAbiItem(frag as Parameters<typeof formatAbiItem>[0])).toLowerCase();
}

// selector (0x + 8 hex) -> error name, so we can name an error from its 4 bytes alone — this works
// even when the error carries args (whose bytes we don't need just to identify it).
const SELECTOR_TO_NAME: Record<string, string> = {};
for (const frag of KNOWN_ERROR_ABI) {
  try {
    SELECTOR_TO_NAME[fragSelector(frag)] = (frag as { name: string }).name;
  } catch {
    /* skip un-selectorable fragments */
  }
}

// Friendly, user-facing text for the errors a trader can actually hit. Unlisted names fall back to
// `ErrorName(args)`, still far better than "reverted without reason".
const FRIENDLY: Record<string, string> = {
  SelfTrade: "Cannot trade against your own resting order — use a different account",
  NoLiquidity: "No liquidity available to fill this order right now",
  BelowMinSize: "Order amount is below the market minimum",
  AboveMaxSize: "Order amount exceeds the market maximum",
  NotTickAligned: "Price must be a multiple of the market tick size",
  SlippageExceeded: "Price moved too far before execution — try again",
  ExceedsAvailable: "Order amount exceeds the available balance",
  ZeroQuoteAmount: "Order value rounds to zero — increase the price or amount",
  InsufficientFeeReserve: "Insufficient DOT fee reserve for cross-chain settlement",
  LocalOrderWithValue: "A local (same-chain) order must not send a DOT fee reserve",
  InvalidSettlementAccount: "Invalid settlement account for this order",
  WrongOriginAccount: "Order origin account does not match the signer",
  HasPendingClaims: "This order has pending settlement claims and can't be modified",
  Reentrancy: "Reentrancy detected — please retry",
  SafeERC20FailedOperation: "Token transfer failed — check your balance and allowance",
  TransferFailed: "Token transfer failed — check your balance and allowance",
  NotOrderOwner: "You do not own this order",
  OrderNotActive: "That order is no longer active",
  ERC20InsufficientBalance: "Not enough token balance for this transaction",
  ERC20InsufficientAllowance: "The token approval is too low — approve again and retry",
  CooldownActive: "You've already claimed — wait for the cooldown to pass before claiming again",
  FaucetEmpty: "The faucet is out of test tokens right now — try again later",
  Halted: "Trading is paused right now — you can still cancel your orders and claim your funds",
};

/** A contract rejection the app has no specific text for, including a revert with no reason. */
const UNKNOWN_REVERT = "The contract rejected this transaction";

/** Resolve a selector to an error name using the known set plus any extra `abi` the caller passes. */
function nameForSelector(selector: string, abi?: Abi): string | undefined {
  if (SELECTOR_TO_NAME[selector]) return SELECTOR_TO_NAME[selector];
  if (!abi) return undefined;
  for (const frag of abi) {
    if (frag.type !== "error") continue;
    try {
      if (fragSelector(frag) === selector) return frag.name;
    } catch {
      /* skip */
    }
  }
  return undefined;
}

/**
 * Decode a Solidity revert from a dry-run / eth_transact result into a user-facing message. Identifies
 * custom errors by their 4-byte selector (works even with args), maps recognised ones to friendly text,
 * and handles the built-in `Error(string)` / `Panic(uint256)` selectors.
 */
export function extractRevertReason(
  result: { value?: { data?: Uint8Array } },
  abi?: Abi,
): string {
  try {
    const data = result.value?.data;
    const hex = data ? toHex(data) : undefined;
    if (!hex || hex === "0x")
      return "Transaction reverted with no reason (commonly an insufficient token balance or allowance)";

    const selector = hex.slice(0, 10).toLowerCase();
    const candidates: Abi = abi ? [...abi, ...KNOWN_ERROR_ABI] : KNOWN_ERROR_ABI;

    // Standard string revert: `require(cond, "msg")` / `revert("msg")`.
    if (selector === "0x08c379a0") {
      try {
        const d = decodeErrorResult({ abi: candidates, data: hex as `0x${string}` });
        if (typeof d.args?.[0] === "string") return d.args[0];
      } catch {
        /* fall through */
      }
    }
    if (selector === "0x4e487b71") {
      try {
        const d = decodeErrorResult({ abi: candidates, data: hex as `0x${string}` });
        return `Contract panic (code ${String(d.args?.[0] ?? "?")})`;
      } catch {
        return "Contract panic";
      }
    }

    const name = nameForSelector(selector, abi);
    if (name) {
      if (FRIENDLY[name]) return FRIENDLY[name];
      // Recognised but not user-mapped: show name and args if the arg bytes decode.
      try {
        const d = decodeErrorResult({ abi: candidates, data: hex as `0x${string}` });
        const args = d.args?.length ? d.args.map(String).join(", ") : "";
        return `${name}(${args})`;
      } catch {
        return `${name}()`;
      }
    }
    return `Reverted with unknown error (selector ${selector})`;
  } catch {
    return "Transaction reverted (unable to decode reason)";
  }
}

/**
 * The error to throw for a contract revert: a `UserFacingError` with the friendly text for a recognised
 * error, else "the contract rejected this transaction". A revert with no reason is marked
 * `empty-revert`, so a caller that knows the likely cause can say it (see `isEmptyRevert`). The decoded
 * detail (`extractRevertReason`) is kept as the cause, for the console.
 */
export function revertError(result: { value?: { data?: Uint8Array } }, abi?: Abi): UserFacingError {
  const detail = extractRevertReason(result, abi);
  const data = result.value?.data;
  const hex = data ? toHex(data) : "0x";
  if (hex === "0x") return new UserFacingError(UNKNOWN_REVERT, { cause: detail, code: "empty-revert" });
  const name = nameForSelector(hex.slice(0, 10).toLowerCase(), abi);
  const friendly = name ? FRIENDLY[name] : undefined;
  return new UserFacingError(friendly ?? UNKNOWN_REVERT, { cause: detail });
}
