import { useState } from "react";
import { useFunding } from "../../hooks/use-funding";
import { activeChain } from "../../config/chains";
import { Amount } from "../ui/Amount";
import { ExternalLink } from "../ui/ExternalLink";

/**
 * Tells a connected user whose account is low on the native token that it needs funding before
 * anything works, and where to send it. Renders nothing while the balance is sufficient or unknown.
 */
export function FundingNotice() {
  const { low, free, token, address } = useFunding();
  const [copied, setCopied] = useState(false);
  if (!low || !token || !address || free === undefined) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. a sandboxed host): the address stays selectable.
    }
  };

  return (
    <div className="rounded-xl border border-sell/40 bg-sell-dim p-4 text-sm">
      <p className="font-medium text-text-primary">
        Your account needs {token.symbol} before you can trade
      </p>
      <p className="mt-1 text-text-secondary">
        {token.symbol} pays network fees and storage deposits. With{" "}
        <Amount value={free} decimals={token.decimals} display={4} /> {token.symbol}, claiming test{" "}
        {activeChain.knownQuote.symbol} and placing orders will fail. Send {token.symbol} on{" "}
        {activeChain.name} to this account:
      </p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 select-all break-all rounded bg-surface-overlay px-2 py-1 text-xs text-text-primary">
          {address}
        </code>
        <button
          onClick={copy}
          className="shrink-0 rounded bg-surface-overlay px-2 py-1 text-xs text-text-secondary hover:text-text-primary"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {activeChain.nativeFaucetUrl ? (
        <ExternalLink
          href={activeChain.nativeFaucetUrl}
          className="mt-2 inline-block text-brand underline decoration-dotted"
        >
          Get {token.symbol} from the faucet
        </ExternalLink>
      ) : (
        <p className="mt-2 text-xs text-text-muted">
          {activeChain.name} has no public {token.symbol} faucet; ask whoever runs it to fund this account.
        </p>
      )}
    </div>
  );
}
