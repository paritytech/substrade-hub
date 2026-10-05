/// <reference types="node" />
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Controllable fake PAPI client injected in place of the real one.
const { mockClient } = vi.hoisted(() => ({ mockClient: {} as Record<string, any> }));
vi.mock("./client", () => ({ getClient: () => mockClient }));

import { readFileSync } from "node:fs";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { getLookupFn } from "@polkadot-api/metadata-builders";
import { buildMetadataDef, ensureExtensionMetadata, MetadataError } from "./extension-metadata";

// The runtime the app is built against (see .papi/polkadot-api.json).
const metadata = unifyMetadata(
  decAnyMetadata(readFileSync(new URL("../../.papi/metadata/ah_previewnet.scale", import.meta.url))),
);
const signedExtensionsByVersion = metadata.extrinsic.signedExtensions;
const signedExtensions = Array.isArray(signedExtensionsByVersion)
  ? signedExtensionsByVersion
  : (signedExtensionsByVersion[0] ?? []);

/** Signed extensions `@polkadot/types` encodes natively, so they need no `userExtensions` entry. */
const POLKADOT_TYPES_BUILTINS = new Set([
  "CheckNonZeroSender",
  "CheckSpecVersion",
  "CheckTxVersion",
  "CheckGenesis",
  "CheckMortality",
  "CheckNonce",
  "CheckWeight",
  "ChargeTransactionPayment",
  "ChargeAssetTxPayment",
  "CheckMetadataHash",
]);

const GENESIS = "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2";

beforeEach(() => {
  mockClient.getChainSpecData = vi.fn().mockResolvedValue({
    name: "Paseo Asset Hub",
    genesisHash: GENESIS,
    properties: { ss58Format: 42, tokenDecimals: 10, tokenSymbol: "PAS" },
  });
  mockClient._request = vi.fn().mockResolvedValue({ specVersion: 2004001 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildMetadataDef", () => {
  it("maps chain spec + runtime version to the MetadataDef shape", async () => {
    const def = await buildMetadataDef();
    expect(def).toMatchObject({
      chain: "Paseo Asset Hub",
      genesisHash: GENESIS,
      specVersion: 2004001,
      ss58Format: 42,
      tokenDecimals: 10,
      tokenSymbol: "PAS",
      icon: "substrate",
    });
  });

  it("declares every custom signed extension of the committed runtime metadata, with matching shapes", async () => {
    const def = await buildMetadataDef();
    const lookup = getLookupFn(metadata);
    const custom = signedExtensions.filter((e) => !POLKADOT_TYPES_BUILTINS.has(e.identifier));
    expect(Object.keys(def.userExtensions)).toEqual(custom.map((e) => e.identifier));
    for (const e of custom) {
      const declared = def.userExtensions[e.identifier]!;
      // No custom extension carries an implicit (signed-only) part, so the payload half stays empty.
      expect(lookup(e.additionalSigned).type, `${e.identifier} implicit`).toBe("void");
      expect(declared.payload).toEqual({});
      const explicit = lookup(e.type).type;
      const fields = Object.values(declared.extrinsic);
      if (explicit === "void") expect(fields, e.identifier).toEqual([]);
      else if (explicit === "option") expect(fields, e.identifier).toEqual(["Option<Null>"]);
      else if (explicit === "primitive") {
        expect(fields, e.identifier).toEqual([(lookup(e.type) as { value: string }).value]);
      }
      else throw new Error(`${e.identifier}: unhandled extension type "${explicit}"; extend USER_EXTENSIONS`);
    }
  });

  it("takes the first entry of array-form token properties (multi-asset chains)", async () => {
    mockClient.getChainSpecData = vi.fn().mockResolvedValue({
      name: "X",
      genesisHash: GENESIS,
      properties: { ss58Format: 0, tokenDecimals: [12], tokenSymbol: ["WND"] },
    });
    const def = await buildMetadataDef();
    expect(def.tokenDecimals).toBe(12);
    expect(def.tokenSymbol).toBe("WND");
    expect(def.ss58Format).toBe(0); // 0 is a valid prefix, not a missing value
  });
});

function stubExtension(metadata: unknown) {
  vi.stubGlobal("window", {
    injectedWeb3: { "polkadot-js": { enable: vi.fn().mockResolvedValue({ metadata }) } },
  });
}

describe("ensureExtensionMetadata", () => {
  it("throws no-metadata-api when the extension is absent", async () => {
    vi.stubGlobal("window", { injectedWeb3: {} });
    await expect(ensureExtensionMetadata("polkadot-js")).rejects.toMatchObject({
      code: "no-metadata-api",
    });
  });

  it("throws no-metadata-api (a MetadataError) when the wallet lacks the metadata API", async () => {
    stubExtension(undefined);
    await expect(ensureExtensionMetadata("polkadot-js")).rejects.toBeInstanceOf(MetadataError);
    await expect(ensureExtensionMetadata("polkadot-js")).rejects.toMatchObject({
      code: "no-metadata-api",
    });
  });

  it("skips provide() when the current genesis+spec is already registered", async () => {
    const provide = vi.fn();
    stubExtension({
      get: vi.fn().mockResolvedValue([{ genesisHash: GENESIS, specVersion: 2004001 }]),
      provide,
    });
    await ensureExtensionMetadata("polkadot-js");
    expect(provide).not.toHaveBeenCalled();
  });

  it("calls provide() with the def when not registered, and resolves on approval", async () => {
    const provide = vi.fn().mockResolvedValue(true);
    stubExtension({ get: vi.fn().mockResolvedValue([]), provide });
    await ensureExtensionMetadata("polkadot-js");
    expect(provide).toHaveBeenCalledOnce();
    expect(provide).toHaveBeenCalledWith(
      expect.objectContaining({ genesisHash: GENESIS, specVersion: 2004001 }),
    );
  });

  it("provide()s when a different spec version is known (stale registration)", async () => {
    const provide = vi.fn().mockResolvedValue(true);
    stubExtension({
      get: vi.fn().mockResolvedValue([{ genesisHash: GENESIS, specVersion: 1000000 }]),
      provide,
    });
    await ensureExtensionMetadata("polkadot-js");
    expect(provide).toHaveBeenCalledOnce();
  });

  it("throws declined when the user rejects the metadata prompt", async () => {
    stubExtension({ get: vi.fn().mockResolvedValue([]), provide: vi.fn().mockResolvedValue(false) });
    await expect(ensureExtensionMetadata("polkadot-js")).rejects.toMatchObject({ code: "declined" });
  });
});
