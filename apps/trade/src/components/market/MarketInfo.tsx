import { useMarketStore } from "../../stores/market";
import { erc20ToAssetId } from "../../lib/format";
import { activeChain } from "../../config/chains";

function AssetLink({ symbol, addr }: { symbol: string; addr: `0x${string}` }) {
  const assetId = erc20ToAssetId(addr);
  if (assetId === null) return <span>{symbol}</span>;
  return (
    <a
      href={`${activeChain.explorerUrl}/assets/${assetId}`}
      target="_blank"
      rel="noopener noreferrer"
      className="text-text-secondary hover:text-text-primary underline decoration-dotted"
    >
      {symbol}
    </a>
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
      <a
        href={`${activeChain.explorerUrl}/account/${market.address}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-text-secondary hover:text-text-primary text-sm underline decoration-dotted"
      >
        Contract
      </a>
    </div>
  );
}
