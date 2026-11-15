// @vitest-environment jsdom
import type {
  ProjectCredentialId,
  ProjectCredentialProbe,
  ProjectCredentialRow,
} from "@specweave-studio/contracts";
import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const calls = vi.hoisted(() => ({
  scan: vi.fn(),
  probe: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../../studio/projectCredentials", async (original) => ({
  ...(await original<typeof import("../../studio/projectCredentials")>()),
  projectCredentials: { scan: "scan", save: "save", probe: "probe" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "scan" | "probe" | "save") => calls[command],
}));

import { CopyCredentialsChecklist, CopyCredentialsList } from "./CopyCredentialsChecklist";

const row = (
  id: ProjectCredentialId,
  extra: Partial<ProjectCredentialRow> = {},
): ProjectCredentialRow => ({
  id,
  kind: id === "ssh" ? "file" : "login",
  sources: ["infra/main.tf"],
  listed: false,
  skip: false,
  note: null,
  keptIn: id === "ssh" ? [".ssh/id_ed25519"] : [".kube/config"],
  ...extra,
});
const probe = (
  id: ProjectCredentialId,
  status: ProjectCredentialProbe["status"],
  signIn = "az login",
  check: string | null = null,
): ProjectCredentialProbe => ({ id, status, signIn, check });

let renderer: ReactTestRenderer;
const text = () => JSON.stringify(renderer.toJSON());
const slot = (name: string) => renderer.root.findAll((node) => node.props["data-slot"] === name);
const host = (nodes: Array<ReactTestInstance>) => nodes.filter((node) => typeof node.type === "string");
const click = (node: ReactTestInstance) => act(async () => node.props.onClick());
const flush = () => act(async () => {});

afterEach(() => {
  act(() => renderer?.unmount());
  for (const call of Object.values(calls)) call.mockReset();
});

const list = (over: Partial<Parameters<typeof CopyCredentialsList>[0]> = {}) => {
  const handlers = { onSkip: vi.fn(), onUnskip: vi.fn(), onCheck: vi.fn(), onSave: vi.fn() };
  act(() => {
    renderer = create(
      <CopyCredentialsList
        rows={[row("azure"), row("kubernetes"), row("ssh")]}
        probes={
          new Map([
            ["azure", probe("azure", "not_signed_in")],
            ["kubernetes", probe("kubernetes", "ready", "az aks get-credentials")],
            ["ssh", probe("ssh", "unknown", "ssh-keygen -t ed25519", "ssh <host> true")],
          ])
        }
        state="ready"
        skipped={[]}
        sourceLabel="m4"
        targetLabel="m5"
        save="idle"
        {...handlers}
        {...over}
      />,
    );
  });
  return handlers;
};

describe("CopyCredentialsList", () => {
  it("lists what the destination lacks and folds what it has under Ready", () => {
    list();
    const needed = host(slot("copy-credential-row")).map((node) => node.props["data-credential"]);
    expect(needed).toEqual(["azure", "ssh"]);
    expect(text()).toContain("Not signed in on m5");
    expect(text()).toContain("Used in infra/main.tf");
    const ready = host(slot("copy-credentials-ready"))[0]!;
    expect(ready.type).toBe("details");
    expect(ready.props.open).toBeUndefined();
    expect(JSON.stringify(text())).toContain("Ready on m5 (1)");
  });

  it("shows the destination's command as its own text, with what stayed behind", async () => {
    list();
    expect(slot("copy-credential-command")).toHaveLength(0);
    await click(host(slot("copy-credential-sign-in"))[0]!);
    const command = host(slot("copy-credential-command"))[0]!;
    expect(command.findByType("code").children).toEqual(["az login"]);
    expect(command.findByType("p").children).toEqual(["Run this in a terminal on m5:"]);
    expect(text()).toContain("sign-ins are never copied");
    expect(text()).toContain("~/.kube/config");
  });

  it("says a key file stays on the source and offers no way to send it", async () => {
    const handlers = list();
    const ssh = host(slot("copy-credential-row"))[1]!;
    const signIn = ssh.findAll((node) => node.props["data-slot"] === "copy-credential-sign-in");
    expect(JSON.stringify(host(signIn)[0]!.props.children)).toContain("Set up there");
    await click(host(signIn)[0]!);
    expect(text()).toContain("key files are never copied");
    expect(text()).toContain("ssh <host> true");
    expect(text()).not.toMatch(/Send file|Send key/u);
    await click(host(slot("copy-credential-check"))[0]!);
    expect(handlers.onCheck).toHaveBeenCalledWith("ssh");
  });

  it("moves a skipped row out of the list, with a way back", async () => {
    const handlers = list({ skipped: ["azure"] });
    expect(host(slot("copy-credential-row")).map((node) => node.props["data-credential"])).toEqual([
      "ssh",
    ]);
    await click(host(slot("copy-credential-unskip"))[0]!);
    expect(handlers.onUnskip).toHaveBeenCalledWith("azure");
    await click(host(slot("copy-credential-skip"))[0]!);
    expect(handlers.onSkip).toHaveBeenCalledWith("ssh");
  });

  it("stays out of the way for a project that uses none, and says when all are ready", () => {
    list({ rows: [] });
    expect(renderer.toJSON()).toBeNull();
    act(() => renderer.unmount());
    list({ rows: [row("kubernetes")] });
    expect(host(slot("copy-credentials-all-ready"))).toHaveLength(1);
  });

  it("keeps rows without a command when the destination cannot be checked", () => {
    list({ probes: new Map(), state: "unavailable" });
    expect(text()).toContain("m5 could not be checked");
    expect(slot("copy-credential-sign-in")).toHaveLength(0);
  });
});

describe("CopyCredentialsChecklist", () => {
  const mount = () =>
    act(async () => {
      renderer = create(
        <CopyCredentialsChecklist
          sourceEnvironmentId={"m4" as never}
          projectId={"p1" as never}
          destinationEnvironmentId={"m5" as never}
          sourceLabel="m4"
          targetLabel="m5"
        />,
      );
    });
  const ok = <A,>(value: A) => ({ _tag: "Success" as const, value });

  it("lists on the source, checks on the destination and saves names with skips", async () => {
    calls.scan.mockResolvedValue(
      ok({
        rows: [row("azure"), row("npm", { skip: true, note: "publish" })],
        manifestProblem: null,
        truncated: false,
      }),
    );
    calls.probe.mockResolvedValue(
      ok({ results: [probe("azure", "not_signed_in"), probe("npm", "unknown", "npm login")] }),
    );
    calls.save.mockResolvedValue(ok({ path: ".specweave/project/credentials.json" }));
    await mount();
    await flush();
    expect(calls.scan).toHaveBeenCalledWith({ environmentId: "m4", input: { projectId: "p1" } });
    expect(calls.probe).toHaveBeenCalledWith({
      environmentId: "m5",
      input: { ids: ["azure", "npm"], fresh: false },
    });
    // The saved list's skip applies until the person changes it.
    expect(host(slot("copy-credential-row")).map((node) => node.props["data-credential"])).toEqual([
      "azure",
    ]);
    await click(host(slot("copy-credential-skip"))[0]!);
    await click(host(slot("copy-credentials-save"))[0]!);
    await flush();
    expect(calls.save).toHaveBeenCalledWith({
      environmentId: "m4",
      input: {
        projectId: "p1",
        credentials: [
          { id: "azure", skip: true },
          { id: "npm", skip: true, note: "publish" },
        ],
      },
    });
    expect(text()).toContain("names only");
  });

  it("shows nothing when the source cannot list, and asks again fresh on Check again", async () => {
    calls.scan.mockResolvedValue({ _tag: "Failure", cause: null });
    await mount();
    await flush();
    expect(renderer.toJSON()).toBeNull();
    expect(calls.probe).not.toHaveBeenCalled();
    act(() => renderer.unmount());

    calls.scan.mockResolvedValue(
      ok({ rows: [row("github")], manifestProblem: null, truncated: false }),
    );
    calls.probe.mockResolvedValue(ok({ results: [probe("github", "not_signed_in", "gh auth login")] }));
    await mount();
    await flush();
    await click(host(slot("copy-credentials-check-all"))[0]!);
    expect(calls.probe).toHaveBeenLastCalledWith({
      environmentId: "m5",
      input: { ids: ["github"], fresh: true },
    });
  });
});
