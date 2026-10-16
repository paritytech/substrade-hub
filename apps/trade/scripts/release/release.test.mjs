import { describe, expect, it } from "vitest";
import { compareDeployments, contenthashToCid, deploymentsFromNetworks, gatewayUrl } from "./lib.mjs";
import { renderHeader } from "./notes.mjs";
import { diffDeployment } from "./verify.mjs";

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
