import { describe, it, expect, beforeEach } from "vitest";
import type { PolkadotSigner } from "polkadot-api";
import { useWalletStore } from "./wallet";

const EVM_ADDR = "0x1234567890abcdef1234567890abcdef12345678" as const;
const SUB = {
  extensionName: "polkadot-js",
  ss58: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
  h160: "0x9621dde636de098b43efb0fa9b61facfe328f99d" as const,
  originAccount: "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d" as const,
  signer: { sentinel: true } as unknown as PolkadotSigner,
};

beforeEach(() => useWalletStore.getState().disconnect());

describe("wallet store", () => {
  it("connectEvm sets EVM identity, the 0xEE origin, and mapped=true (no signer)", () => {
    useWalletStore.getState().connectEvm(EVM_ADDR);
    const s = useWalletStore.getState();
    expect(s.accountType).toBe("evm");
    expect(s.h160).toBe(EVM_ADDR);
    expect(s.originAccount).toBe(`${EVM_ADDR}${"ee".repeat(12)}`);
    expect(s.mapped).toBe(true);
    expect(s.ss58).toBeNull();
    expect(s.signer).toBeNull();
  });

  it("connectSubstrate stores the signer + derived fields, mapped=false", () => {
    useWalletStore.getState().connectSubstrate(SUB);
    const s = useWalletStore.getState();
    expect(s.accountType).toBe("substrate");
    expect(s.ss58).toBe(SUB.ss58);
    expect(s.h160).toBe(SUB.h160);
    expect(s.originAccount).toBe(SUB.originAccount);
    expect(s.signer).toBe(SUB.signer);
    expect(s.mapped).toBe(false);
  });

  it("connectHost stores the host signer + derived fields, mapped=true (host maps)", () => {
    const HOST = { ss58: SUB.ss58, h160: SUB.h160, originAccount: SUB.originAccount, signer: SUB.signer };
    useWalletStore.getState().connectHost(HOST);
    const s = useWalletStore.getState();
    expect(s.accountType).toBe("host");
    expect(s.ss58).toBe(HOST.ss58);
    expect(s.h160).toBe(HOST.h160);
    expect(s.originAccount).toBe(HOST.originAccount);
    expect(s.signer).toBe(HOST.signer);
    expect(s.mapped).toBe(true);
  });

  it("setMapped flips the mapped flag", () => {
    useWalletStore.getState().connectSubstrate(SUB);
    useWalletStore.getState().setMapped();
    expect(useWalletStore.getState().mapped).toBe(true);
  });

  it("disconnect clears everything, including the signer", () => {
    useWalletStore.getState().connectSubstrate(SUB);
    useWalletStore.getState().disconnect();
    const s = useWalletStore.getState();
    expect(s.h160).toBeNull();
    expect(s.originAccount).toBeNull();
    expect(s.accountType).toBeNull();
    expect(s.ss58).toBeNull();
    expect(s.signer).toBeNull();
  });
});
