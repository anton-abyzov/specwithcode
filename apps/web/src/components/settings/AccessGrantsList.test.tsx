import type { ReactElement } from "react";
import { AccessRequestError, EnvironmentId } from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  list: Symbol("list-access-grants"),
  revoke: Symbol("revoke-access-grant"),
}));
const commands = vi.hoisted(() => ({ list: vi.fn(), revoke: vi.fn() }));
const effects = vi.hoisted(() => ({ pending: [] as Array<() => unknown> }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
    useEffect: (effect: () => unknown) => {
      effects.pending.push(effect);
    },
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: { listAccessGrants: atoms.list, revokeAccessGrant: atoms.revoke },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) => (atom === atoms.list ? commands.list : commands.revoke),
}));

import { AccessGrantsList, allowedLabel } from "./AccessGrantsList";

type Tree = ReactElement<Record<string, unknown>>;
const environmentId = EnvironmentId.make("env-m4");
const hourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
const notes = { kind: "app", key: "app:notes", label: "Notes", grantedAt: hourAgo } as const;
const finder = { kind: "app", key: "app:finder", label: "Finder", grantedAt: hourAgo } as const;
const iphone = {
  kind: "device",
  key: "device:iphone 17 pro",
  label: "iPhone 17 Pro",
  grantedAt: hourAgo,
} as const;

function render(kind: "app" | "device"): Tree {
  hooks.beginRender();
  effects.pending = [];
  return AccessGrantsList({ kind, environmentId }) as Tree;
}

async function mount(kind: "app" | "device"): Promise<Tree> {
  render(kind);
  for (const effect of effects.pending) effect();
  await flush();
  return render(kind);
}

async function flush() {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

function text(tree: Tree): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") parts.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object" && "props" in node) {
      walk((node as Tree).props.children);
    }
  };
  walk(tree);
  return parts.join(" ");
}

function button(tree: Tree, label: string): Tree {
  const found = visitElements(tree, (element) => element.props["aria-label"] === label);
  expect(found).not.toBeNull();
  return found!;
}

beforeEach(() => {
  hooks.reset();
  commands.list.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { grants: [notes, finder, iphone] },
  });
  commands.revoke.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { grants: [finder, iphone] },
  });
});

describe("AccessGrantsList", () => {
  it("lists this machine's app grants with when each was allowed", async () => {
    const tree = await mount("app");
    expect(commands.list).toHaveBeenCalledWith({ environmentId, input: {} });
    const shown = text(tree);
    expect(shown).toContain("Notes");
    expect(shown).toContain("Finder");
    expect(shown).not.toContain("iPhone 17 Pro");
    expect(shown).toContain("Allowed 2h ago");
  });

  it("removes a grant and shows the list the machine returns", async () => {
    let tree = await mount("app");
    (button(tree, "Remove Notes").props.onClick as () => void)();
    await flush();
    expect(commands.revoke).toHaveBeenCalledWith({ environmentId, input: { key: "app:notes" } });
    tree = render("app");
    expect(text(tree)).not.toContain("Notes");
    expect(text(tree)).toContain("Finder");
  });

  it("explains how to add one when nothing is allowed yet", async () => {
    commands.list.mockResolvedValue({ _tag: "Success", value: { grants: [notes] } });
    const tree = await mount("device");
    expect(text(tree)).toContain(
      "No devices allowed on this machine yet. When an agent asks to use a device, choose Always on this machine to stop it asking again.",
    );
  });

  it("shows a failed removal inline and keeps the grant", async () => {
    commands.revoke.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new AccessRequestError({ reason: "grant_failed" })),
    });
    let tree = await mount("device");
    (button(tree, "Remove iPhone 17 Pro").props.onClick as () => void)();
    await flush();
    tree = render("device");
    const alert = visitElements(tree, (element) => element.props.role === "alert");
    expect(alert?.props.children).toBe("Could not save the access.");
    expect(text(tree)).toContain("iPhone 17 Pro");
  });

  it("shows a failed load inline", async () => {
    commands.list.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new AccessRequestError({ reason: "load_failed" })),
    });
    const tree = await mount("app");
    const alert = visitElements(tree, (element) => element.props.role === "alert");
    expect(alert?.props.children).toBe("Could not load the apps allowed on this machine.");
  });

  it("says Allowed alone when the date cannot be read", () => {
    expect(allowedLabel("not a date")).toBe("Allowed");
  });
});
