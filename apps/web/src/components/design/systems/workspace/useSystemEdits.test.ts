import type { DesignSystem, DesignSystemOperation } from "@specweave-studio/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/studio/design", () => ({ design: {} }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => async () => null }));

const { createEditRunner, editFailureText } = await import("./useSystemEdits");
const { TEST_SYSTEM } = await import("./testSystem");
type ApplyOutcome = import("./useSystemEdits").ApplyOutcome;
type EditNotice = import("./useSystemEdits").EditNotice;

function harness(outcomes: ApplyOutcome[] = []) {
  let system: DesignSystem = TEST_SYSTEM;
  const calls: { revision: number; operations: readonly DesignSystemOperation[] }[] = [];
  const notices: EditNotice[] = [];
  const onConflict = vi.fn();
  const runner = createEditRunner({
    apply: async (revision, operations) => {
      calls.push({ revision, operations });
      return outcomes.shift() ?? { ok: true, system: { ...system, revision: system.revision + 1 } };
    },
    current: () => system,
    onSaved: (saved) => {
      system = saved;
    },
    onConflict,
    notify: (notice) => notices.push(notice),
  });
  return { runner, calls, notices, onConflict, current: () => system };
}

describe("createEditRunner", () => {
  it("sends one edit at the revision shown, then the next at the saved revision", async () => {
    const { runner, calls } = harness();
    const first = runner.edit({ kind: "remove", name: "sig" });
    const second = runner.edit({ kind: "set-usage", name: "color-ink", text: "Body copy." });
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(calls.map((call) => call.revision)).toEqual([7, 8]);
    expect(calls[0]!.operations).toEqual([{ op: "delete_token", name: "sig" }]);
  });

  it("offers Undo with the inverse operations", async () => {
    const { runner, calls, notices } = harness();
    await runner.edit({ kind: "remove", name: "sig" });
    const saved = notices[0];
    expect(saved?.kind).toBe("saved");
    if (saved?.kind !== "saved" || saved.undo === null) throw new Error("no undo");
    saved.undo();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.operations[0]).toMatchObject({ op: "put_token", token: { name: "sig" } });
    await vi.waitFor(() => expect(notices).toHaveLength(2));
    expect(notices[1]).toMatchObject({ kind: "saved", undo: null });
    expect((notices[1] as { title: string }).title.startsWith("Undid: ")).toBe(true);
  });

  it("stops after a conflict until reset", async () => {
    const { runner, calls, onConflict } = harness([
      { ok: false, conflict: true, message: "changed" },
    ]);
    expect(await runner.edit({ kind: "remove", name: "sig" })).toBe(false);
    // Without the server's revision, the next one is the least the page must reach.
    expect(onConflict).toHaveBeenCalledExactlyOnceWith(8);
    expect(await runner.edit({ kind: "remove", name: "tide-low" })).toBe(false);
    expect(calls).toHaveLength(1);
    runner.reset();
    expect(await runner.edit({ kind: "remove", name: "tide-low" })).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("reports other failures and keeps going", async () => {
    const { runner, notices } = harness([{ ok: false, conflict: false, message: "Disk full" }]);
    expect(await runner.edit({ kind: "remove", name: "sig" })).toBe(false);
    expect(notices[0]).toEqual({
      kind: "failed",
      title: "The change was not saved",
      description: "Disk full",
    });
    expect(await runner.edit({ kind: "remove", name: "sig" })).toBe(true);
  });

  it("sends nothing for an edit that changes nothing", async () => {
    const { runner, calls } = harness();
    expect(await runner.edit({ kind: "rename", from: "sig", to: "sig" })).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("editFailureText", () => {
  const fallback = "The design system could not be saved.";

  it("keeps the server's sentence for a lock wait, not the proposal advice", () => {
    const lockWait = {
      _tag: "DesignError",
      code: "conflict",
      detail: "This design is being saved elsewhere. Try again in a moment.",
    };
    expect(editFailureText(lockWait, fallback)).toBe(
      "This design is being saved elsewhere. Try again in a moment.",
    );
    expect(editFailureText({ _tag: "DesignError", code: "conflict", detail: " " }, fallback)).toBe(
      fallback,
    );
  });

  it("says to reload on a revision conflict, never to discard a proposal", () => {
    expect(
      editFailureText(
        { _tag: "DesignError", code: "conflict", detail: "stale", currentRevision: 9 },
        fallback,
      ),
    ).toBe("This design system changed elsewhere. Reload to see the latest version.");
  });

  it("reads other failures as before", () => {
    expect(
      editFailureText({ _tag: "DesignError", code: "invalid", detail: "Bad name." }, fallback),
    ).toBe("Bad name.");
    expect(editFailureText(null, fallback)).toBe(fallback);
  });
});
