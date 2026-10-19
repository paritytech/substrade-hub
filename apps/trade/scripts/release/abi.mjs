/**
 * What changed in the contracts' interface. A release attaches `abis.json`, the DLOB's and the
 * factory's ABIs from its build, and its notes list what changed since the previous release: a removed
 * or changed function, event or error breaks clients built against the old ABI, often as a bare revert
 * or an undecodable result. Additions are listed apart, since they break nothing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The contracts whose ABI a release records, by artifact name, with the app's generated ABI file. */
export const ABI_CONTRACTS = { DLOB: "dlob.ts", DLOBFactory: "dlob-factory.ts" };

/** `abis.json` for a forge build in `contractsDir`. */
export function builtAbis(contractsDir) {
  const abis = {};
  for (const name of Object.keys(ABI_CONTRACTS)) {
    abis[name] = JSON.parse(readFileSync(join(contractsDir, "out", `${name}.sol`, `${name}.json`), "utf8")).abi;
  }
  return abis;
}

/** The ABI in one of the app's generated files (`export const fooAbi = [...] as const;`). */
export function abiFromModule(source) {
  const match = source.match(/=\s*(\[[\s\S]*\])\s*as const;?\s*$/);
  if (!match) throw new Error("not a generated ABI file");
  return JSON.parse(match[1]);
}

/** `abis.json` from a directory holding the app's generated ABI files, as an older release has them. */
export function abisFromModules(dir) {
  const abis = {};
  for (const [name, file] of Object.entries(ABI_CONTRACTS)) {
    abis[name] = abiFromModule(readFileSync(join(dir, file), "utf8"));
  }
  return abis;
}

/** A parameter list as Solidity writes it: types, tuples expanded, `indexed` kept. Names are left out. */
function params(list = []) {
  return list
    .map((p) => {
      const type = p.type.startsWith("tuple") ? `(${params(p.components)})${p.type.slice("tuple".length)}` : p.type;
      return p.indexed ? `${type} indexed` : type;
    })
    .join(",");
}

/** The items a client depends on, keyed by kind and signature. */
function entries(abi) {
  const out = new Map();
  for (const item of abi) {
    if (!["function", "event", "error"].includes(item.type)) continue;
    const key = `${item.type} ${item.name}(${params(item.inputs).replaceAll(" indexed", "")})`;
    let text = `${item.type} ${item.name}(${params(item.inputs)})`;
    if (item.type === "function") {
      if (item.stateMutability !== "nonpayable") text += ` ${item.stateMutability}`;
      if (item.outputs?.length) text += ` returns (${params(item.outputs)})`;
    }
    if (item.type === "event" && item.anonymous) text += " anonymous";
    out.set(key, { kind: item.type, name: item.name, text });
  }
  return out;
}

/**
 * How `current` differs from `previous`: items removed, changed (same name, a different signature,
 * result, mutability or indexing) and added, each as Solidity text. An item whose signature changed
 * pairs with the one added under its name when there is exactly one of each.
 */
export function diffAbi(previous, current) {
  const before = entries(previous);
  const after = entries(current);
  const removed = [...before].filter(([k]) => !after.has(k)).map(([, e]) => e);
  const added = [...after].filter(([k]) => !before.has(k)).map(([, e]) => e);
  const changed = [];
  for (const [k, e] of before) {
    const now = after.get(k);
    if (now && now.text !== e.text) changed.push({ from: e.text, to: now.text });
  }
  const same = (a) => (b) => a.kind === b.kind && a.name === b.name;
  for (const e of [...removed]) {
    const olds = removed.filter(same(e));
    const news = added.filter(same(e));
    if (olds.length !== 1 || news.length !== 1) continue;
    changed.push({ from: e.text, to: news[0].text });
    removed.splice(removed.indexOf(e), 1);
    added.splice(added.indexOf(news[0]), 1);
  }
  return { removed: removed.map((e) => e.text), changed, added: added.map((e) => e.text) };
}

/** The notes' "ABI changes" section, comparing `current` with the ABIs of `previousTag`. */
export function renderAbiChanges(previous, current, previousTag) {
  const breaking = [];
  const additions = [];
  for (const name of Object.keys(ABI_CONTRACTS)) {
    const diff = diffAbi(previous[name] ?? [], current[name]);
    for (const text of diff.removed) breaking.push(`- \`${name}\`: removed \`${text}\``);
    for (const { from, to } of diff.changed) breaking.push(`- \`${name}\`: \`${from}\` becomes \`${to}\``);
    for (const text of diff.added) additions.push(`- \`${name}\`: \`${text}\``);
  }
  const lines = ["### ABI changes", ""];
  if (!breaking.length && !additions.length) {
    lines.push(`No ABI changes since \`${previousTag}\`.`);
  } else {
    if (breaking.length) {
      lines.push(`**Breaking since \`${previousTag}\`**: clients built against its ABI need updating.`, "", ...breaking);
    } else {
      lines.push(`Nothing breaking since \`${previousTag}\`.`);
    }
    if (additions.length) {
      lines.push(
        "",
        "<details>",
        `<summary>${additions.length} addition${additions.length === 1 ? "" : "s"}</summary>`,
        "",
        ...additions,
        "",
        "</details>",
      );
    }
  }
  lines.push("");
  return lines;
}
