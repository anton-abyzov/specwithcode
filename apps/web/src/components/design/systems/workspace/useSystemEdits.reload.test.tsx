// @vitest-environment jsdom
import type { DesignSystem, EnvironmentId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const server = vi.hoisted(() => {
  const state = {
    revision: 0,
    lockWait: false,
    calls: [] as number[],
    // One command for every render, as the app's atom command is.
    apply: async ({ input }: { input: { expectedRevision: number } }) => {
      state.calls.push(input.expectedRevision);
      if (state.lockWait)
        return {
          _tag: "Failure",
          cause: { _tag: "DesignError", code: "conflict", detail: "busy" },
        };
      if (input.expectedRevision !== state.revision)
        return {
          _tag: "Failure",
          cause: { _tag: "DesignError", code: "conflict", currentRevision: state.revision },
        };
      state.revision += 1;
      return { _tag: "Success", value: { system: { revision: state.revision } } };
    },
  };
  return state;
});

vi.mock("~/studio/design", () => ({ design: {} }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => server.apply }));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (result: { cause: unknown }) => result.cause,
}));

const { useSystemEdits } = await import("./useSystemEdits");
const { TEST_SYSTEM } = await import("./testSystem");
type SystemEdits = import("./useSystemEdits").SystemEdits;

let container: HTMLDivElement;
let root: Root;
let edits: SystemEdits;
const refresh = vi.fn();
const OWNER = { kind: "playground" } as never;

function Probe({ system }: { system: DesignSystem }) {
  edits = useSystemEdits({
    environmentId: "host" as EnvironmentId,
    owner: OWNER,
    systemId: system.id,
    system,
    onSaved: () => {},
    refresh,
  });
  return null;
}

const render = (system: DesignSystem) => act(() => root.render(<Probe system={system} />));
const at = (revision: number): DesignSystem => ({ ...TEST_SYSTEM, revision });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  server.calls = [];
  server.lockWait = false;
  refresh.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useSystemEdits reload", () => {
  it("keeps edits blocked until the reload brings a newer version", async () => {
    server.revision = 9;
    render(at(7));
    await act(async () => {
      expect(await edits.edit({ kind: "remove", name: "sig" })).toBe(false);
    });
    expect(edits.conflict).toBe(true);
    expect(server.calls).toEqual([7]);

    act(() => edits.reload());
    expect(refresh).toHaveBeenCalledOnce();
    // The refetch has not landed: the page still shows revision 7.
    render(at(7));
    expect(edits.conflict).toBe(true);
    await act(async () => {
      expect(await edits.edit({ kind: "remove", name: "sig" })).toBe(false);
    });
    expect(server.calls).toEqual([7]);

    render(at(9));
    expect(edits.conflict).toBe(false);
    await act(async () => {
      expect(await edits.edit({ kind: "remove", name: "sig" })).toBe(true);
    });
    expect(server.calls).toEqual([7, 9]);
  });

  it("does not block edits when a save only timed out on another writer's lock", async () => {
    server.revision = 7;
    server.lockWait = true;
    render(at(7));
    await act(async () => {
      expect(await edits.edit({ kind: "remove", name: "sig" })).toBe(false);
    });
    expect(edits.conflict).toBe(false);
    server.lockWait = false;
    await act(async () => {
      expect(await edits.edit({ kind: "remove", name: "sig" })).toBe(true);
    });
    expect(server.calls).toEqual([7, 7]);
  });

  it("lets edits run at once when a newer version already arrived before Reload", async () => {
    server.revision = 9;
    render(at(7));
    await act(async () => {
      await edits.edit({ kind: "remove", name: "sig" });
    });
    render(at(9));
    expect(edits.conflict).toBe(true);
    act(() => edits.reload());
    expect(edits.conflict).toBe(false);
  });
});
