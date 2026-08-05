// Config for `pad` (@polkadot-community-foundation/polkadot-app-deploy). Publishes the built `dist/` to
// the Bulletin chain and points the registered DotNS name `substrade-hub.dot` at it. See docs/deploy.md.

// The published app version is derived from the release, not hardcoded, so successive `dot-v*` tags do
// not all publish as the same version. APP_VERSION is REQUIRED (the deploy workflow sets it from the tag
// or the workflow_dispatch input; a local `pad` run must export it) — publishing without an explicit
// version is a mistake, so we throw rather than default. The strict regex rejects malformed input like
// "1..2" that a naive split+Number would silently coerce (Number("") === 0).
function appVersion(): [number, number, number] {
  const raw = process.env.APP_VERSION;
  if (!raw) {
    throw new Error("APP_VERSION is required (MAJOR.MINOR.PATCH); set it from the release before publishing.");
  }
  if (!/^\d+\.\d+\.\d+$/.test(raw)) {
    throw new Error(`Invalid APP_VERSION "${raw}"; expected MAJOR.MINOR.PATCH`);
  }
  return raw.split(".").map(Number) as [number, number, number];
}

export default {
  domain: "substrade-hub.dot",
  displayName: "SubsTrade Hub",
  description: "Fully on-chain order-book DEX on Asset Hub.",
  icon: { path: "./icon.png", format: "png" },
  executables: [{ kind: "app", path: "./dist", appVersion: appVersion() }],
};
