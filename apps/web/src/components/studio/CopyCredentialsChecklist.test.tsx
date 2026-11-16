// @vitest-environment jsdom
import type {
  ProjectCredentialId,
  ProjectCredentialProbe,
  ProjectCredentialRow,
  ProjectSshTarget,
  ProjectCredentialTool,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
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

// "Install there" opens a terminal on the destination; here it is a button that says it ended.
vi.mock("./CopyCredentialInstall", async () => {
  const { createElement } = await import("react");
  return {
    CopyCredentialInstall: (props: {
      readonly environmentId: string;
      readonly tool: string;
      readonly command: string;
      readonly disabled: boolean;
      readonly onEnded: () => void;
    }) =>
      createElement("button", {
        "data-slot": "copy-credential-install",
        "data-environment": props.environmentId,
        "data-tool": props.tool,
        "data-command": props.command,
        disabled: props.disabled,
        onClick: props.onEnded,
      }),
    // The row's wait for an install it left running; here a mark that says what it waits for.
    CopyCredentialInstallWatch: (props: {
      readonly tool: string;
      readonly command: string | null;
      readonly paused: boolean;
      readonly onCheck: () => void;
    }) =>
      createElement("i", {
        "data-slot": "copy-credential-install-watch",
        "data-tool": props.tool,
        "data-command": props.command,
        "data-paused": props.paused,
        onClick: props.onCheck,
      }),
  };
});

import {
  checkedLabel,
  CopyCredentialsChecklist,
  CopyCredentialsList,
  fill,
  sshCheckCovers,
} from "./CopyCredentialsChecklist";

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
const toolOf = (over: Partial<ProjectCredentialTool> = {}): ProjectCredentialTool => ({
  name: "wrangler",
  state: "terminal",
  folder: null,
  install: null,
  newShell: false,
  signIn: "wrangler login",
  check: "wrangler whoami",
  appPath: null,
  ...over,
});

let renderer: ReactTestRenderer;
const text = () => JSON.stringify(renderer.toJSON());
const slot = (name: string) => renderer.root.findAll((node) => node.props["data-slot"] === name);
const host = (nodes: Array<ReactTestInstance>) =>
  nodes.filter((node) => typeof node.type === "string");
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
            ["ssh", probe("ssh", "unknown", "ssh-keygen -t ed25519")],
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

  const openSsh = async (extra: Partial<ProjectCredentialRow> = {}, targetLabel = "m5") => {
    list({ rows: [row("ssh", extra)], targetLabel });
    const signIn = host(slot("copy-credential-sign-in"))[0]!;
    expect(JSON.stringify(signIn.props.children)).toContain("Set up there");
    await click(signIn);
    return host(slot("copy-credential-command")).map((node) => node.findByType("code").children[0]);
  };
  const target = (over: Partial<ProjectSshTarget> = {}): ProjectSshTarget => ({
    kind: "server",
    user: "root",
    host: "203.0.113.10",
    variable: null,
    source: "ops/deploy.sh",
    ...over,
  });

  it("says a key stays on the source and offers no way to send it", async () => {
    const commands = await openSsh();
    expect(text()).toContain("Private keys stay on ");
    expect(text()).toContain("never copied");
    expect(text()).not.toMatch(/Send file|Send key|Not copied:/u);
    // A project whose places are not known gets no command with a placeholder in it.
    expect(commands).toEqual(["ssh-keygen -t ed25519", "cat ~/.ssh/id_ed25519.pub"]);
    expect(text()).not.toContain("<host>");
    expect(text()).toContain("~/.ssh/authorized_keys");
    expect(slot("copy-ssh-targets")).toHaveLength(0);
  });

  it("names each place the project connects to, with a check that runs as written", async () => {
    const commands = await openSsh(
      {
        sshTargets: [
          target({ variable: "WORKER_IP" }),
          target({ kind: "git", user: "git", host: "github.com", source: "." }),
          target({ kind: "variable", user: "deploy", host: null, variable: "TARGET_HOST" }),
          target({ host: "10.0.0.5" }),
        ],
      },
      'Anton\'s "M5" $(id)',
    );
    expect(commands).toEqual([
      "ssh-keygen -t ed25519",
      "cat ~/.ssh/id_ed25519.pub",
      "ssh -o BatchMode=yes -- root@203.0.113.10 true",
      // The machine's name goes in as a title with nothing a shell reads left in it.
      'gh ssh-key add ~/.ssh/id_ed25519.pub --title "Antons M5 id"',
      "ssh -o BatchMode=yes -T -- git@github.com",
      "ssh -o BatchMode=yes -- root@10.0.0.5 true",
    ]);
    expect(text()).not.toContain("<host>");
    expect(text()).not.toMatch(/\{\w+\}/u);
    expect(text()).toContain("the project's own repository");
    expect(text()).toContain("WORKER_IP in ops/deploy.sh");
    expect(text()).toContain("TARGET_HOST");
    expect(host(slot("copy-ssh-key-page"))[0]!.props.href).toBe(
      "https://github.com/settings/ssh/new",
    );
    expect(host(slot("copy-ssh-private"))).toHaveLength(1);
    expect(host(slot("copy-ssh-unverified"))).toHaveLength(1);
    expect(host(slot("copy-ssh-more"))).toHaveLength(0);
  });

  it("leaves out a place that could bend a command, and says the list is short", async () => {
    const commands = await openSsh({
      sshTargets: [
        target({ host: "-oProxyCommand=evil" }),
        target({ host: "a;rm -rf ~" }),
        target({ user: "$(id)" }),
        target({ source: "ops/\u202Edeploy.sh" }),
        target({ kind: "variable", host: null, variable: "A;B" }),
        target({ host: "ok.example.com" }),
      ],
    });
    expect(commands).toEqual([
      "ssh-keygen -t ed25519",
      "cat ~/.ssh/id_ed25519.pub",
      "ssh -o BatchMode=yes -- root@ok.example.com true",
    ]);
    expect(host(slot("copy-ssh-target"))).toHaveLength(1);
    expect(host(slot("copy-ssh-more"))).toHaveLength(1);
  });

  it("wraps a long command instead of clipping it", async () => {
    await openSsh();
    const code = host(slot("copy-credential-command"))[0]!.findByType("code");
    expect(code.props.className).toContain("whitespace-pre-wrap");
    expect(code.props.className).not.toContain("whitespace-nowrap");
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

  const one = (
    id: ProjectCredentialId,
    answer: Partial<ProjectCredentialProbe>,
    over: Partial<Parameters<typeof CopyCredentialsList>[0]> = {},
    extra: Partial<ProjectCredentialRow> = {},
  ) =>
    list({
      rows: [row(id, extra)],
      probes: new Map([
        [id, { ...probe(id, "unknown", "wrangler login", "wrangler whoami"), ...answer }],
      ]),
      destinationEnvironmentId: "m5" as never,
      ...over,
    });
  const status = () => host(slot("copy-credential-status"))[0]!.children[0];
  const open = () => click(host(slot("copy-credential-sign-in"))[0]!);
  const commands = () =>
    host(slot("copy-credential-command")).map((node) => [
      node.findByType("p").children[0],
      node.findByType("code").children[0],
    ]);

  it("leaves a row whose tool is there as it was: the two commands and nothing before them", async () => {
    one("cloudflare", { status: "not_signed_in", ran: "tool", tool: toolOf() });
    expect(status()).toBe("Not signed in on m5");
    await open();
    expect(commands()).toEqual([
      ["Run this in a terminal on m5:", "wrangler login"],
      ["Then see that it worked:", "wrangler whoami"],
    ]);
    expect(slot("copy-credential-install-step")).toHaveLength(0);
    expect(slot("copy-credential-install")).toHaveLength(0);
    expect(slot("copy-credential-tool-note")).toHaveLength(0);
  });

  it("puts the install before the sign-in for a tool that is missing, with Install there", async () => {
    const install = "curl https://sdk.cloud.google.com | bash";
    const handlers = one("google-cloud", {
      status: "tool_missing",
      ran: "none",
      tool: toolOf({
        name: "gcloud",
        state: "missing",
        install,
        newShell: true,
        signIn: "gcloud auth login --no-launch-browser",
        check: "gcloud auth list",
      }),
    });
    expect(status()).toBe("gcloud is not installed on m5");
    expect(text()).not.toContain("Its tool was not found");
    await open();
    expect(commands()).toEqual([
      ["First install gcloud on m5:", install],
      ["Then sign in, in a terminal on m5:", "gcloud auth login --no-launch-browser"],
      ["Then see that it worked:", "gcloud auth list"],
    ]);
    expect(text()).toContain("Then open a new Terminal window");
    const button = host(slot("copy-credential-install"))[0]!;
    expect(button.props["data-command"]).toBe(install);
    expect(button.props["data-environment"]).toBe("m5");
    // When the install ends, the row is checked again.
    await click(button);
    expect(handlers.onCheck).toHaveBeenCalledWith("google-cloud");
  });

  it("shows the install command without the button where no machine is named to run it on", async () => {
    one(
      "cloudflare",
      {
        status: "tool_missing",
        tool: toolOf({ state: "missing", install: "npm install --global wrangler" }),
      },
      { destinationEnvironmentId: undefined },
    );
    await open();
    expect(commands()[0]).toEqual([
      "First install wrangler on m5:",
      "npm install --global wrangler",
    ]);
    expect(slot("copy-credential-install")).toHaveLength(0);
  });

  it("installs a tool the project lists through the project, then signs in from its folder", async () => {
    const folder = "/Users/you/Projects/site/platform";
    one(
      "cloudflare",
      {
        status: "tool_missing",
        ran: "none",
        tool: toolOf({
          state: "missing",
          folder,
          install: `cd ${folder} && npm install`,
          signIn: `cd ${folder} && npx wrangler login`,
          check: `cd ${folder} && npx wrangler whoami`,
        }),
      },
      {},
      { packages: ["platform"] },
    );
    expect(status()).toBe("wrangler is not installed on m5");
    await open();
    expect(commands()).toEqual([
      [
        "wrangler is this project's own tool. First install the project's packages on m5:",
        `cd ${folder} && npm install`,
      ],
      ["Then sign in, in a terminal on m5:", `cd ${folder} && npx wrangler login`],
      ["Then see that it worked:", `cd ${folder} && npx wrangler whoami`],
    ]);
    expect(text()).not.toContain("install --global");
    expect(host(slot("copy-credential-install"))[0]!.props["data-command"]).toBe(
      `cd ${folder} && npm install`,
    );
  });

  it("offers nothing global before the copy for a tool the project brings", async () => {
    one(
      "cloudflare",
      {
        status: "tool_missing",
        ran: "none",
        tool: toolOf({ state: "missing", install: "npm install --global wrangler" }),
      },
      {},
      { packages: ["repositories/acme/platform"] },
    );
    expect(status()).toBe("wrangler comes with this project. Set it up on m5 after the copy.");
    await open();
    expect(commands()).toEqual([]);
    expect(slot("copy-credential-install")).toHaveLength(0);
    expect(text()).toContain("repositories/acme/platform");
    expect(text()).not.toContain("install --global");
  });

  it("names the project's top folder in words, not as a dot", async () => {
    one(
      "cloudflare",
      { status: "tool_missing", ran: "none", tool: toolOf({ state: "missing" }) },
      {},
      { packages: ["."] },
    );
    await open();
    const note = String(host(slot("copy-credential-tool-note"))[0]!.children[0]);
    expect(note).toContain("This project brings its own wrangler (in its top folder)");
    expect(note).not.toContain("(in .)");
  });

  it("gives the plain install after the copy, when the copy has no folder that brings the tool", async () => {
    one(
      "cloudflare",
      {
        status: "tool_missing",
        ran: "none",
        tool: toolOf({ state: "missing", install: "npm install --global wrangler" }),
      },
      { copied: true },
      { packages: ["repositories/acme/platform"] },
    );
    // Nothing is left to wait for: the row must offer a way forward.
    expect(status()).toBe("wrangler is not installed on m5");
    await open();
    expect(commands()).toEqual([
      ["First install wrangler on m5:", "npm install --global wrangler"],
      ["Then sign in, in a terminal on m5:", "wrangler login"],
      ["Then see that it worked:", "wrangler whoami"],
    ]);
    expect(host(slot("copy-credential-install"))).toHaveLength(1);
  });

  it("says Node.js is what is missing when no install command could run", async () => {
    const folder = "/Users/you/Projects/site/platform";
    one("cloudflare", {
      status: "tool_missing",
      ran: "none",
      tool: toolOf({
        state: "missing",
        folder,
        signIn: `cd ${folder} && npx wrangler login`,
        needsNode: true,
      }),
    });
    await open();
    expect(String(host(slot("copy-credential-tool-note"))[0]!.children[0])).toBe(
      "wrangler is this project's own tool, and installing the project's packages needs Node.js, which was not found on m5. Install Node.js there first (Machine basics offers it), then check again.",
    );
    expect(slot("copy-credential-install")).toHaveLength(0);
    act(() => renderer.unmount());
    one("cloudflare", {
      status: "tool_missing",
      ran: "none",
      tool: toolOf({ state: "missing", needsNode: true }),
    });
    await open();
    expect(String(host(slot("copy-credential-tool-note"))[0]!.children[0])).toBe(
      "wrangler installs through npm, which comes with Node.js, and that was not found on m5. Install Node.js there first (Machine basics offers it), then check again.",
    );
  });

  it("does not send a tool that npm never installs to Node.js", async () => {
    // Docker has no install the app knows; an older destination says nothing about Node.js either.
    one("docker", {
      status: "tool_missing",
      signIn: "docker login",
      check: null,
      ran: "none",
      tool: toolOf({ name: "docker", state: "missing", signIn: "docker login", check: null }),
    });
    await open();
    const note = String(host(slot("copy-credential-tool-note"))[0]!.children[0]);
    expect(note).toBe("Install docker on m5 yourself, then check again.");
    expect(note).not.toContain("Node.js");
    expect(slot("copy-credential-install")).toHaveLength(0);
  });

  it("waits for an install left running with the row closed, and checks only that row", async () => {
    const handlers = one("cloudflare", {
      status: "tool_missing",
      ran: "none",
      tool: toolOf({ state: "missing", install: "npm install --global wrangler" }),
    });
    // The steps are closed: no Install there button, and the wait is mounted all the same.
    expect(slot("copy-credential-install")).toHaveLength(0);
    const watch = () => host(slot("copy-credential-install-watch"))[0]!;
    expect(watch().props["data-command"]).toBe("npm install --global wrangler");
    expect(watch().props["data-paused"]).toBe(false);
    await click(watch());
    expect(handlers.onCheck).toHaveBeenCalledWith("cloudflare");
    act(() => renderer.unmount());
    // A tool that is there offers no install: the wait is told so, and lets go of what it kept.
    one("cloudflare", { status: "not_signed_in", ran: "tool", tool: toolOf() });
    expect(watch().props["data-command"]).toBeNull();
    act(() => renderer.unmount());
    // The same when the answer makes the row ready and it leaves the list: the wait stays to hear it.
    one("cloudflare", { status: "ready", ran: "tool", tool: toolOf() });
    expect(host(slot("copy-credential-row"))).toHaveLength(0);
    expect(watch().props["data-command"]).toBeNull();
    act(() => renderer.unmount());
    // A skipped row keeps what it left running, and asks nothing meanwhile.
    one(
      "cloudflare",
      {
        status: "tool_missing",
        ran: "none",
        tool: toolOf({ state: "missing", install: "npm install --global wrangler" }),
      },
      { skipped: ["cloudflare"] },
    );
    expect(watch().props["data-command"]).toBe("npm install --global wrangler");
    expect(watch().props["data-paused"]).toBe(true);
  });

  it("says a sign-in file is already there when only the tool is missing", () => {
    one("cloudflare", {
      status: "tool_missing",
      ran: "none",
      signInFile: true,
      tool: toolOf({ state: "missing", install: "npm install --global wrangler" }),
    });
    expect(status()).toBe(
      "wrangler is not installed on m5. A sign-in file is already there, so installing it may be all that is left.",
    );
  });

  it("puts a machine's name into a sentence as it is, whatever is in it", () => {
    expect(
      fill("Ready on {targetLabel} ({count})", { targetLabel: "$& {count} $1", count: "2" }),
    ).toBe("Ready on $& {count} $1 (2)");
    expect(fill("{tool} and {tool}, {unknown}", { tool: "gh" })).toBe("gh and gh, {unknown}");
    one(
      "cloudflare",
      { status: "not_signed_in", ran: "tool", tool: toolOf() },
      { targetLabel: "$& {tool}" },
    );
    expect(status()).toBe("Not signed in on $& {tool}");
  });

  it("says which Git host has no key for an SSH row whose check was refused", () => {
    list({
      rows: [row("ssh", { sshHosts: ["github.com"] })],
      probes: new Map([["ssh", { ...probe("ssh", "not_signed_in", "ssh-keygen"), ran: "tool" }]]),
    });
    expect(host(slot("copy-credential-status"))[0]!.children[0]).toBe(
      "A Git host this project uses does not accept a key from m5 yet",
    );
  });

  it("keeps the SSH row and its steps when the check covered only some places it connects to", () => {
    const git = target({ kind: "git", user: "git", host: "github.com", source: "." });
    const ready = { ...probe("ssh", "ready", "ssh-keygen -t ed25519"), ran: "tool" as const };
    const show = (extra: Partial<ProjectCredentialRow>) => {
      list({
        rows: [row("ssh", { sshHosts: ["github.com"], ...extra })],
        probes: new Map([["ssh", ready]]),
      });
      const rows = host(slot("copy-credential-row")).length;
      const said = rows === 0 ? null : host(slot("copy-credential-status"))[0]!.children[0];
      act(() => renderer.unmount());
      return { rows, said };
    };
    const partly =
      "Its Git hosts accept a key from m5. The other places it connects to were not checked.";
    // A server a script reaches was never asked: the row stays, with its steps a click away.
    expect(show({ sshTargets: [git, target({ host: "10.0.0.5" })] })).toEqual({
      rows: 1,
      said: partly,
    });
    // More places than the list names, and a Git host outside the known ones: the same.
    expect(show({ sshTargets: [git], sshTargetsMore: true })).toEqual({ rows: 1, said: partly });
    expect(show({ sshTargets: [target({ kind: "git", host: "git.example.com" })] }).rows).toBe(1);
    // Every place is a Git host that was checked: ready, and out of the list.
    expect(show({ sshTargets: [git] })).toEqual({ rows: 0, said: null });
    expect(show({})).toEqual({ rows: 0, said: null });

    expect(sshCheckCovers(row("ssh", { sshHosts: ["github.com"], sshTargets: [git] }))).toBe(true);
    expect(sshCheckCovers(row("ssh", { sshTargets: [git] }))).toBe(false);
    expect(
      sshCheckCovers(
        row("ssh", {
          sshHosts: ["github.com"],
          sshTargets: [target({ kind: "variable", host: null, variable: "TARGET_HOST" })],
        }),
      ),
    ).toBe(false);
  });

  it("says npm's ready is for its default registry when the project has an .npmrc", () => {
    const ready = new Map([
      [
        "npm" as const,
        { ...probe("npm", "ready", "npm login", "npm whoami"), ran: "tool" as const },
      ],
    ]);
    list({ rows: [row("npm", { registryFile: true })], probes: ready });
    expect(String(host(slot("copy-credentials-registry-note"))[0]!.children[0])).toBe(
      "npm is signed in to its default registry on m5. This project has an .npmrc, which may name another one: if it does, sign in to that registry there too.",
    );
    act(() => renderer.unmount());
    // No .npmrc in the project, or npm not ready: nothing more to say.
    list({ rows: [row("npm")], probes: ready });
    expect(slot("copy-credentials-registry-note")).toHaveLength(0);
    act(() => renderer.unmount());
    list({
      rows: [row("npm", { registryFile: true })],
      probes: new Map([["npm", probe("npm", "not_signed_in", "npm login")]]),
    });
    expect(slot("copy-credentials-registry-note")).toHaveLength(0);
  });

  it("says a project's own tool waits for Check again, and runs its commands in the folder", async () => {
    const folder = "/Users/you/Projects/site/platform";
    const handlers = one("cloudflare", {
      status: "unknown",
      ran: "waiting",
      tool: toolOf({
        state: "project",
        folder,
        signIn: `cd ${folder} && npx wrangler login`,
        check: `cd ${folder} && npx wrangler whoami`,
      }),
    });
    expect(status()).toBe("Uses this project's own wrangler. Check again runs it on m5.");
    await open();
    expect(host(slot("copy-credential-tool-note"))[0]!.children[0]).toBe(
      "wrangler is this project's own tool, so these commands run in the project's folder.",
    );
    expect(commands()).toEqual([
      ["Run this in a terminal on m5:", `cd ${folder} && npx wrangler login`],
      ["Then see that it worked:", `cd ${folder} && npx wrangler whoami`],
    ]);
    expect(slot("copy-credential-install-step")).toHaveLength(0);
    await click(host(slot("copy-credential-check"))[0]!);
    expect(handlers.onCheck).toHaveBeenCalledWith("cloudflare");
  });

  it("says where npm comes from, with commands that reach it when Terminal would not find it", async () => {
    const npm = "/Users/you/.specwithcode/commands/npm";
    const reach = 'export PATH=/Users/you/.specwithcode/commands:"$PATH" && ';
    one("npm", {
      status: "not_signed_in",
      signIn: "npm login",
      check: "npm whoami",
      ran: "tool",
      tool: toolOf({
        name: "npm",
        state: "app",
        appPath: npm,
        signIn: `${reach}npm login`,
        check: `${reach}npm whoami`,
      }),
    });
    expect(status()).toBe("Not signed in on m5");
    await open();
    const note = String(host(slot("copy-credential-tool-note"))[0]!.children[0]);
    expect(note).toContain("npm comes with the Node.js that SpecWithCode installs");
    expect(note).toContain("Use these commands in Terminal");
    expect(note).toContain("Settings > General");
    expect(note).toContain("add its folder to PATH first");
    expect(commands()).toEqual([
      ["Run this in a terminal on m5:", `${reach}npm login`],
      ["Then see that it worked:", `${reach}npm whoami`],
    ]);
    expect(slot("copy-credential-install-step")).toHaveLength(0);
  });

  it("sends a machine with no npm to Node.js, with no command that could not run", async () => {
    one("npm", {
      status: "tool_missing",
      signIn: "npm login",
      check: "npm whoami",
      ran: "none",
      tool: toolOf({ name: "npm", state: "missing", signIn: "npm login", check: "npm whoami" }),
    });
    expect(status()).toBe("npm is not installed on m5");
    await open();
    expect(String(host(slot("copy-credential-tool-note"))[0]!.children[0])).toContain(
      "npm comes with Node.js, which was not found on m5",
    );
    expect(slot("copy-credential-install")).toHaveLength(0);
  });

  it("never calls a sign-in file ready: it says the file is there and was not verified", () => {
    one("cloudflare", { status: "unknown", ran: "tool", signInFile: true, tool: toolOf() });
    expect(status()).toBe("A sign-in file is on m5, but it could not be verified");
    expect(host(slot("copy-credential-row"))).toHaveLength(1);
    expect(slot("copy-credentials-ready")).toHaveLength(0);
  });

  it("keeps an older destination's answer as it was", async () => {
    one("hetzner-cloud", {
      status: "tool_missing",
      signIn: "hcloud context create <name>",
      check: null,
    });
    expect(status()).toBe("Its tool was not found on m5");
    await open();
    expect(text()).toContain("Install its command-line tool on m5 if it is missing");
    expect(commands()).toEqual([["Run this in a terminal on m5:", "hcloud context create <name>"]]);
  });

  it("shows a spinner on the rows being checked and how old each answer is", () => {
    list({
      checking: new Set<ProjectCredentialId>(["azure"]),
      checkedAt: new Map<ProjectCredentialId, number>([
        ["azure", 1_000_000],
        ["ssh", 1_000_000],
      ]),
      now: 1_000_000 + 5 * 60_000,
    });
    const rows = host(slot("copy-credential-row"));
    const within = (index: number, name: string) =>
      rows[index]!.findAll(
        (node) => node.props["data-slot"] === name && typeof node.type === "string",
      );
    expect(within(0, "copy-credential-checking")).toHaveLength(1);
    expect(within(0, "copy-credential-checked")).toHaveLength(0);
    expect(within(1, "copy-credential-checking")).toHaveLength(0);
    expect(within(1, "copy-credential-checked")[0]!.children).toEqual(["Checked 5 minutes ago"]);
  });

  it("counts a checked time up from just now", () => {
    const tx = ((phrase: string) => phrase) as never;
    const at = (minutes: number) => checkedLabel(tx, 0, minutes * 60_000);
    expect(at(0)).toBe("Checked just now");
    expect(at(0.9)).toBe("Checked just now");
    expect(at(1)).toBe("Checked 1 minute ago");
    expect(at(59)).toBe("Checked 59 minutes ago");
    expect(at(60)).toBe("Checked 1 hour ago");
    expect(at(150)).toBe("Checked 2 hours ago");
    // A clock that went back does not count down from the future.
    expect(checkedLabel(tx, 60_000, 0)).toBe("Checked just now");
  });

  it("keeps rows without a command when the destination cannot be checked", () => {
    list({ probes: new Map(), state: "unavailable" });
    expect(text()).toContain("m5 could not be checked");
    expect(slot("copy-credential-sign-in")).toHaveLength(0);
    expect(slot("copy-credentials-stale")).toHaveLength(0);
  });

  it("asks for an update only of a machine that cannot answer, not of one still checking or busy", () => {
    const first = () => host(slot("copy-credential-status"))[0]!.children[0];
    list({ probes: new Map(), state: "checking" });
    expect(first()).toBe("Checking m5…");
    act(() => renderer.unmount());
    // The first frame, before the opening check is out, and a row being checked by itself.
    list({ probes: new Map(), state: "ready", checking: new Set<ProjectCredentialId>(["azure"]) });
    expect(first()).toBe("Checking m5…");
    expect(text()).not.toContain("Update SpecWithCode");
    act(() => renderer.unmount());
    list({ probes: new Map(), state: "busy" });
    expect(first()).toBe("Not checked on m5 yet");
    expect(text()).not.toContain("Update SpecWithCode");
    act(() => renderer.unmount());
    // A machine that has the check and could not run it this time needs no update.
    list({ probes: new Map(), state: "failed" });
    expect(first()).toBe("m5 could not be checked. Try Check again.");
    expect(text()).not.toContain("Update SpecWithCode");
    act(() => renderer.unmount());
    list({ probes: new Map(), state: "unavailable" });
    expect(first()).toBe("m5 could not be checked. Update SpecWithCode there to see it.");
  });

  it("says the rows are the earlier answers when a later check got none", () => {
    list({ state: "unavailable" });
    expect(host(slot("copy-credentials-stale"))[0]!.children[0]).toBe(
      "m5 did not answer the last check. The rows show what it said before.",
    );
    expect(host(slot("copy-credential-row"))).toHaveLength(2);
    expect(text()).not.toContain("Update SpecWithCode");
  });
});

describe("CopyCredentialsChecklist", () => {
  // Skips are remembered per project, so the tests that click Skip use a project of their own.
  const mount = (destinationProjectId?: string, projectId = "p1") =>
    act(async () => {
      renderer = create(
        <CopyCredentialsChecklist
          sourceEnvironmentId={"m4" as never}
          projectId={projectId as never}
          destinationEnvironmentId={"m5" as never}
          destinationProjectId={destinationProjectId as never}
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
    calls.probe.mockResolvedValue(
      ok({ results: [probe("github", "not_signed_in", "gh auth login")] }),
    );
    await mount();
    await flush();
    await click(host(slot("copy-credentials-check-all"))[0]!);
    expect(calls.probe).toHaveBeenLastCalledWith({
      environmentId: "m5",
      input: { ids: ["github"], fresh: true, projectTools: true },
    });
  });

  const scanned = () =>
    calls.scan.mockResolvedValue(
      ok({
        rows: [
          row("cloudflare", { packages: ["platform"] }),
          row("npm"),
          row("ssh", { sshHosts: ["github.com"] }),
        ],
        manifestProblem: null,
        truncated: false,
      }),
    );
  const answers = (status: ProjectCredentialProbe["status"]) =>
    ok({
      results: [
        { ...probe("cloudflare", status, "wrangler login", "wrangler whoami"), tool: toolOf() },
        probe("npm", status, "npm login", "npm whoami"),
        probe("ssh", status, "ssh-keygen -t ed25519", "ssh <host> true"),
      ],
    });
  const later = () => {
    let answer!: (value: unknown) => void;
    calls.probe.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    return (value: unknown) => act(async () => answer(value));
  };

  it("runs the checks again on the destination at a second click, and a row signed in since turns ready", async () => {
    scanned();
    calls.probe.mockResolvedValueOnce(answers("not_signed_in"));
    await mount("p9", "p2");
    await flush();
    // What the source found goes along: the folder that brings wrangler and the Git host.
    expect(calls.probe).toHaveBeenCalledTimes(1);
    expect(calls.probe).toHaveBeenLastCalledWith({
      environmentId: "m5",
      input: {
        ids: ["cloudflare", "npm", "ssh"],
        fresh: false,
        projectId: "p9",
        packages: [{ id: "cloudflare", folders: ["platform"] }],
        sshHosts: ["github.com"],
      },
    });
    expect(host(slot("copy-credential-row"))).toHaveLength(3);
    expect(host(slot("copy-credential-checked")).map((node) => node.children[0])).toEqual([
      "Checked just now",
      "Checked just now",
      "Checked just now",
    ]);

    // The person signs in in Terminal, then clicks Check again.
    const answer = later();
    await click(host(slot("copy-credentials-check-all"))[0]!);
    expect(calls.probe).toHaveBeenCalledTimes(2);
    expect(calls.probe).toHaveBeenLastCalledWith({
      environmentId: "m5",
      input: {
        ids: ["cloudflare", "npm", "ssh"],
        fresh: true,
        projectId: "p9",
        packages: [{ id: "cloudflare", folders: ["platform"] }],
        sshHosts: ["github.com"],
        projectTools: true,
      },
    });
    // While the destination runs them, every row says so.
    expect(host(slot("copy-credential-checking"))).toHaveLength(3);
    expect(host(slot("copy-credential-checked"))).toHaveLength(0);
    const all = host(slot("copy-credentials-check-all"))[0]!;
    expect(all.props.disabled).toBe(true);
    expect(all.children).toEqual(["Checking…"]);

    await answer(answers("ready"));
    expect(host(slot("copy-credential-checking"))).toHaveLength(0);
    expect(host(slot("copy-credential-row"))).toHaveLength(0);
    expect(host(slot("copy-credentials-all-ready"))).toHaveLength(1);
    expect(text()).toContain("Ready on m5 (3)");
    // Every check was asked of the destination, and the source was read once.
    for (const [asked] of calls.probe.mock.calls) expect(asked.environmentId).toBe("m5");
    expect(calls.scan).toHaveBeenCalledTimes(1);
  });

  it("checks one row from its own button, and only that row spins", async () => {
    scanned();
    calls.probe.mockResolvedValueOnce(answers("not_signed_in"));
    await mount(undefined, "p2");
    await flush();
    const npm = () =>
      host(slot("copy-credential-row")).find((node) => node.props["data-credential"] === "npm")!;
    const inRow = (name: string) =>
      npm().findAll((node) => node.props["data-slot"] === name && typeof node.type === "string");
    await click(inRow("copy-credential-sign-in")[0]!);
    const answer = later();
    await click(inRow("copy-credential-check")[0]!);
    // No copy of the project on that machine yet, so no project id; npm has no folders or hosts to send.
    expect(calls.probe).toHaveBeenLastCalledWith({
      environmentId: "m5",
      input: { ids: ["npm"], fresh: true, projectTools: true },
    });
    expect(host(slot("copy-credential-checking"))).toHaveLength(1);
    expect(inRow("copy-credential-checking")).toHaveLength(1);
    expect(inRow("copy-credential-check")[0]!.props.disabled).toBe(true);
    await answer(ok({ results: [probe("npm", "ready", "npm login", "npm whoami")] }));
    expect(host(slot("copy-credential-row")).map((node) => node.props["data-credential"])).toEqual([
      "cloudflare",
      "ssh",
    ]);
    expect(text()).toContain("Ready on m5 (1)");
  });

  it("holds a row's own check while the header's check is still out", async () => {
    scanned();
    calls.probe.mockResolvedValueOnce(answers("not_signed_in"));
    await mount(undefined, "p2");
    await flush();
    const first = later();
    await click(host(slot("copy-credentials-check-all"))[0]!);
    const npmRow = host(slot("copy-credential-row")).find(
      (node) => node.props["data-credential"] === "npm",
    )!;
    await click(
      npmRow.findAll((node) => node.props["data-slot"] === "copy-credential-sign-in")[0]!,
    );
    // The header's check is still out; a row's own button is disabled until it answers.
    expect(
      host(npmRow.findAll((node) => node.props["data-slot"] === "copy-credential-check"))[0]!.props
        .disabled,
    ).toBe(true);
    await first(answers("ready"));
    expect(text()).toContain("Ready on m5 (3)");
  });

  it("keeps the newest answer when an older check comes back late", async () => {
    scanned();
    const first = later();
    await mount(undefined, "p2");
    await flush();
    // The copy finishes while the opening check is out: the list asks again, now with the copy.
    calls.probe.mockResolvedValueOnce(answers("ready"));
    await act(async () => {
      renderer.update(
        <CopyCredentialsChecklist
          sourceEnvironmentId={"m4" as never}
          projectId={"p2" as never}
          destinationEnvironmentId={"m5" as never}
          destinationProjectId={"p9" as never}
          sourceLabel="m4"
          targetLabel="m5"
        />,
      );
    });
    await flush();
    expect(calls.probe).toHaveBeenCalledTimes(2);
    expect(text()).toContain("Ready on m5 (3)");
    // The older check answers last, with what was true before: it changes nothing.
    await first(answers("not_signed_in"));
    expect(text()).toContain("Ready on m5 (3)");
    expect(host(slot("copy-credential-row"))).toHaveLength(0);
    expect(host(slot("copy-credential-checking"))).toHaveLength(0);
  });

  it("shows a kept answer as old as the destination says, not as checked just now", async () => {
    scanned();
    const kept = answers("not_signed_in");
    calls.probe.mockResolvedValueOnce(
      ok({
        results: kept.value.results.map((entry) =>
          entry.id === "npm" ? { ...entry, checkedMsAgo: 2 * 60_000 + 500 } : entry,
        ),
      }),
    );
    await mount(undefined, "p2");
    await flush();
    const checked = (id: string) =>
      host(slot("copy-credential-row"))
        .find((node) => node.props["data-credential"] === id)!
        .findAll(
          (node) =>
            node.props["data-slot"] === "copy-credential-checked" && typeof node.type === "string",
        )[0]!.children[0];
    expect(checked("npm")).toBe("Checked 2 minutes ago");
    expect(checked("cloudflare")).toBe("Checked just now");
  });

  it("stops waiting for the copy once the destination has its own copy of the project", async () => {
    calls.scan.mockResolvedValue(
      ok({
        rows: [row("cloudflare", { packages: ["platform"] })],
        manifestProblem: null,
        truncated: false,
      }),
    );
    const missing = ok({
      results: [
        {
          ...probe("cloudflare", "tool_missing", "wrangler login", "wrangler whoami"),
          ran: "none" as const,
          tool: toolOf({ state: "missing", install: "npm install --global wrangler" }),
        },
      ],
    });
    calls.probe.mockResolvedValue(missing);
    await mount(undefined, "p3");
    await flush();
    const status = () => host(slot("copy-credential-status"))[0]!.children[0];
    expect(status()).toBe("wrangler comes with this project. Set it up on m5 after the copy.");
    act(() => renderer.unmount());
    // On the Done screen the copy is there, and it has no folder that brings wrangler.
    await mount("p9", "p3");
    await flush();
    expect(status()).toBe("wrangler is not installed on m5");
  });

  it("says the rows are the earlier answers when a re-check fails", async () => {
    scanned();
    calls.probe.mockResolvedValueOnce(answers("not_signed_in"));
    await mount(undefined, "p2");
    await flush();
    calls.probe.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail({ code: "failed" }) });
    await click(host(slot("copy-credentials-check-all"))[0]!);
    await flush();
    expect(host(slot("copy-credentials-stale"))).toHaveLength(1);
    expect(host(slot("copy-credential-row"))).toHaveLength(3);
    expect(text()).not.toContain("Update SpecWithCode");
  });

  const inRow = (id: ProjectCredentialId, name: string) =>
    host(slot("copy-credential-row"))
      .find((node) => node.props["data-credential"] === id)!
      .findAll((node) => node.props["data-slot"] === name && typeof node.type === "string");
  const unanswered = { _tag: "Failure" as const, cause: Cause.fail({ code: "failed" }) };

  it("keeps a row's failed check in view until that row is answered again", async () => {
    scanned();
    calls.probe.mockResolvedValueOnce(answers("not_signed_in"));
    await mount(undefined, "p2");
    await flush();
    await click(inRow("npm", "copy-credential-sign-in")[0]!);
    await click(inRow("cloudflare", "copy-credential-sign-in")[0]!);
    calls.probe.mockResolvedValueOnce(unanswered);
    await click(inRow("npm", "copy-credential-check")[0]!);
    await flush();
    expect(host(slot("copy-credentials-stale"))).toHaveLength(1);
    // Another row's check comes back fine: npm's row still shows an answer from before.
    calls.probe.mockResolvedValueOnce(
      ok({
        results: [
          {
            ...probe("cloudflare", "not_signed_in", "wrangler login", "wrangler whoami"),
            tool: toolOf(),
          },
        ],
      }),
    );
    await click(inRow("cloudflare", "copy-credential-check")[0]!);
    await flush();
    expect(host(slot("copy-credentials-stale"))).toHaveLength(1);
    calls.probe.mockResolvedValueOnce(
      ok({ results: [probe("npm", "not_signed_in", "npm login", "npm whoami")] }),
    );
    await click(inRow("npm", "copy-credential-check")[0]!);
    await flush();
    expect(host(slot("copy-credentials-stale"))).toHaveLength(0);
  });

  it("does not lose a failed check because a later check of another row is still out", async () => {
    scanned();
    calls.probe.mockResolvedValueOnce(answers("not_signed_in"));
    await mount(undefined, "p2");
    await flush();
    await click(inRow("npm", "copy-credential-sign-in")[0]!);
    await click(inRow("cloudflare", "copy-credential-sign-in")[0]!);
    const npm = later();
    await click(inRow("npm", "copy-credential-check")[0]!);
    const cloudflare = later();
    await click(inRow("cloudflare", "copy-credential-check")[0]!);
    await npm(unanswered);
    // Cloudflare's check is still out, so the list says checking; npm's failure is not gone.
    expect(inRow("npm", "copy-credential-checking")).toHaveLength(0);
    await cloudflare(
      ok({
        results: [
          {
            ...probe("cloudflare", "not_signed_in", "wrangler login", "wrangler whoami"),
            tool: toolOf(),
          },
        ],
      }),
    );
    expect(host(slot("copy-credential-checking"))).toHaveLength(0);
    expect(host(slot("copy-credentials-stale"))).toHaveLength(1);
  });

  it("asks a machine for an update only when it does not have the check at all", async () => {
    scanned();
    calls.probe.mockResolvedValueOnce(unanswered);
    await mount(undefined, "p2");
    await flush();
    // The check's own "failed": that machine is current, and its project list could not be read.
    expect(text()).toContain("m5 could not be checked. Try Check again.");
    expect(text()).not.toContain("Update SpecWithCode");
    act(() => renderer.unmount());
    scanned();
    calls.probe.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail({ _tag: "RpcError" }) });
    await mount(undefined, "p2");
    await flush();
    expect(text()).toContain("m5 could not be checked. Update SpecWithCode there to see it.");
  });

  it("says the rows are being checked from the first frame the list is on screen", async () => {
    scanned();
    let first = "";
    let answer!: (value: unknown) => void;
    calls.probe.mockImplementationOnce(() => {
      // Asked from the effect of the first frame that has rows: what is on screen is that frame.
      first = text();
      return new Promise((resolve) => (answer = resolve));
    });
    await mount(undefined, "p2");
    await flush();
    expect(first).toContain("copy-credential-row");
    expect(first).toContain("copy-credential-checking");
    expect(first).not.toContain("Not checked on m5 yet");
    await act(async () => answer(answers("not_signed_in")));
    expect(host(slot("copy-credential-checking"))).toHaveLength(0);
    expect(text()).toContain("Not signed in on m5");
  });

  it("says the machine is busy when it was asked too often, and keeps the rows", async () => {
    scanned();
    calls.probe.mockResolvedValueOnce(answers("not_signed_in"));
    await mount(undefined, "p2");
    await flush();
    calls.probe.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail({ code: "busy" }) });
    await click(host(slot("copy-credentials-check-all"))[0]!);
    await flush();
    expect(text()).toContain("Try again in a minute");
    expect(host(slot("copy-credential-row"))).toHaveLength(3);
    expect(host(slot("copy-credential-checking"))).toHaveLength(0);
  });
});
