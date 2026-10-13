import { useState } from "react";
import { useWalletStore } from "../../stores/wallet";
import { disconnectHost } from "../../lib/host/signer";
import { useHostUsername } from "../../hooks/use-host-username";
import { WalletModal } from "./WalletModal";

export function WalletButton() {
  const [showModal, setShowModal] = useState(false);
  const { h160, ss58, accountType, disconnect } = useWalletStore();
  const username = useHostUsername();

  // A host account must end the SDK session too, otherwise the lifecycle subscription (useHostReconnect)
  // sees it still connected and immediately re-adds it. disconnectHost() drives the SDK to disconnected,
  // and the subscription then clears the store; clearing here as well keeps the UI instant.
  const handleDisconnect = () => {
    if (accountType === "host") disconnectHost();
    disconnect();
  };

  if (h160) {
    // Substrate + host accounts both sign via SS58; show the SS58 + its derived H160 (the "teaching
    // moment"). EVM shows the H160 only. A host account shows the user's username when the host has one.
    const showSs58 = (accountType === "substrate" || accountType === "host") && ss58;
    const badge = accountType === "host" ? "Host" : accountType === "substrate" ? "Substrate" : "EVM";
    const primary =
      username ?? (showSs58 ? `${ss58.slice(0, 6)}...${ss58.slice(-4)}` : `${h160.slice(0, 6)}...${h160.slice(-4)}`);
    const h160Short = `${h160.slice(0, 6)}...${h160.slice(-4)}`;
    return (
      <div className="flex items-center gap-2">
        <span className="hidden rounded bg-surface-overlay px-2 py-1.5 text-xs uppercase text-text-secondary sm:inline">
          {badge}
        </span>
        <span
          className="max-w-[16rem] truncate whitespace-nowrap rounded bg-surface-raised px-3 py-1.5 text-sm text-text-secondary"
          title={showSs58 ? `${username ? `${username}\n` : ""}${ss58}\nH160: ${h160}` : h160}
        >
          {primary}
          {showSs58 && <span className="ml-2 hidden text-xs text-text-muted sm:inline">H160 {h160Short}</span>}
        </span>
        <button
          onClick={handleDisconnect}
          className="whitespace-nowrap rounded bg-surface-raised px-3 py-1.5 text-sm text-text-muted hover:text-text-primary"
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
        className="whitespace-nowrap rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-light"
      >
        Connect Wallet
      </button>
      {showModal && <WalletModal onClose={() => setShowModal(false)} />}
    </>
  );
}
