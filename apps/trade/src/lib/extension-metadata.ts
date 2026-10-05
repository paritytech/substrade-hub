import { getClient } from "./client";

/** An `@polkadot/types` ExtDef entry: field name -> type string, for `extrinsic` and `payload` parts. */
type ExtDef = Record<string, { extrinsic: Record<string, string>; payload: Record<string, string> }>;

/**
 * The custom signed extensions on the Asset Hub Next runtime (`next-asset-hub-paseo`). A browser
 * extension's `@polkadot/types` registry SILENTLY DROPS signed-extension names it doesn't recognise
 * (`expandExtensionTypes` filters unknowns), so it re-encodes a too-short payload and the signature
 * fails on-chain with `BadProof`. Declaring them here (pushed to the wallet via `metadata.provide`)
 * stops the drop. Every value defaults to None/false/empty, matching the bytes the chain and PAPI's
 * native signer produce (each Option/bool custom extension encodes to `0x00`; the rest to empty).
 *
 * `extension-metadata.test.ts` checks this table against the committed `.papi` metadata, so a runtime
 * upgrade that changes the set fails the tests once the descriptors are regenerated. The `Option<...>`
 * inner types are irrelevant while the value is None (`0x00` regardless), so `Option<Null>` suffices
 * for the enum-valued ones — we never send `Some`.
 */
export const USER_EXTENSIONS: ExtDef = {
  UnitTransactionExtension: { extrinsic: {}, payload: {} },
  AsScarcity: { extrinsic: { asScarcity: "Option<Null>" }, payload: {} },
  AuthorizeCall: { extrinsic: {}, payload: {} },
  AsPgas: { extrinsic: { asPgas: "Option<Null>" }, payload: {} },
  AsDotnsGateway: { extrinsic: { asDotnsGateway: "Option<Null>" }, payload: {} },
  RestrictOrigins: { extrinsic: { restrictOrigins: "bool" }, payload: {} },
  EthSetOrigin: { extrinsic: {}, payload: {} },
  StorageWeightReclaim: { extrinsic: {}, payload: {} },
};

/** Subset of `@polkadot/extension-inject`'s `MetadataDef` that `metadata.provide` requires. */
export interface MetadataDef {
  chain: string;
  genesisHash: string;
  icon: string;
  ss58Format: number;
  specVersion: number;
  tokenDecimals: number;
  tokenSymbol: string;
  types: Record<string, unknown>;
  userExtensions: ExtDef;
}

/** The raw injected extension's metadata API — NOT exposed by PAPI's typed `connectInjectedExtension`. */
interface RawMetadata {
  get: () => Promise<{ genesisHash: string; specVersion: number }[]>;
  provide: (def: MetadataDef) => Promise<boolean>;
}
interface RawInjected {
  metadata?: RawMetadata;
}

const DAPP_NAME = "SubsTrade Hub";

export type MetadataErrorCode = "no-metadata-api" | "declined";

/** Typed failure so the UI can distinguish "wallet can't do this" from "user said no". */
export class MetadataError extends Error {
  constructor(
    public code: MetadataErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MetadataError";
  }
}

function firstOf<T>(v: T | T[] | undefined, fallback: T): T {
  if (Array.isArray(v)) return v[0] ?? fallback;
  return v ?? fallback;
}

/** Build the `MetadataDef` for the connected chain from the live client (chain spec + runtime version). */
export async function buildMetadataDef(): Promise<MetadataDef> {
  const client = getClient();
  const [spec, runtime] = await Promise.all([
    client.getChainSpecData(),
    client._request<{ specVersion: number }>("state_getRuntimeVersion", []),
  ]);
  const props = (spec.properties ?? {}) as {
    ss58Format?: number;
    tokenDecimals?: number | number[];
    tokenSymbol?: string | string[];
  };
  return {
    chain: spec.name,
    genesisHash: spec.genesisHash,
    icon: "substrate",
    ss58Format: props.ss58Format ?? 42,
    specVersion: runtime.specVersion,
    tokenDecimals: firstOf(props.tokenDecimals, 10),
    tokenSymbol: firstOf(props.tokenSymbol, "PAS"),
    types: {},
    userExtensions: USER_EXTENSIONS,
  };
}

/**
 * Ensure the injected extension knows this chain's custom signed extensions, so its signer can encode a
 * valid payload (otherwise the silent-drop above produces `BadProof`). Idempotent: skips `provide()` if
 * the current genesis+spec is already registered; prompts the user the first time. Throws `MetadataError`
 * if the wallet lacks the metadata API or the user declines.
 */
export async function ensureExtensionMetadata(extensionName: string): Promise<void> {
  const entry = window.injectedWeb3?.[extensionName];
  if (!entry) throw new MetadataError("no-metadata-api", `Extension "${extensionName}" not found.`);
  // PAPI globally types the enabled object without `metadata`; cast to reach the raw metadata API.
  const raw = (await entry.enable(DAPP_NAME)) as unknown as RawInjected;
  if (!raw.metadata?.provide || !raw.metadata.get) {
    throw new MetadataError(
      "no-metadata-api",
      "This wallet can't register the network's signing metadata, so it can't sign on this chain.",
    );
  }
  const def = await buildMetadataDef();
  const known = await raw.metadata.get();
  const present = known.some(
    (m) => m.genesisHash === def.genesisHash && m.specVersion === def.specVersion,
  );
  if (present) return;
  const approved = await raw.metadata.provide(def);
  if (!approved) {
    throw new MetadataError("declined", "Network metadata update was declined in the wallet.");
  }
}
