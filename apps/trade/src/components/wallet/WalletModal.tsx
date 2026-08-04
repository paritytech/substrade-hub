import { useState, useCallback, useEffect } from "react";
import type { InjectedExtension, InjectedPolkadotAccount } from "polkadot-api/pjs-signer";
import { isMetaMaskAvailable, connectMetaMask } from "../../lib/wallet";
import { listSubstrateExtensions, connectExtension, watchAccounts } from "../../lib/substrate-wallet";
import { ensureExtensionMetadata, MetadataError } from "../../lib/extension-metadata";
import { accountToH160, ss58ToOriginAccount } from "../../lib/account";
import { isInHost } from "../../lib/host/detect";
import {
  connectHostAccounts,
  selectHostAccount,
  getHostSigner,
  disconnectHost,
  type SignerAccount,
} from "../../lib/host/signer";
import { awaitContractAllowance } from "../../lib/host/allowances";
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
  const [hostAccounts, setHostAccounts] = useState<SignerAccount[] | null>(null);
  const { connectEvm, connectSubstrate, connectHost, isConnecting, setConnecting } = useWalletStore();
  const inHost = isInHost();

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
        // Register this chain's custom signed extensions with the wallet, or its signer would drop
        // them and produce BadProof on Asset Hub Next (see lib/extension-metadata). Prompts once.
        await ensureExtensionMetadata(name);
        setExt(extension);
        setExtName(name);
        setAccounts(accs);
        setConnecting(false);
      } catch (e) {
        if (e instanceof MetadataError) {
          setError(
            e.code === "declined"
              ? `Approve the network metadata update in ${extensionLabel(name)} to sign on this chain, then retry.`
              : `${extensionLabel(name)} can't register this network's signing extensions, so it can't place orders here.`,
          );
        } else {
          setError(e instanceof Error ? e.message : `Failed to connect to ${extensionLabel(name)}`);
        }
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

  const handleHostPick = useCallback(
    async (acc: SignerAccount) => {
      setError(null);
      setConnecting(true);
      try {
        // selectHostAccount drives the manager to connected+selected, which fires the SignerManager
        // onConnect that provisions the allowance (PGAS / contract-call authorization). "connected" is
        // emitted before onConnect finishes, so await the allowance gate here to surface a decline/
        // failure in this modal instead of connecting a wallet whose first write would fail.
        selectHostAccount(acc.address);
        const signer = getHostSigner();
        await awaitContractAllowance();
        connectHost({
          ss58: acc.address,
          h160: acc.h160Address as `0x${string}`,
          originAccount: ss58ToOriginAccount(acc.address),
          signer,
        });
        onClose();
      } catch (e) {
        // Tear down the half-open session (the lifecycle subscription may have connected the store on
        // the "connected" emission) so we do not leave an unauthorized wallet behind.
        disconnectHost();
        useWalletStore.getState().disconnect();
        setError(e instanceof Error ? e.message : "Failed to connect the host account");
        setConnecting(false);
      }
    },
    [connectHost, onClose, setConnecting],
  );

  const handleHostConnect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const accs = await connectHostAccounts();
      if (!accs.length) {
        setError("No accounts available from the Polkadot host.");
        setConnecting(false);
        return;
      }
      if (accs.length === 1) {
        await handleHostPick(accs[0]!);
      } else {
        setHostAccounts(accs);
        setConnecting(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect to the Polkadot host");
      setConnecting(false);
    }
  }, [handleHostPick, setConnecting]);

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
          {accounts || hostAccounts ? "Select account" : "Connect Wallet"}
        </h2>

        {error && (
          <div className="mb-3 rounded bg-sell-dim px-3 py-2 text-sm text-sell">{error}</div>
        )}

        {inHost ? (
          !hostAccounts ? (
            <div className="space-y-2">
              <button
                onClick={handleHostConnect}
                disabled={isConnecting}
                className="flex w-full items-center justify-between rounded-lg border border-border px-4 py-3 hover:bg-surface-overlay disabled:opacity-50"
              >
                <span className="text-sm font-medium">Connect Polkadot account</span>
                <span className="text-xs uppercase text-text-muted">Host</span>
              </button>
              {isConnecting && (
                <div className="flex justify-center pt-2">
                  <Spinner className="h-4 w-4" />
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {hostAccounts.map((acc) => (
                <button
                  key={acc.address}
                  onClick={() => handleHostPick(acc)}
                  disabled={isConnecting}
                  className="flex w-full flex-col items-start rounded-lg border border-border px-4 py-3 hover:bg-surface-overlay disabled:opacity-50"
                >
                  <span className="text-sm font-medium">Account</span>
                  <span className="text-xs text-text-muted">
                    {acc.address.slice(0, 8)}...{acc.address.slice(-6)}
                  </span>
                </button>
              ))}
              <button
                onClick={() => {
                  setHostAccounts(null);
                  setError(null);
                }}
                className="w-full pt-1 text-xs text-text-muted hover:text-text-primary"
              >
                Back
              </button>
            </div>
          )
        ) : !accounts ? (
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
