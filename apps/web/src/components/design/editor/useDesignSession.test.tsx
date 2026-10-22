// @vitest-environment jsdom
import type { DesignDocument, DesignOperation } from "@specweave-studio/contracts";
import { applyDesignOperations, newDesignDocument } from "@specweave-studio/shared/designOps";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDesignSession, type DesignUnsavedOutcome } from "./backend";
import type { DesignSession, DesignTransport } from "./designSession";

function baseDocument(): DesignDocument {
  let seed = 3;
  return newDesignDocument({
    id: "d_hook",
    kind: "design",
    title: "Hook",
    now: "2026-10-20T00:00:00.000Z",
    createdBy: { kind: "user" },
    random: () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    },
  });
}

function fakeServer(initial: DesignDocument) {
  let head = initial;
  const calls: (readonly DesignOperation[])[] = [];
  const transport: DesignTransport = {
    apply: async (expected, operations) => {
      calls.push(operations);
      if (expected !== head.revision) return { ok: false, reason: "conflict" };
      const outcome = applyDesignOperations(head, operations);
      if (!outcome.ok) return { ok: false, reason: "error", detail: outcome.error.detail };
      head = { ...outcome.document, revision: head.revision + 1 };
      return { ok: true, document: head };
    },
    get: async () => head,
  };
  return {
    transport,
    calls,
    get head() {
      return head;
    },
    agentEdit(operations: readonly DesignOperation[]) {
      const outcome = applyDesignOperations(head, operations);
      if (!outcome.ok) throw new Error(outcome.error.detail);
      head = { ...outcome.document, revision: head.revision + 1 };
    },
  };
}

let root: Root;
let current: DesignSession | null = null;

function Probe(props: {
  sessionKey: string;
  doc: DesignDocument;
  transport: DesignTransport;
  onUnsaved?: (outcome: DesignUnsavedOutcome) => void;
}) {
  const { session } = useDesignSession(
    props.sessionKey,
    props.doc,
    props.transport,
    null,
    props.onUnsaved,
  );
  current = session;
  return null;
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  current = null;
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});

const nudge = (doc: DesignDocument, patch: Record<string, unknown>): DesignOperation[] => [
  { op: "update_node", pageId: doc.pages[0]!.id, id: doc.pages[0]!.nodes[0]!.id, patch },
];

describe("useDesignSession", () => {
  it("keeps autosave working under React.StrictMode's mount, unmount, mount", async () => {
    vi.useFakeTimers();
    const doc = baseDocument();
    const server = fakeServer(doc);
    await act(async () =>
      root.render(
        <StrictMode>
          <Probe sessionKey="env:strict" doc={doc} transport={server.transport} />
        </StrictMode>,
      ),
    );
    act(() => void current!.commit(nudge(doc, { x: 42 })));
    await act(async () => vi.advanceTimersByTimeAsync(450));
    expect(server.calls).toHaveLength(1);
    expect(server.head.pages[0]!.nodes[0]).toMatchObject({ x: 42 });
    expect(current!.getSnapshot().saveState).toBe("saved");
  });

  it("saves pending edits after the editor unmounts mid-save", async () => {
    const doc = baseDocument();
    const server = fakeServer(doc);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const transport: DesignTransport = {
      apply: async (revision, operations) => {
        if (server.calls.length === 0) await gate;
        return server.transport.apply(revision, operations);
      },
      get: server.transport.get,
    };
    await act(async () =>
      root.render(<Probe sessionKey="env:unmount" doc={doc} transport={transport} />),
    );
    const session = current!;
    act(() => void session.commit(nudge(doc, { x: 1 })));
    const saving = session.flush();
    act(() => void session.commit(nudge(doc, { y: 2 })));
    await act(async () => root.unmount());
    root = createRoot(document.createElement("div"));
    release();
    await saving;
    await vi.waitFor(() => expect(server.head.revision).toBe(2));
    expect(server.head.pages[0]!.nodes[0]).toMatchObject({ x: 1, y: 2 });
  });

  it("raises the unsaved callback on a final conflict and hands the session to the next editor", async () => {
    const doc = baseDocument();
    const server = fakeServer(doc);
    const onUnsaved = vi.fn();
    await act(async () =>
      root.render(
        <Probe
          sessionKey="env:conflict"
          doc={doc}
          transport={server.transport}
          onUnsaved={onUnsaved}
        />,
      ),
    );
    const session = current!;
    act(() => void session.commit(nudge(doc, { fill: "#ff0000" })));
    server.agentEdit(nudge(doc, { fill: "#00ff00" }));
    await act(async () => root.unmount());
    await vi.waitFor(() => expect(onUnsaved).toHaveBeenCalledTimes(1));
    expect(onUnsaved.mock.calls[0]![0]).toMatchObject({ kind: "conflict" });

    root = createRoot(document.createElement("div"));
    await act(async () =>
      root.render(<Probe sessionKey="env:conflict" doc={doc} transport={server.transport} />),
    );
    expect(current).toBe(session);
    expect(current!.getSnapshot().saveState).toBe("conflict");
    expect(current!.document.pages[0]!.nodes[0]).toMatchObject({ fill: "#ff0000" });
  });
});
