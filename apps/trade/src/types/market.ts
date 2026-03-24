export enum Side {
  Buy = 0,
  Sell = 1,
}

export interface TokenInfo {
  addr: `0x${string}`;
  name: string;
  symbol: string;
  decimals: number;
}

export interface MarketInfo {
  address: `0x${string}`;
  base: TokenInfo;
  quote: TokenInfo;
  tickSize: bigint;
  minOrderSize: bigint;
  maxOrderSize: bigint;
}

export interface OrderBookLevel {
  price: bigint;
  totalAmount: bigint;
  orderCount: number;
}

export interface BestPrices {
  bestBid: bigint;
  bestAsk: bigint;
  spread: bigint;
}
