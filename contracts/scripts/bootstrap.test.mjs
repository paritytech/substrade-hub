// Tests for the bootstrap's contract deploys. Run with `node --test scripts/bootstrap.test.mjs` from
// contracts/, after `forge build`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forge, linkedBytecode } from "./bootstrap.mjs";

/**
 * A fake `forge` on PATH that logs each call's arguments and acts by call number: `fail` exits 1,
 * `hang` sleeps longer than the test's time limit, anything else succeeds.
 */
function fakeForge(behaviour) {
  const dir = mkdtempSync(join(tmpdir(), "fake-forge-"));
  const log = join(dir, "calls.log");
  const script = `#!/bin/sh
n=$(( $( [ -f "${log}" ] && wc -l < "${log}" || echo 0) + 1 ))
echo "$*" >> "${log}"
case "$n" in
${behaviour.map((b, i) => `  ${i + 1}) ${b === "fail" ? "exit 1" : b === "hang" ? "exec sleep 30" : "exit 0"} ;;`).join("\n")}
esac
exit 0
`;
  writeFileSync(join(dir, "forge"), script);
  chmodSync(join(dir, "forge"), 0o755);
  return { dir, calls: () => readFileSync(log, "utf8").trim().split("\n") };
}

test("a failed or stuck broadcast is run again afresh, never with --resume", async () => {
  const fake = fakeForge(["fail", "hang", "ok"]);
  const path = process.env.PATH;
  process.env.PATH = `${fake.dir}:${path}`;
  const started = Date.now();
  try {
    await forge("DeployFactory.s.sol", "http://rpc.invalid", "0xkey", {}, { timeoutMs: 1_000, retryMs: 10 });
  } finally {
    process.env.PATH = path;
  }
  const calls = fake.calls();
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.match(call, /^script script\/DeployFactory\.s\.sol --rpc-url http:\/\/rpc\.invalid .*--broadcast --slow$/);
    assert.doesNotMatch(call, /--resume/);
  }
  assert.ok(Date.now() - started < 10_000, "the stuck attempt is stopped at the time limit");
});

test("the last failure is passed on", async () => {
  const fake = fakeForge(["fail", "fail", "fail"]);
  const path = process.env.PATH;
  process.env.PATH = `${fake.dir}:${path}`;
  try {
    await assert.rejects(forge("DeployFactory.s.sol", "http://rpc.invalid", "0xkey", {}, { timeoutMs: 1_000, retryMs: 10 }));
  } finally {
    process.env.PATH = path;
  }
  assert.equal(fake.calls().length, 3);
});

test("the implementation's creation code links the given libraries at every link site", () => {
  const libraries = {
    RedBlackTree: "0x5366e4E83d0c1B88BB3336cA5634858558fa173F",
    XcmBuilder: "0x7172a3B4915dD3BC0479F939DCF188ba942491ee",
  };
  const { bytecode } = JSON.parse(readFileSync(new URL("../out/DLOB.sol/DLOB.json", import.meta.url), "utf8"));
  const hex = linkedBytecode("DLOB", libraries).slice(2);
  assert.doesNotMatch(hex, /__\$[0-9a-f]{34}\$__/);
  assert.equal(hex.length, bytecode.object.replace(/^0x/, "").length);
  for (const libs of Object.values(bytecode.linkReferences)) {
    for (const [lib, refs] of Object.entries(libs)) {
      for (const { start, length } of refs) {
        assert.equal(hex.slice(start * 2, (start + length) * 2), libraries[lib].slice(2).toLowerCase());
      }
    }
  }
  assert.throws(() => linkedBytecode("DLOB", { RedBlackTree: libraries.RedBlackTree }), /links XcmBuilder/);
});
