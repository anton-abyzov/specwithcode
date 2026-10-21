import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentId } from "@specweave-studio/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const sources = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../state/presentation", () => ({
  environmentPresentations: { presentationAtom: (id: string) => sources.get(id) },
}));

import { connectedPhaseAtom, environmentConnectedAtom } from "./connected";

type Presentation = { readonly connection: { readonly phase: string; readonly attempt: number } };
const presentation = (phase: string, attempt: number): Presentation => ({
  connection: { phase, attempt },
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Like useAtomValue: subscribe, then read.
function observe<A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<A>) {
  const unsubscribe = registry.subscribe(atom, () => {});
  registry.get(atom);
  return unsubscribe;
}

// A fleet-style reader: a request that stays in flight until it is interrupted.
function request(read: (get: Atom.AtomContext) => boolean) {
  const counts = { starts: 0, interrupts: 0 };
  const atom = Atom.make((get) => {
    if (!read(get)) return Effect.succeed(null);
    return Effect.sync(() => counts.starts++).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(() => counts.interrupts++)),
    );
  });
  return { atom, counts };
}

describe("connectedPhaseAtom", () => {
  it("keeps an in-flight request running while the connected presentation is rebuilt", async () => {
    const registry = AtomRegistry.make();
    const source = Atom.make<Presentation | null>(presentation("connected", 1));
    const connected = connectedPhaseAtom(source);
    const { atom, counts } = request((get) => get(connected));
    const unsubscribe = observe(registry, atom);

    for (let attempt = 2; attempt <= 5; attempt++) {
      registry.set(source, presentation("connected", attempt));
      await flush();
    }

    expect(counts).toEqual({ starts: 1, interrupts: 0 });
    expect(registry.get(atom).waiting).toBe(true);
    unsubscribe();
    registry.dispose();
  });

  it("restarts the request when the connection drops and returns", async () => {
    const registry = AtomRegistry.make();
    const source = Atom.make<Presentation | null>(presentation("connected", 1));
    const connected = connectedPhaseAtom(source);
    const { atom, counts } = request((get) => get(connected));
    const unsubscribe = observe(registry, atom);

    registry.set(source, presentation("reconnecting", 2));
    await flush();
    expect(counts).toEqual({ starts: 1, interrupts: 1 });

    registry.set(source, presentation("connected", 3));
    await flush();
    expect(counts).toEqual({ starts: 2, interrupts: 1 });
    unsubscribe();
    registry.dispose();
  });

  it("is the difference from reading the whole presentation, which restarts on every rebuild", async () => {
    const registry = AtomRegistry.make();
    const source = Atom.make<Presentation | null>(presentation("connected", 1));
    const { atom, counts } = request((get) => get(source)?.connection.phase === "connected");
    const unsubscribe = observe(registry, atom);

    registry.set(source, presentation("connected", 2));
    await flush();

    expect(counts).toEqual({ starts: 2, interrupts: 1 });
    unsubscribe();
    registry.dispose();
  });

  it("backs the per-environment atom the request atoms read", async () => {
    const registry = AtomRegistry.make();
    const environmentId = EnvironmentId.make("env-m4");
    const source = Atom.make<Presentation | null>(presentation("connected", 1));
    sources.set(environmentId, source);
    const { atom, counts } = request((get) => get(environmentConnectedAtom(environmentId)));
    const unsubscribe = observe(registry, atom);

    registry.set(source, presentation("connected", 2));
    await flush();
    expect(counts).toEqual({ starts: 1, interrupts: 0 });

    registry.set(source, null);
    await flush();
    expect(counts).toEqual({ starts: 1, interrupts: 1 });
    unsubscribe();
    registry.dispose();
  });
});
