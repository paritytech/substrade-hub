import { useState } from "react";
import { useWalletStore } from "../../stores/wallet";
import { WalletModal } from "./WalletModal";

export function WalletButton() {
  const [showModal, setShowModal] = useState(false);
  const { h160, ss58, accountType, disconnect } = useWalletStore();

  if (h160) {
    const isSubstrate = accountType === "substrate" && ss58;
    // Show the account type and the address mapping (SS58 and its derived H160) — the "teaching moment".
    const primary = isSubstrate ? `${ss58.slice(0, 6)}...${ss58.slice(-4)}` : `${h160.slice(0, 6)}...${h160.slice(-4)}`;
    const h160Short = `${h160.slice(0, 6)}...${h160.slice(-4)}`;
    return (
      <div className="flex items-center gap-2">
        <span className="rounded bg-surface-overlay px-2 py-1.5 text-xs uppercase text-text-secondary">
          {isSubstrate ? "Substrate" : "EVM"}
        </span>
        <span
          className="rounded bg-surface-raised px-3 py-1.5 text-sm text-text-secondary"
          title={isSubstrate ? `${ss58}\nH160: ${h160}` : h160}
        >
          {primary}
          {isSubstrate && <span className="ml-2 text-xs text-text-muted">H160 {h160Short}</span>}
        </span>
        <button
          onClick={disconnect}
          className="rounded bg-surface-raised px-3 py-1.5 text-sm text-text-muted hover:text-text-primary"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-light"
      >
        Connect Wallet
      </button>
      {showModal && <WalletModal onClose={() => setShowModal(false)} />}
    </>
  );
}
