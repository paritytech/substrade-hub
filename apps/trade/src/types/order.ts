import { Side } from "./market";

export interface Order {
  orderId: number;
  side: Side;
  price: bigint;
  amount: bigint;
  filled: bigint;
  originAccount: `0x${string}`;
  settlementAccount: `0x${string}`;
  destParaId: number;
  expireTimestamp: bigint;
  isActive: boolean;
}

export interface PendingClaim {
  claimId: number;
  orderId: number;
  amount: bigint;
  destParaId: number;
  beneficiary: `0x${string}`;
  settled: boolean;
}
