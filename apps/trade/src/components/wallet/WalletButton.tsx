import { useState } from "react";
import { useWalletStore } from "../../stores/wallet";
import { WalletModal } from "./WalletModal";

export function WalletButton() {
  const [showModal, setShowModal] = useState(false);
  const { h160, disconnect } = useWalletStore();

  if (h160) {
    return (
      <div className="flex items-center gap-2">
        <span className="rounded bg-surface-raised px-3 py-1.5 text-sm text-text-secondary">
          {h160.slice(0, 6)}...{h160.slice(-4)}
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
