import { useState, useCallback } from "react";
import { isMetaMaskAvailable, connectMetaMask } from "../../lib/wallet";
import { useWalletStore } from "../../stores/wallet";
import { Spinner } from "../ui/Spinner";

interface WalletModalProps {
  onClose: () => void;
}

export function WalletModal({ onClose }: WalletModalProps) {
  const [error, setError] = useState<string | null>(null);
  const { connect, isConnecting, setConnecting } = useWalletStore();

  const handleConnect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const address = await connectMetaMask();
      connect(address);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect");
      setConnecting(false);
    }
  }, [connect, onClose, setConnecting]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-xl bg-surface-raised p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold">Connect Wallet</h2>

        {error && (
          <div className="mb-3 rounded bg-sell-dim px-3 py-2 text-sm text-sell">
            {error}
          </div>
        )}

        <div className="space-y-2">
          {isMetaMaskAvailable() ? (
            <button
              onClick={handleConnect}
              disabled={isConnecting}
              className="flex w-full items-center justify-between rounded-lg border border-border px-4 py-3 hover:bg-surface-overlay disabled:opacity-50"
            >
              <span className="text-sm font-medium">MetaMask</span>
              {isConnecting && <Spinner className="h-4 w-4" />}
            </button>
          ) : (
            <p className="text-sm text-text-secondary">
              MetaMask not detected. Install MetaMask to connect.
            </p>
          )}
        </div>

        <button
          onClick={onClose}
          className="mt-4 w-full rounded-lg border border-border py-2 text-sm text-text-secondary hover:text-text-primary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
