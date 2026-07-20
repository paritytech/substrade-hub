import { useState, useCallback, useEffect } from "react";
import type { InjectedExtension, InjectedPolkadotAccount } from "polkadot-api/pjs-signer";
import { isMetaMaskAvailable, connectMetaMask } from "../../lib/wallet";
import { listSubstrateExtensions, connectExtension, watchAccounts } from "../../lib/substrate-wallet";
import { accountToH160, ss58ToOriginAccount } from "../../lib/account";
import { useWalletStore } from "../../stores/wallet";
import { Spinner } from "../ui/Spinner";

interface WalletModalProps {
  onClose: () => void;
}

function extensionLabel(name: string): string {
  if (name === "subwallet-js") return "SubWallet";
  if (name === "polkadot-js") return "polkadot-js";
  if (name === "talisman") return "Talisman";
  return name;
}

export function WalletModal({ onClose }: WalletModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<InjectedPolkadotAccount[] | null>(null);
  const [extensions, setExtensions] = useState<string[]>([]);
  const [ext, setExt] = useState<InjectedExtension | null>(null);
  const [extName, setExtName] = useState("");
  const { connectEvm, connectSubstrate, isConnecting, setConnecting } = useWalletStore();

  useEffect(() => {
    setExtensions(listSubstrateExtensions());
  }, []);

  const handleMetaMask = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const address = await connectMetaMask();
      connectEvm(address);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect");
      setConnecting(false);
    }
  }, [connectEvm, onClose, setConnecting]);

  const handleExtension = useCallback(
    async (name: string) => {
      setError(null);
      setConnecting(true);
      try {
        const extension = await connectExtension(name);
        const accs = extension.getAccounts();
        if (!accs.length) {
          setError(`No accounts in ${extensionLabel(name)}. Create or unlock one, then retry.`);
          setConnecting(false);
          return;
        }
        setExt(extension);
        setExtName(name);
        setAccounts(accs);
        setConnecting(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : `Failed to connect to ${extensionLabel(name)}`);
        setConnecting(false);
      }
    },
    [setConnecting],
  );

  const handlePickAccount = useCallback(
    async (acc: InjectedPolkadotAccount) => {
      setError(null);
      setConnecting(true);
      try {
        // h160 is a runtime call (ReviveApi.address); resolve it before populating the store.
        const h160 = await accountToH160(acc.address);
        const originAccount = ss58ToOriginAccount(acc.address);
        connectSubstrate({
          extensionName: extName,
          ss58: acc.address,
          h160,
          originAccount,
          signer: acc.polkadotSigner,
        });
        if (ext) watchAccounts(ext, acc.address, () => useWalletStore.getState().disconnect());
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to select account");
        setConnecting(false);
      }
    },
    [connectSubstrate, onClose, setConnecting, ext, extName],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-xl bg-surface-raised p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold">
          {accounts ? "Select account" : "Connect Wallet"}
        </h2>

        {error && (
          <div className="mb-3 rounded bg-sell-dim px-3 py-2 text-sm text-sell">{error}</div>
        )}

        {!accounts ? (
          <div className="space-y-2">
            {isMetaMaskAvailable() ? (
              <button
                onClick={handleMetaMask}
                disabled={isConnecting}
                className="flex w-full items-center justify-between rounded-lg border border-border px-4 py-3 hover:bg-surface-overlay disabled:opacity-50"
              >
                <span className="text-sm font-medium">MetaMask</span>
                <span className="text-xs uppercase text-text-muted">EVM</span>
              </button>
            ) : (
              <p className="text-sm text-text-secondary">
                MetaMask not detected. Install it to connect an EVM wallet.
              </p>
            )}

            {extensions.map((name) => (
              <button
                key={name}
                onClick={() => handleExtension(name)}
                disabled={isConnecting}
                className="flex w-full items-center justify-between rounded-lg border border-border px-4 py-3 hover:bg-surface-overlay disabled:opacity-50"
              >
                <span className="text-sm font-medium">{extensionLabel(name)}</span>
                <span className="text-xs uppercase text-text-muted">Substrate</span>
              </button>
            ))}

            {extensions.length === 0 && (
              <p className="text-sm text-text-secondary">
                No Substrate wallet detected. Install{" "}
                <a className="underline" href="https://talisman.xyz" target="_blank" rel="noreferrer">
                  Talisman
                </a>
                ,{" "}
                <a className="underline" href="https://subwallet.app" target="_blank" rel="noreferrer">
                  SubWallet
                </a>
                , or{" "}
                <a
                  className="underline"
                  href="https://polkadot.js.org/extension/"
                  target="_blank"
                  rel="noreferrer"
                >
                  polkadot-js
                </a>
                .
              </p>
            )}

            {isConnecting && (
              <div className="flex justify-center pt-2">
                <Spinner className="h-4 w-4" />
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {accounts.map((acc) => (
              <button
                key={acc.address}
                onClick={() => handlePickAccount(acc)}
                disabled={isConnecting}
                className="flex w-full flex-col items-start rounded-lg border border-border px-4 py-3 hover:bg-surface-overlay disabled:opacity-50"
              >
                <span className="text-sm font-medium">{acc.name ?? "Account"}</span>
                <span className="text-xs text-text-muted">
                  {acc.address.slice(0, 8)}...{acc.address.slice(-6)}
                </span>
              </button>
            ))}
            <button
              onClick={() => {
                setAccounts(null);
                setError(null);
              }}
              className="w-full pt-1 text-xs text-text-muted hover:text-text-primary"
            >
              Back
            </button>
          </div>
        )}

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
