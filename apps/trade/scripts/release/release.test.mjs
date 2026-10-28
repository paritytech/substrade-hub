// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import { describe, expect, it } from "vitest";
import { compareDeployments, contenthashToCid, deploymentsFromNetworks, gatewayUrl } from "./lib.mjs";
import { renderHeader } from "./notes.mjs";
import { diffDeployment, coverage, networkToVerify } from "./verify.mjs";
import { checkLiveCode, eip1167Runtime, linkedLibraries, maskedCodehash } from "./codehash.mjs";
import { abiFromModule, diffAbi, renderAbiChanges } from "./abi.mjs";

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

  it("links the ABIs and adds the ABI changes after the contracts", () => {
    const text = render({ abiChanges: ["### ABI changes", "", "No ABI changes since `dot-v0.9.0`.", ""] });
    expect(text).toContain("and their ABIs in [`abis.json`](https://example/abis.json).");
    expect(text.indexOf("### ABI changes")).toBeGreaterThan(text.indexOf("### Contracts"));
    expect(text.indexOf("### ABI changes")).toBeLessThan(text.indexOf("### Verify"));
  });
});

describe("diffAbi", () => {
  const u = (type, name = "") => ({ name, type, internalType: type });
  const fn = (name, inputs, outputs = [], stateMutability = "nonpayable") => ({ type: "function", name, inputs, outputs, stateMutability });
  const place = fn("placeLimitOrder", [u("uint8", "side"), u("uint96", "price")], [u("uint32", "orderId")], "payable");

  it("reports nothing for the same ABI, whatever the parameter names", () => {
    const renamed = fn("placeLimitOrder", [u("uint8", "s"), u("uint96", "p")], [u("uint32", "id")], "payable");
    expect(diffAbi([place], [renamed])).toEqual({ removed: [], changed: [], added: [] });
  });

  it("reports a changed result, mutability or event indexing", () => {
    const placeTwo = { ...place, outputs: [u("uint32"), u("uint128")] };
    const ev = (indexed) => ({ type: "event", name: "Trade", anonymous: false, inputs: [{ ...u("uint32", "id"), indexed }] });
    expect(diffAbi([place, ev(false)], [placeTwo, ev(true)]).changed).toEqual([
      { from: "function placeLimitOrder(uint8,uint96) payable returns (uint32)", to: "function placeLimitOrder(uint8,uint96) payable returns (uint32,uint128)" },
      { from: "event Trade(uint32)", to: "event Trade(uint32 indexed)" },
    ]);
    expect(diffAbi([fn("f", [])], [fn("f", [], [], "view")]).changed).toEqual([{ from: "function f()", to: "function f() view" }]);
  });

  it("pairs a new signature with the one it replaces, and keeps removals and additions apart", () => {
    const market = fn("placeMarketOrder", [u("uint8")]);
    const marketWithLimit = fn("placeMarketOrder", [u("uint8"), u("uint96")]);
    const diff = diffAbi(
      [market, fn("gone", []), { type: "error", name: "Old", inputs: [] }],
      [marketWithLimit, fn("fresh", [u("address")]), { type: "error", name: "Halted", inputs: [] }],
    );
    expect(diff.changed).toEqual([{ from: "function placeMarketOrder(uint8)", to: "function placeMarketOrder(uint8,uint96)" }]);
    expect(diff.removed).toEqual(["function gone()", "error Old()"]);
    expect(diff.added).toEqual(["function fresh(address)", "error Halted()"]);
  });

  it("writes tuples out, and ignores the constructor and receive", () => {
    const tuple = { name: "t", type: "tuple[]", components: [u("address"), u("bytes")] };
    const diff = diffAbi([{ type: "constructor", inputs: [] }], [{ type: "receive", stateMutability: "payable" }, fn("g", [tuple])]);
    expect(diff).toEqual({ removed: [], changed: [], added: ["function g((address,bytes)[])"] });
  });
});

describe("renderAbiChanges", () => {
  const f = (name, outputs = []) => ({ type: "function", name, inputs: [], outputs, stateMutability: "nonpayable" });
  const abis = (dlob, factory = []) => ({ DLOB: dlob, DLOBFactory: factory });

  it("says when nothing changed", () => {
    expect(renderAbiChanges(abis([f("a")]), abis([f("a")]), "dot-v0.9.0")).toContain("No ABI changes since `dot-v0.9.0`.");
  });

  it("lists breaking changes per contract and collapses additions", () => {
    const text = renderAbiChanges(
      abis([f("a"), f("b")]),
      abis([f("a", [{ type: "uint32" }])], [f("halt")]),
      "dot-v0.9.0",
    ).join("\n");
    expect(text).toContain("**Breaking since `dot-v0.9.0`**: clients built against its ABI need updating.");
    expect(text).toContain("- `DLOB`: `function a()` becomes `function a() returns (uint32)`");
    expect(text).toContain("- `DLOB`: removed `function b()`");
    expect(text).toContain("<summary>1 addition</summary>\n\n- `DLOBFactory`: `function halt()`");
  });

  it("says nothing breaks when there are only additions", () => {
    const text = renderAbiChanges(abis([]), abis([f("a")]), "dot-v0.9.0").join("\n");
    expect(text).toContain("Nothing breaking since `dot-v0.9.0`.");
    expect(text).toContain("<summary>1 addition</summary>");
  });
});

describe("abiFromModule", () => {
  it("reads the ABI out of a generated file", () => {
    const source = '// Auto-generated\nexport const dlobAbi = [\n  {\n    "type": "receive",\n    "stateMutability": "payable"\n  }\n] as const;\n';
    expect(abiFromModule(source)).toEqual([{ type: "receive", stateMutability: "payable" }]);
    expect(() => abiFromModule("export const x = 1;")).toThrow(/not a generated ABI file/);
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

describe("networkToVerify", () => {
  const location = { dotnsName: "app.paseo", rpcUrl: "https://rpc.example", dotnsContentResolver: A };
  const trusted = {
    name: "Net",
    ...location,
    chainId: 1,
    genesis: "0xaa",
    factoryAddress: A,
    faucetAddress: B,
    knownQuote: { addr: A.toLowerCase() },
  };
  const recorded = { chainId: 1, genesis: "0xAA", factory: A, faucet: B, quote: A };

  it("reads the chain and the contracts where networks.json says", () => {
    const { net, problems } = networkToVerify(trusted, { ...location, cid: "bafy" }, recorded);
    expect(problems).toEqual([]);
    expect(net).toMatchObject({ ...location, name: "Net", factoryAddress: A, faucetAddress: B, knownQuote: { addr: A.toLowerCase() } });
  });

  it("keeps networks.json's location and reports the manifest's", () => {
    const entry = { dotnsName: "other.paseo", rpcUrl: "https://attacker.example", dotnsContentResolver: B };
    const { net, problems } = networkToVerify(trusted, entry, recorded);
    expect(net).toMatchObject(location);
    expect(problems).toEqual([
      "the release manifest gives dotnsName other.paseo, networks.json gives app.paseo",
      "the release manifest gives rpcUrl https://attacker.example, networks.json gives https://rpc.example",
      `the release manifest gives dotnsContentResolver ${B}, networks.json gives ${A}`,
    ]);
  });

  it("keeps networks.json's contracts and reports the release's", () => {
    const forged = { chainId: 2, genesis: "0xbb", factory: B, faucet: "not an address", quote: B };
    const { net, problems } = networkToVerify(trusted, location, forged);
    expect(net).toMatchObject({ chainId: 1, genesis: "0xaa", factoryAddress: A, faucetAddress: B });
    expect(problems).toEqual([
      "the release records chainId 2, networks.json gives 1",
      "the release records genesis 0xbb, networks.json gives 0xaa",
      `the release records factory ${B}, networks.json gives ${A}`,
      `the release records faucet not an address, networks.json gives ${B}`,
      `the release records quote ${B}, networks.json gives ${A.toLowerCase()}`,
    ]);
  });
});

describe("coverage", () => {
  const source = { a: { name: "A net" }, b: { name: "B net" } };

  it("covers every network networks.json has", () => {
    expect(coverage(source, { networks: { a: {}, b: {} } }, { a: {}, b: {} })).toEqual({ problems: [], covered: ["a", "b"] });
  });

  it("reports a network the release leaves out, and checks the rest", () => {
    expect(coverage(source, { networks: { a: {} } }, { a: {} })).toEqual({
      problems: ["release-manifest.json and deployments.json leave out B net"],
      covered: ["a"],
    });
    expect(coverage(source, { networks: {} }, { a: {}, b: {} }).covered).toEqual([]);
  });

  it("reports a network networks.json does not have", () => {
    expect(coverage(source, { networks: { a: {}, b: {}, c: {} } }, { a: {}, b: {} }).problems).toEqual([
      "the release's files name c, which networks.json does not have",
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

  it("hashes code shorter than the masked ranges as a mismatch, without throwing", () => {
    const short = maskedCodehash(code("11112222"), [[40, 20]]);
    expect(short).not.toBe(maskedCodehash(code("1111222233334444"), [[40, 20]]));
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
