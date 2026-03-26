export interface TradeEvent {
  blockNumber: number;
  txIndex: number;
  txHash: string;
  buyOrderId: number;
  sellOrderId: number;
  price: bigint;
  amount: bigint;
  timestamp: number;
}

export interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
