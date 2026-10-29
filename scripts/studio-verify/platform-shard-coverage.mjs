import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";

const assert = NodeAssert.default;
const sha = (value) => NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identity = (value) =>
  assert.match(value, /^[a-f0-9]{40}$/, "missing or invalid source identity");

/** Normalize only root-relative separators. Case and every selected file are preserved. */
export function selectedFiles(list, root) {
  assert.ok(Array.isArray(list), "selection must be a JSON array");
  const prefix = root.replaceAll("\\", "/").replace(/\/$/, "") + "/";
  const files = list
    .map((entry) => {
      const file = (typeof entry === "string" ? entry : entry?.file)?.replaceAll("\\", "/");
      assert.ok(
        typeof file === "string" && file.startsWith(prefix),
        "selection leaves server root",
      );
      const relative = file.slice(prefix.length);
      assert.ok(
        relative && !relative.split("/").some((part) => part === ".." || part === "."),
        "invalid selected path",
      );
      return relative;
    })
    .sort();
  assert.equal(new Set(files).size, files.length, "duplicate selected file");
  return files;
}

/** Vitest list ignores --shard. Use the runner's actual sequencer on its selected files. */
export async function partition(full, root, shard, shards) {
  selectedFiles(full, root);
  const { WeightedShardSequencer } =
    await import("../../apps/server/src/testUtils/weightedShardSequencer.ts");
  const sequencer = new WeightedShardSequencer({
    config: { root, shard: { index: shard, count: shards } },
  });
  const specifications = full.map((entry) => ({
    moduleId: typeof entry === "string" ? entry : entry.file,
  }));
  return (await sequencer.shard(specifications)).map((spec) => ({ file: spec.moduleId }));
}

export function receipt({ full, picked, root, shard, shards, head, base }) {
  identity(head);
  identity(base);
  assert.ok(
    Number.isInteger(shards) &&
      shards > 0 &&
      Number.isInteger(shard) &&
      shard > 0 &&
      shard <= shards,
    "invalid shard",
  );
  const selected = selectedFiles(full, root);
  const files = selectedFiles(picked, root);
  assert.ok(
    files.every((file) => selected.includes(file)),
    "shard contains an unselected file",
  );
  return {
    schema: 1,
    head,
    base,
    shard,
    shards,
    selected,
    selectedSha256: sha(selected),
    files,
    filesSha256: sha(files),
  };
}

export function verify(plan, receipts, { head, base }) {
  identity(head);
  identity(base);
  assert.ok(Array.isArray(plan) && Array.isArray(receipts), "invalid plan or receipts");
  const expected = plan.filter(
    (row) => row.os === "windows-2025" && row.suite === "server" && row.changed === true,
  );
  if (expected.length === 0) {
    assert.equal(receipts.length, 0, "unexpected changed-server receipts");
    return { shards: 0, selectedFiles: 0 };
  }
  assert.equal(expected.length, 5, "plan must require five changed-server shards");
  assert.deepEqual(
    expected.map((row) => row.shard).sort(),
    [1, 2, 3, 4, 5],
    "missing or duplicate planned shard",
  );
  assert.ok(
    expected.every((row) => row.shards === 5),
    "inconsistent planned shard count",
  );
  assert.equal(receipts.length, expected.length, "missing or extra shard receipt");
  const seen = new Set();
  const union = [];
  let selected;
  for (const item of receipts) {
    assert.equal(item.schema, 1, "unknown receipt schema");
    assert.equal(item.head, head, "receipt source differs from plan");
    assert.equal(item.base, base, "receipt base differs from plan");
    assert.equal(item.shards, 5, "receipt shard count differs from plan");
    assert.ok(
      expected.some((row) => row.shard === item.shard) && !seen.has(item.shard),
      "unexpected or duplicate receipt shard",
    );
    seen.add(item.shard);
    assert.ok(
      Array.isArray(item.selected) && Array.isArray(item.files),
      "invalid receipt file lists",
    );
    assert.equal(item.selectedSha256, sha(item.selected), "selected-file digest differs");
    assert.equal(item.filesSha256, sha(item.files), "shard-file digest differs");
    for (const file of [...item.selected, ...item.files])
      assert.ok(
        typeof file === "string" &&
          file !== "" &&
          !file.includes("\\") &&
          !/^(?:\/|[A-Za-z]:)/.test(file) &&
          !file.split("/").some((part) => part === ".." || part === "."),
        "invalid receipt path",
      );
    assert.equal(new Set(item.selected).size, item.selected.length, "duplicate full selection");
    selected ??= item.selected;
    assert.deepEqual(item.selected, selected, "shards selected different files");
    union.push(...item.files);
  }
  assert.equal(new Set(union).size, union.length, "duplicate file across shards");
  assert.deepEqual(union.sort(), selected, "shard union dropped or added selected files");
  return { shards: seen.size, selectedFiles: selected.length, selectedSha256: sha(selected) };
}

const read = (file) => JSON.parse(NodeFS.readFileSync(file, "utf8"));
function* receiptsIn(dir) {
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    const file = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) yield* receiptsIn(file);
    else if (entry.name === "changed-server-coverage.json") yield read(file);
  }
}
if (
  process.argv[1] &&
  NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href === import.meta.url
) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "record") {
    const [fullFile, shard, head, base, out] = args;
    const full = read(fullFile);
    const [index, count] = shard.split("/").map(Number);
    const root = NodePath.resolve("apps/server");
    const picked = await partition(full, root, index, count);
    NodeFS.writeFileSync(
      NodePath.join(NodePath.dirname(out), "selected-server-shard.json"),
      JSON.stringify(picked, null, 2) + "\n",
    );
    const result = receipt({
      full,
      picked,
      root: NodePath.resolve("apps/server"),
      shard: index,
      shards: count,
      head,
      base,
    });
    NodeFS.writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  } else if (mode === "verify") {
    const [plan, logs, head, base] = args;
    console.log(
      JSON.stringify(verify(JSON.parse(plan), [...receiptsIn(logs)], { head, base }), null, 2),
    );
  } else throw new Error("expected record or verify");
}
