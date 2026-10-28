// @effect-diagnostics nodeBuiltinImport:off - private disposable journals only.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { JsonLog } from "./durable.ts";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof NodeFSP>()) }));

it.each(['{"t":"undo-file-do', '{"t":"complete"}', ""])(
  "resumes appending after tail %s",
  async (tail) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-torn-log-"));
    const file = NodePath.join(root, "journal.ndjson");
    NodeFS.writeFileSync(file, '{"t":"intent"}\n' + tail);
    const log = new JsonLog<{ t: string }>(file);
    try {
      await log.append({ t: "next" }, true);
      await log.close();
      expect(await log.read()).toEqual([
        { t: "intent" },
        ...(tail === '{"t":"complete"}' ? [{ t: "complete" }] : []),
        { t: "next" },
      ]);
    } finally {
      await log.close();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);

it("opens and repairs once for concurrent resumed appends", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-concurrent-log-"));
  const file = NodePath.join(root, "journal.ndjson");
  NodeFS.writeFileSync(file, '{"t":"intent"}\n{"t":');
  const log = new JsonLog<{ t: string }>(file);
  try {
    await Promise.all(Array.from({ length: 10 }, (_, n) => log.append({ t: String(n) })));
    await log.close();
    const entries = await log.read();
    expect(entries[0]).toEqual({ t: "intent" });
    expect(
      entries
        .slice(1)
        .map((entry) => entry.t)
        .sort(),
    ).toEqual(Array.from({ length: 10 }, (_, n) => String(n)));
  } finally {
    await log.close();
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("repairs a torn tail without truncating an append-only handle", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-append-access-"));
  const file = NodePath.join(root, "journal.ndjson");
  NodeFS.writeFileSync(file, '{"t":"intent"}\n{"t":');
  const open = NodeFSP.open;
  const guards: Array<{ mockRestore(): void }> = [];
  const spy = vi.spyOn(NodeFSP, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    // Model the Windows access restriction while retaining real file I/O.
    if (typeof args[1] === "string" && args[1].startsWith("a"))
      guards.push(
        vi.spyOn(handle, "truncate").mockRejectedValue(
          Object.assign(new Error("EPERM: operation not permitted, ftruncate"), {
            code: "EPERM",
          }),
        ),
      );
    return handle;
  });
  const log = new JsonLog<{ t: string }>(file);
  try {
    await log.append({ t: "next" }, true);
    await log.close();
    expect(await log.read()).toEqual([{ t: "intent" }, { t: "next" }]);
    expect(guards).toHaveLength(1);
  } finally {
    await log.close();
    guards.forEach((guard) => guard.mockRestore());
    spy.mockRestore();
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
