import { describe, expect, it } from "vitest";
import { compareDeployments, contenthashToCid, deploymentsFromNetworks, gatewayUrl } from "./lib.mjs";
import { renderHeader } from "./notes.mjs";
import { diffDeployment } from "./verify.mjs";
import { checkLiveCode, eip1167Runtime, linkedLibraries, maskedCodehash } from "./codehash.mjs";

const A = "0x341c005e16941d904Aee4a71E669362eD3c4fFe9";
const B = "0xFD6E13f0e3F9690A41b3f3a7605d075849eC01d0";
const Q = "0x02fAf33A00000000000000000000000001200000";
const M = { address: "0xB5bbdC7782Cd93c4Ee10f76Dc0200e02887c2b1a", base: "0x02FaF33B00000000000000000000000001200000", quote: Q };
const deployment = (over = {}) => ({ factory: A, faucet: B, quote: Q, markets: [M], ...over });

describe("contenthashToCid", () => {
  it("decodes an IPFS contenthash read from dotNS into its bafy CID", () => {
    // substrade-hub.paseo's contenthash for dot-v0.2.0, read on chain.
    const cid = "bafybeieyllbhj7cjwrfygqgb43z3xpdeqrpywu5ifyktlioyyhinr5cpim";
    const hex = "0xe30101701220985ac274fc49b44b8340c1e6f3bbbc64845f8b53a82e1535a1d8c1d0d8f44f43";
    expect(contenthashToCid(hex)).toBe(cid);
  });

  it("rejects an empty or non-IPFS contenthash", () => {
    expect(() => contenthashToCid("0x")).toThrow(/not an IPFS contenthash/);
    expect(() => contenthashToCid("0xe50101701220aa")).toThrow(/not an IPFS contenthash/);
  });
});

describe("gatewayUrl", () => {
  it("serves a dotNS name from dot.li", () => {
    expect(gatewayUrl("substrade-hub.paseo")).toBe("https://substrade-hub.paseo.li");
  });
});

describe("compareDeployments", () => {
  it("reports no change for the same contracts", () => {
    expect(compareDeployments({ n: deployment() }, { n: deployment() })).toEqual({ changed: [], added: [] });
  });

  it("reports a network whose factory or markets changed, and a new network", () => {
    const current = { a: deployment({ factory: B }), b: deployment({ markets: [] }), c: deployment() };
    const previous = { a: deployment(), b: deployment() };
    expect(compareDeployments(current, previous)).toEqual({ changed: ["a", "b"], added: ["c"] });
  });

  it("compares only the factory, faucet and quote against an older networks.json", () => {
    const previous = deploymentsFromNetworks({
      n: { factoryAddress: A.toLowerCase(), faucetAddress: B.toLowerCase(), knownQuote: { addr: Q.toLowerCase() } },
    });
    expect(compareDeployments({ n: deployment() }, previous)).toEqual({ changed: [], added: [] });
    expect(compareDeployments({ n: deployment({ faucet: A }) }, previous).changed).toEqual(["n"]);
  });
});

describe("renderHeader", () => {
  const manifest = {
    networks: {
      n: { name: "Paseo Asset Hub Next", dotnsName: "app.paseo", url: "https://app.paseo.li", cid: "bafyexample" },
    },
  };
  const render = (over) =>
    renderHeader({
      tag: "dot-v1.0.0",
      intro: null,
      manifest,
      comparison: { changed: [], added: [] },
      previousTag: "dot-v0.9.0",
      assetUrl: (f) => `https://example/${f}`,
      ...over,
    });

  it("lists each network with its name, gateway link and CID", () => {
    expect(render()).toContain("| Paseo Asset Hub Next | `app.paseo` | [app.paseo.li](https://app.paseo.li) | `bafyexample` |");
    expect(render()).toContain("No contract changes since `dot-v0.9.0`");
    expect(render()).toContain("verify.mjs --tag dot-v1.0.0");
  });

  it("names the networks whose contracts changed or are new", () => {
    const text = render({ comparison: { changed: ["n"], added: ["x"] } });
    expect(text).toContain("Addresses changed since `dot-v0.9.0` on: Paseo Asset Hub Next. Update any pinned copy.");
    expect(text).toContain("Networks added since `dot-v0.9.0`: x.");
    expect(text).not.toContain("No contract changes");
  });

  it("says whether every network runs this build's contract code", () => {
    expect(render()).toContain("Every network runs the contract code this release builds.");
    expect(render({ codeDiffers: ["n"] })).toContain(
      "**Deployed contracts differ from this release's build on: Paseo Asset Hub Next.** A contract redeploy is pending there",
    );
  });

  it("puts the hand-written intro first", () => {
    expect(render({ intro: "Highlights.\n" }).startsWith("Highlights.\n\n## Where it is live")).toBe(true);
  });
});

describe("diffDeployment", () => {
  it("accepts a matching deployment and reports each mismatch", () => {
    expect(diffDeployment(deployment(), deployment())).toEqual([]);
    expect(diffDeployment(deployment(), deployment({ factory: B, markets: [] }))).toEqual([
      `factory is ${B}, the release records ${A}`,
      `markets are none, the release records ${M.address}`,
    ]);
  });
});

describe("maskedCodehash", () => {
  // 8 code bytes, then 2 bytes of CBOR metadata and its 2-byte length (0x0002).
  const code = (body) => `0x${body}aaaa0002`;

  it("ignores the metadata, the masked ranges and unlinked library placeholders", () => {
    const base = maskedCodehash(code("1111222233334444"), [[2, 2]]);
    expect(maskedCodehash(`0x1111ffff33334444bbbb0002`, [[2, 2]])).toBe(base); // other metadata and masked bytes
    expect(maskedCodehash(code("1111222233334444"), [])).not.toBe(base); // the masked bytes count when unmasked
  });

  it("treats forge's link placeholder as a zeroed address", () => {
    const placeholder = `__$${"1".repeat(34)}$__`;
    const linked = `0x00${"ab".repeat(20)}00aaaa0002`;
    const unlinked = `0x00${placeholder}00aaaa0002`;
    expect(maskedCodehash(unlinked, [[1, 20]])).toBe(maskedCodehash(linked, [[1, 20]]));
  });
});

describe("eip1167Runtime", () => {
  it("is the 45-byte minimal proxy to the implementation, as deployed on paseo-v2", () => {
    expect(eip1167Runtime("0x91762b345A73222a0082740D94b9D96aB4f494A8")).toBe(
      "0x363d3d373d3d3d363d7391762b345a73222a0082740d94b9d96ab4f494a85af43d82803e903d91602b57fd5bf3",
    );
  });
});

describe("linkedLibraries", () => {
  const lib = "ab".repeat(20);
  const code = (a, b) => `0x00${a}00${b}aaaa0002`; // link sites at bytes 1 and 22

  it("finds the library linked at every one of its sites", () => {
    expect(linkedLibraries(code(lib, lib), { Lib: [1, 22] })).toEqual({
      libraries: { Lib: "0xABaBaBaBABabABabAbAbABAbABabababaBaBABaB" },
      problems: [],
    });
  });

  it("reports sites that disagree, or code too short for them, without throwing", () => {
    expect(linkedLibraries(code(lib, "cd".repeat(20)), { Lib: [1, 22] }).problems).toHaveLength(1);
    expect(linkedLibraries("0x00", { Lib: [1, 22] })).toEqual({
      libraries: {},
      problems: ["the implementation does not link one Lib address at all of its 2 link sites"],
    });
  });
});

describe("checkLiveCode", () => {
  const FACTORY = "0x00000000000000000000000000000000000000f1";
  const FAUCET = "0x00000000000000000000000000000000000000f2";
  const IMPL = "0x00000000000000000000000000000000000000f3";
  const MARKET = { address: "0x00000000000000000000000000000000000000f4", base: "0x0000000000000000000000000000000000000001", quote: "0x0000000000000000000000000000000000000002" };
  const plain = (body) => `0x${body}aaaa0002`;
  const codehashes = {
    contracts: {
      DLOB: { codehash: maskedCodehash(plain("1111"), []), mask: [], links: {} },
      DLOBFactory: { codehash: maskedCodehash(plain("2222"), []), mask: [] },
      Faucet: { codehash: maskedCodehash(plain("3333"), []), mask: [] },
    },
  };
  const client = (implementationCode) => ({
    getCode: async ({ address }) =>
      ({ [IMPL]: implementationCode, [FACTORY]: plain("2222"), [FAUCET]: plain("3333"), [MARKET.address]: eip1167Runtime(IMPL) })[address],
    readContract: async ({ functionName }) => (functionName === "IMPLEMENTATION" ? IMPL : MARKET.address),
  });
  const deployment = { factory: FACTORY, faucet: FAUCET, markets: [MARKET] };

  it("reports a pending redeploy without reading libraries at another build's link sites", async () => {
    const live = await checkLiveCode({}, deployment, codehashes, client(plain("9999")));
    expect(live.problems).toEqual([`DLOB at ${IMPL} runs other code than this release's build`]);
    expect(live.libraries).toEqual({});
  });
});
