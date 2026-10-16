import { beforeEach, describe, expect, it, vi } from "vitest";

const OTHER_QUOTE = "0x000007c000000000000000000000000001200000";
const TNVDA = "0x0000000500000000000000000000000001200000";
const NO_CODE = "0x000000000000000000000000000000000000dead";
const T18 = "0x0000000700000000000000000000000001200000"; // an asset with 18 decimals

const { readContract, getMetadata, FACTORY, TUSD } = vi.hoisted(() => ({
  readContract: vi.fn(),
  getMetadata: vi.fn(),
  FACTORY: "0x00000000000000000000000000000000000000fa",
  TUSD: "0x02faf33a00000000000000000000000001200000",
}));
vi.mock("../lib/contract", () => ({ readContract }));
vi.mock("../lib/client", () => ({
  getTypedApi: () => ({ query: { Assets: { Metadata: { getValue: getMetadata } } } }),
}));
vi.mock("../config/chains", () => ({
  activeChain: { factoryAddress: FACTORY, knownQuote: { addr: TUSD, symbol: "tUSD", decimals: 6 } },
}));

import { fetchMarkets, MAX_MARKETS } from "./use-markets";

const bytes = (s: string) => new TextEncoder().encode(s);

/** Factory markets as [address, base, quote]; a market address in `broken` fails getMarketInfo. */
function chain(markets: Array<[string, string, string]>, broken: string[] = []) {
  readContract.mockImplementation(async (_abi, fn: string, args: unknown[], addr: string) => {
    if (fn === "getMarketCount") return BigInt(markets.length);
    if (fn === "getMarketAt") return markets[Number(args[0])]![0];
    if (fn === "getMarketInfo") {
      if (broken.includes(addr)) throw new Error("eth_transact failed");
      const m = markets.find(([a]) => a === addr)!;
      return [m[1], m[2], 1n, 1n, 1n];
    }
    // ERC-20 fallback for a token with no pallet-assets metadata: an address with no code returns no data.
    throw new Error(`AbiDecodingZeroDataError: ${fn}() returned no data`);
  });
}

beforeEach(() => {
  readContract.mockReset();
  getMetadata.mockReset();
  getMetadata.mockImplementation(async (id: number) =>
    id === 0x02faf33a
      ? { name: bytes("Test USD"), symbol: bytes("tUSD"), decimals: 6 }
      : id === 5
        ? { name: bytes("Test NVIDIA"), symbol: bytes("tNVDA"), decimals: 6 }
        : id === 7
          ? { name: bytes("Test Ether"), symbol: bytes("tETH"), decimals: 18 }
          : undefined,
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("fetchMarkets", () => {
  it("skips a market whose token has no code and still returns the others", async () => {
    chain([
      ["0xa1", NO_CODE, TUSD],
      ["0xa2", TNVDA, TUSD],
    ]);
    const markets = await fetchMarkets();
    expect(markets.map((m) => m.address)).toEqual(["0xa2"]);
    expect(markets[0]!.base.symbol).toBe("tNVDA");
  });

  it("skips a market that fails to load and still returns the others", async () => {
    chain(
      [
        ["0xa1", TNVDA, TUSD],
        ["0xa2", TNVDA, TUSD],
      ],
      ["0xa1"],
    );
    expect((await fetchMarkets()).map((m) => m.address)).toEqual(["0xa2"]);
  });

  it("drops a market quoted in another token before looking up its tokens", async () => {
    chain([
      ["0xa1", NO_CODE, OTHER_QUOTE],
      ["0xa2", TNVDA, TUSD],
    ]);
    expect((await fetchMarkets()).map((m) => m.address)).toEqual(["0xa2"]);
    expect(readContract.mock.calls.some(([, , , addr]) => addr === NO_CODE)).toBe(false);
  });

  it("skips a market whose base and quote decimals differ, since its prices would show off by 10^k", async () => {
    chain([
      ["0xa1", T18, TUSD],
      ["0xa2", TNVDA, TUSD],
    ]);
    expect((await fetchMarkets()).map((m) => m.address)).toEqual(["0xa2"]);
  });

  it("fails when every market fails, so an outage is not shown as an empty exchange", async () => {
    chain([["0xa1", TNVDA, TUSD]], ["0xa1"]);
    await expect(fetchMarkets()).rejects.toThrow("Could not load any market");
  });

  it("returns an empty list for a factory with no markets", async () => {
    chain([]);
    expect(await fetchMarkets()).toEqual([]);
  });

  it(`reads at most ${MAX_MARKETS} markets`, async () => {
    chain(Array.from({ length: MAX_MARKETS + 5 }, (_, i) => [`0xa${i}`, TNVDA, TUSD] as [string, string, string]));
    expect(await fetchMarkets()).toHaveLength(MAX_MARKETS);
  });
});
