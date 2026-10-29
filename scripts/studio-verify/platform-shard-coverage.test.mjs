import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
const test = NodeTest.test;
import { partition, receipt, selectedFiles, verify } from "./platform-shard-coverage.mjs";
const assert = NodeAssert.default;
const head = "a".repeat(40),
  base = "b".repeat(40),
  root = "D:\\repo\\apps\\server";
const plan = Array.from({ length: 5 }, (_, i) => ({
  os: "windows-2025",
  suite: "server",
  changed: true,
  shard: i + 1,
  shards: 5,
}));
const fixture = (count) => {
  const full = Array.from({ length: count }, (_, i) => ({
    file: `${root}\\src\\file${i}.test.ts`,
  }));
  return plan.map((row) =>
    receipt({
      full,
      picked: full.filter((_, i) => i % 5 === row.shard - 1),
      root,
      ...row,
      head,
      base,
    }),
  );
};
for (const count of [1001, 1, 0]) {
  test(`preserves exact broad/narrow/empty selection of ${count} files`, () => {
    assert.equal(verify(plan, fixture(count), { head, base }).selectedFiles, count);
  });
}
test("rejects a missing receipt, duplicate receipt and missing planned shard", () => {
  assert.throws(() => verify(plan, fixture(10).slice(1), { head, base }), /missing/);
  const duplicate = fixture(10);
  duplicate[4] = duplicate[0];
  assert.throws(() => verify(plan, duplicate, { head, base }), /duplicate receipt/);
  assert.throws(() => verify(plan.slice(1), fixture(10), { head, base }), /five/);
});
test("rejects dropped and duplicate coverage even with internally correct hashes", () => {
  const full = Array.from({ length: 10 }, (_, i) => ({ file: `${root}\\src\\file${i}.test.ts` }));
  const dropped = fixture(10);
  dropped[0] = receipt({ full, picked: [], root, shard: 1, shards: 5, head, base });
  assert.throws(() => verify(plan, dropped, { head, base }), /union/);
  const duplicate = fixture(10);
  duplicate[1] = receipt({ full, picked: [full[0]], root, shard: 2, shards: 5, head, base });
  assert.throws(() => verify(plan, duplicate, { head, base }), /duplicate file/);
});
test("rejects changed source/base, selection or tampered digest", () => {
  for (const key of ["head", "base", "selectedSha256", "filesSha256"]) {
    const values = fixture(10);
    values[0][key] = "c".repeat(40);
    assert.throws(() => verify(plan, values, { head, base }));
  }
  const different = fixture(10);
  different[0] = fixture(9)[0];
  assert.throws(() => verify(plan, different, { head, base }), /different files/);
});
test("normalizes separators only and refuses duplicates or paths outside root", () => {
  assert.deepEqual(selectedFiles([{ file: `${root}\\src\\Case.test.ts` }], root), [
    "src/Case.test.ts",
  ]);
  assert.throws(() => selectedFiles([{ file: "D:/other/test.ts" }], root));
  assert.throws(() => selectedFiles([{ file: `${root}\\..\\other.ts` }], root));
  assert.throws(
    () => selectedFiles([{ file: `${root}\\x.ts` }, { file: `${root}/x.ts` }], root),
    /duplicate/,
  );
});
test("no changed jobs requires no receipts", () => {
  assert.deepEqual(verify([], [], { head, base }), { shards: 0, selectedFiles: 0 });
  assert.throws(() => verify([], fixture(0), { head, base }), /unexpected/);
});

test("receipt partition uses the real weighted sequencer for broad, narrow and empty files", async () => {
  for (const count of [1001, 1, 0]) {
    const full = Array.from({ length: count }, (_, i) => ({
      file: `/repo/apps/server/src/fixture${i}.test.ts`,
    }));
    const parts = await Promise.all(
      plan.map(async (row) =>
        receipt({
          full,
          picked: await partition(full, "/repo/apps/server", row.shard, 5),
          root: "/repo/apps/server",
          ...row,
          head,
          base,
        }),
      ),
    );
    assert.equal(verify(plan, parts, { head, base }).selectedFiles, count);
  }
});
