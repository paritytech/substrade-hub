// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { useMarketStore } from "../../stores/market";
import { erc20ToAssetId } from "../../lib/format";
import { activeChain } from "../../config/chains";
import { ExternalLink } from "../ui/ExternalLink";

function AssetLink({ symbol, addr }: { symbol: string; addr: `0x${string}` }) {
  const assetId = erc20ToAssetId(addr);
  if (assetId === null || !activeChain.explorerUrl) return <span>{symbol}</span>;
  return (
    <ExternalLink
      href={`${activeChain.explorerUrl}/assets/${assetId}`}
      className="text-text-secondary hover:text-text-primary underline decoration-dotted"
    >
      {symbol}
    </ExternalLink>
  );
}

export function MarketInfo() {
  const market = useMarketStore((s) => s.selectedMarket);

  if (!market) return null;

  return (
    <div className="flex items-center gap-4 text-sm">
      <div className="flex items-center gap-1">
        <AssetLink symbol={market.base.symbol} addr={market.base.addr} />
        <span className="text-text-muted">/</span>
        <AssetLink symbol={market.quote.symbol} addr={market.quote.addr} />
      </div>
      {activeChain.explorerUrl && (
        <ExternalLink
          href={`${activeChain.explorerUrl}/account/${market.address}`}
          className="text-text-secondary hover:text-text-primary text-sm underline decoration-dotted"
        >
          Contract
        </ExternalLink>
      )}
    </div>
  );
}
