// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vite-plus/test";
const command = vi.hoisted(() => vi.fn());
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => command }));
vi.mock("../../studio/projectWorkspace", () => ({ projectWorkspace: { skillCopies: {} } }));
vi.mock("../settings/ProjectSkillControls", () => ({
  useSkillControls: () => ({
    environmentId: "machine-a",
    projectId: "project-a",
    cwd: "/work/project",
    threadId: "thread-a",
    userLevel: false,
    canWrite: true,
  }),
}));
vi.mock("./SkillAvailability", () => ({ SkillAvailability: () => null }));
import { SkillDetailPanel } from "./SkillDetailPanel";
import { SkillDetailMarkdown } from "./SkillDetailMarkdown";
import { SkillCopyCompare } from "./SkillCopyCompare";
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  command.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const copy = (id: string, writable = true) => ({
  id,
  path: `/skills/${id}/SKILL.md`,
  scope: "user",
  agents: [{ instanceId: id, label: id, provider: "codex" }],
  version: "1.0.0",
  hash: id.repeat(64),
  content: `# ${id}\nText`,
  writable,
  ...(!writable ? { reason: "Plugin managed" } : {}),
});
describe("skill detail controls", () => {
  it("renders Markdown semantics without HTML, executable links or remote images", async () => {
    await act(async () =>
      root.render(
        <SkillDetailMarkdown
          text={
            "# Heading\n\nUse `code`.\nNext line.\n\n[Guide](https://example.com) [unsafe](javascript:alert)\n\n<img src=x onerror=alert(1)>\n![remote](https://example.com/tracking.png)"
          }
        />,
      ),
    );
    expect(host.querySelector("h1")?.textContent).toBe("Heading");
    expect(host.querySelector("code")?.textContent).toBe("code");
    expect(host.querySelectorAll("a")).toHaveLength(1);
    expect(host.querySelector("a")?.rel).toBe("noopener noreferrer");
    expect(host.querySelector("img")).toBeNull();
    expect(host.innerHTML).not.toContain("onerror");
  });
  it("does not write before preview and disables protected destinations", async () => {
    const preview = vi.fn(),
      apply = vi.fn(),
      cancel = vi.fn();
    await act(async () =>
      root.render(
        <SkillCopyCompare
          copies={[copy("a"), copy("b", false)] as never}
          machineLabel="Laptop"
          busy={false}
          canWrite={true}
          preview={null}
          onPreview={preview}
          onApply={apply}
          onCancel={cancel}
        />,
      ),
    );
    expect(host.textContent).toContain("Plugin managed");
    expect(host.querySelector("[role=checkbox]")?.getAttribute("aria-disabled")).toBe("true");
    const choose = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Choose this copy",
    )!;
    expect(choose.disabled).toBe(true);
    expect(preview).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
  it("requires explicit confirmation and cancellation never applies", async () => {
    const apply = vi.fn(),
      cancel = vi.fn();
    await act(async () =>
      root.render(
        <SkillCopyCompare
          copies={[copy("a"), copy("b")] as never}
          machineLabel="Laptop"
          busy={false}
          canWrite={true}
          preview={{ _tag: "preview", copies: [], targetIds: ["b"] } as never}
          onPreview={() => {}}
          onApply={apply}
          onCancel={cancel}
        />,
      ),
    );
    expect(apply).not.toHaveBeenCalled();
    await act(async () =>
      [...host.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click(),
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
  });
  it("reads in the linked context and applies only the server preview hashes", async () => {
    const copies = [copy("a"), copy("b")];
    const expected = { sourceHash: copies[0]!.hash, targets: [{ id: "b", hash: copies[1]!.hash }] };
    command.mockImplementation(async ({ input }) => ({
      _tag: "Success",
      value: {
        _tag: input.operation === "apply" ? "applied" : input.operation,
        copies,
        sourceId: "a",
        targetIds: ["b"],
        expected,
      },
    }));
    await act(async () =>
      root.render(
        <SkillDetailPanel
          row={{ name: "test", description: "Test.", lock: null } as never}
          machineLabel="Laptop"
          initialView="compare"
          onChanged={() => {}}
          onEdit={() => {}}
        >
          Overview content
        </SkillDetailPanel>,
      ),
    );
    expect(command).toHaveBeenCalledWith({
      environmentId: "machine-a",
      input: {
        projectId: "project-a",
        skill: "test",
        cwd: "/work/project",
        threadId: "thread-a",
        userLevel: false,
        operation: "read",
      },
    });
    await act(async () => host.querySelector<HTMLElement>("[role=checkbox]")!.click());
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Choose this copy")!
        .click(),
    );
    expect(command.mock.calls.at(-1)?.[0].input.operation).toBe("preview");
    expect(host.textContent).toContain("/skills/b/SKILL.md");
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Confirm replacement")!
        .click(),
    );
    expect(
      command.mock.calls.find(([call]) => call.input.operation === "apply")?.[0].input,
    ).toMatchObject({
      operation: "apply",
      sourceId: "a",
      targetIds: ["b"],
      expected,
    });
  });
  it.each([false, true])(
    "refreshes partial results and hides stale content if refresh fails: %s",
    async (readFails) => {
      let applied = false;
      const copies = [copy("a"), copy("b"), copy("c")];
      const updated = copies.map((c) =>
        c.id === "b" ? { ...c, hash: copies[0]!.hash, content: copies[0]!.content } : c,
      );
      command.mockImplementation(async ({ input }) => {
        if (input.operation === "apply") {
          applied = true;
          return {
            _tag: "Success",
            value: {
              _tag: "partial",
              copies: updated,
              message: "One replacement failed.",
              receipts: [
                { id: "b", status: "applied" },
                { id: "c", status: "failed", message: "Changed on disk" },
              ],
            },
          };
        }
        if (input.operation === "read" && applied && readFails) throw Error("Read unavailable");
        return {
          _tag: "Success",
          value: {
            _tag: input.operation,
            copies: applied ? updated : copies,
            sourceId: "a",
            targetIds: ["b", "c"],
            expected: {
              sourceHash: copies[0]!.hash,
              targets: [
                { id: "b", hash: copies[1]!.hash },
                { id: "c", hash: copies[2]!.hash },
              ],
            },
          },
        };
      });
      const refresh = vi.fn();
      await act(async () =>
        root.render(
          <SkillDetailPanel
            row={{ name: "test", description: "Test.", lock: null } as never}
            machineLabel="Laptop"
            initialView="compare"
            onChanged={refresh}
            onEdit={() => {}}
          >
            Overview
          </SkillDetailPanel>,
        ),
      );
      for (const box of host.querySelectorAll<HTMLElement>("[role=checkbox]"))
        await act(async () => box.click());
      const click = async (text: string) =>
        act(async () =>
          [...host.querySelectorAll("button")].find((b) => b.textContent === text)!.click(),
        );
      await click("Choose this copy");
      await click("Confirm replacement");
      expect(command.mock.calls.at(-1)?.[0].input.operation).toBe("read");
      expect(refresh).toHaveBeenCalledOnce();
      expect(host.textContent).toContain("Replaced");
      expect(host.textContent).toContain("Replacement failed: Changed on disk");
      expect(host.textContent).not.toContain("Copies updated.");
      if (readFails) {
        expect(host.textContent).toContain("Their state is unknown");
        expect(host.querySelector('[aria-label="Copy differences"]')).toBeNull();
      } else expect(host.textContent).toContain("These copies have identical contents.");
    },
  );
  it("allows reconciliation when unchanged context exceeds the diff display limit", async () => {
    const a = { ...copy("a"), content: "same\n".repeat(1700) + "old" };
    const b = { ...copy("b"), content: "same\n".repeat(1700) + "new" };
    await act(async () =>
      root.render(
        <SkillCopyCompare
          copies={[a, b] as never}
          machineLabel="Laptop"
          busy={false}
          canWrite
          preview={null}
          onPreview={() => {}}
          onApply={() => {}}
          onCancel={() => {}}
        />,
      ),
    );
    await act(async () => host.querySelector<HTMLElement>("[role=checkbox]")!.click());
    expect(
      [...host.querySelectorAll("button")].find((b) => b.textContent === "Choose this copy")!
        .disabled,
    ).toBe(false);
  });
});
