import { decodeErrorResult, type Abi } from "viem";
import { toHex } from "polkadot-api/utils";

/**
 * Attempt to decode a Solidity revert reason from a dry-run result.
 */
export function extractRevertReason(
  result: { value?: { data?: Uint8Array } },
  abi?: Abi,
): string {
  try {
    const data = result.value?.data;
    const hex = data ? toHex(data) : undefined;
    if (!hex || hex === "0x") return "Transaction reverted without reason";

    // Try to decode as a known error from the ABI
    if (abi) {
      try {
        const decoded = decodeErrorResult({ abi, data: hex as `0x${string}` });
        return `${decoded.errorName}(${decoded.args?.join(", ") ?? ""})`;
      } catch {
        // fall through to generic decoding
      }
    }

    // Try to decode as Error(string) — selector 0x08c379a2
    if (hex.startsWith("0x08c379a2")) {
      const reason = hexToString(hex.slice(10));
      if (reason) return reason;
    }

    return `Reverted with data: ${hex.slice(0, 66)}${hex.length > 66 ? "..." : ""}`;
  } catch {
    return "Transaction reverted (unable to decode reason)";
  }
}

function hexToString(hex: string): string {
  try {
    // ABI-encoded string: offset (32 bytes) + length (32 bytes) + data
    const lengthHex = hex.slice(64, 128);
    const length = parseInt(lengthHex, 16);
    const dataHex = hex.slice(128, 128 + length * 2);
    const bytes = new Uint8Array(
      dataHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)),
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}
