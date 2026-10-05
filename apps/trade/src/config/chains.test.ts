import { describe, it, expect } from "vitest";
import networksJson from "./networks.json";
import { parseNetwork, selectNetwork } from "./chains";

const ZERO = "0x0000000000000000000000000000000000000000";
const valid = {
  name: "Test AH",
  papiEntry: "ah_test",
  genesis: `0x${"ab".repeat(32)}`,
  wsEndpoint: "wss://test.example/asset-hub",
  rpcUrl: "https://test.example/eth-rpc",
  chainId: 420420417,
  dotnsName: "app.testnet",
  bulletinDeployEnv: "preview",
  explorerUrl: null,
  factoryAddress: ZERO,
  faucetAddress: ZERO,
  knownQuote: { addr: ZERO, symbol: "tUSD", decimals: 6 },
};

describe("parseNetwork", () => {
  it("accepts a well-formed entry", () => {
    expect(parseNetwork("test", valid)).toEqual(valid);
  });

  it("accepts an https explorer URL", () => {
    expect(parseNetwork("test", { ...valid, explorerUrl: "https://explorer.example" }).explorerUrl).toBe(
      "https://explorer.example",
    );
  });

  it("rejects unknown and missing fields", () => {
    expect(() => parseNetwork("test", { ...valid, extra: 1 })).toThrow(/unknown field "extra"/);
    const missing: Record<string, unknown> = { ...valid };
    delete missing.rpcUrl;
    expect(() => parseNetwork("test", missing)).toThrow(/missing field "rpcUrl"/);
  });

  it("rejects malformed values", () => {
    expect(() => parseNetwork("test", { ...valid, genesis: "0x1234" })).toThrow(/genesis/);
    expect(() => parseNetwork("test", { ...valid, wsEndpoint: "https://x" })).toThrow(/wsEndpoint/);
    expect(() => parseNetwork("test", { ...valid, factoryAddress: "0x12" })).toThrow(/factoryAddress/);
    expect(() => parseNetwork("test", { ...valid, chainId: 0 })).toThrow(/chainId/);
    expect(() => parseNetwork("test", { ...valid, dotnsName: "app" })).toThrow(/dotnsName/);
    expect(() => parseNetwork("test", { ...valid, bulletinDeployEnv: "" })).toThrow(/bulletinDeployEnv/);
    expect(() => parseNetwork("test", { ...valid, knownQuote: { ...valid.knownQuote, decimals: -1 } })).toThrow(
      /decimals/,
    );
  });
});

describe("selectNetwork", () => {
  it("requires VITE_NETWORK and a known name", () => {
    expect(() => selectNetwork(undefined, { test: valid })).toThrow(/VITE_NETWORK is not set/);
    expect(() => selectNetwork("nope", { test: valid })).toThrow(/"nope" is unknown/);
  });

  it("parses every committed network", () => {
    for (const name of Object.keys(networksJson)) {
      expect(() => selectNetwork(name, networksJson)).not.toThrow();
    }
  });
});
