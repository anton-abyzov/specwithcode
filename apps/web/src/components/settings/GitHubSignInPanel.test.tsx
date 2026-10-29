// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { GitHubSignInPanel } from "./GitHubSignInPanel";

const state = vi.hoisted(() => ({
  supported: true,
  allowed: true,
  calls: [] as Array<{ command: string; request: unknown }>,
  replies: {} as Record<string, Array<unknown>>,
  opened: [] as string[],
  copied: [] as string[],
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ environment: { capabilities: { gitHubSignIn: state.supported } } }),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { configValueAtom: () => "config" } }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => state.allowed }));
vi.mock("../../studio/gitHubSignIn", () => ({
  gitHubSignIn: { start: "start", status: "status", cancel: "cancel" },
}));
// Stable per command, like the real hook's useCallback.
const commands = new Map<string, (request: unknown) => Promise<unknown>>();
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => {
    let run = commands.get(command);
    if (!run) {
      run = async (request: unknown) => {
        state.calls.push({ command, request });
        const next = state.replies[command]?.shift();
        if (next instanceof Error) return { _tag: "Failure", error: next };
        return { _tag: "Success", value: next ?? flow({ phase: "idle", flowId: null }) };
      };
      commands.set(command, run);
    }
    return run;
  },
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (failure: { error: unknown }) => failure.error,
}));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({
    shell: { openExternal: async (url: string) => void state.opened.push(url) },
  }),
}));
vi.mock("../../hooks/useCopyToClipboard", () => ({
  writeTextToClipboard: async (text: string) => void state.copied.push(text),
}));

const flow = (patch: Record<string, unknown>) => ({
  flowId: "flow-1",
  phase: "starting",
  host: "github.com",
  deviceCode: null,
  login: null,
  alreadySignedIn: false,
  failure: null,
  message: null,
  expiresAt: 900_000,
  ...patch,
});
const CODE = { userCode: "AB12-CD34", url: "https://github.com/login/device" };

let root: Root;
let container: HTMLDivElement;
let signedIn: number;
// Timers are fake, so settling only drains promises.
const settle = () =>
  act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  });
const button = (label: string) => {
  const element = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!element) throw new Error(`Missing button ${label}: ${container.textContent}`);
  return element;
};
const mount = async () => {
  await act(async () =>
    root.render(
      <GitHubSignInPanel
        environmentId={"ministorm" as never}
        environmentLabel="ministorm"
        onSignedIn={() => (signedIn += 1)}
      />,
    ),
  );
  await settle();
};
const poll = async () => {
  await act(async () => vi.advanceTimersByTime(1_500));
  await settle();
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  state.supported = true;
  state.allowed = true;
  state.calls = [];
  state.replies = {};
  state.opened = [];
  state.copied = [];
  signedIn = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

it("starts gh on that machine, shows its code and page here, then reports the login", async () => {
  await mount();
  expect(container.textContent).toContain("The sign-in stays on ministorm.");
  state.replies.start = [flow({ phase: "starting" })];
  state.replies.status = [
    flow({ phase: "waiting", deviceCode: CODE }),
    flow({ phase: "verifying", deviceCode: CODE }),
    flow({ phase: "succeeded", deviceCode: CODE, login: "octo" }),
  ];
  await act(async () => button("Sign in to GitHub").click());
  await settle();
  expect(state.calls.at(-1)).toEqual({
    command: "start",
    request: { environmentId: "ministorm", input: {} },
  });
  expect(container.textContent).toContain("Starting gh on ministorm");

  await poll();
  expect(container.textContent).toContain("AB12-CD34");
  expect(container.textContent).toContain("saved on ministorm only");
  await act(async () => button("Copy code").click());
  await settle();
  expect(state.copied).toEqual(["AB12-CD34"]);
  expect(container.textContent).toContain("Code copied");
  await act(async () => button("Open github.com/login/device").click());
  await settle();
  expect(state.opened).toEqual(["https://github.com/login/device"]);

  await poll();
  expect(container.textContent).toContain("Checking the sign-in on ministorm");
  await poll();
  expect(container.textContent).toContain("Signed in as octo on ministorm.");
  expect(signedIn).toBe(1);
  // Polling stops once the flow settled.
  const calls = state.calls.length;
  await poll();
  expect(state.calls).toHaveLength(calls);
});

it("shows the real error and retries", async () => {
  await mount();
  state.replies.start = [
    flow({ phase: "failed", failure: "failed", message: "gh could not finish signing in: boom" }),
    flow({ phase: "waiting", flowId: "flow-2", deviceCode: CODE }),
  ];
  await act(async () => button("Sign in to GitHub").click());
  await settle();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "gh could not finish signing in: boom",
  );
  await act(async () => button("Retry").click());
  await settle();
  expect(container.textContent).toContain("AB12-CD34");
});

it("asks to provision a machine without gh", async () => {
  await mount();
  state.replies.start = [flow({ phase: "failed", failure: "not-installed", message: "x" })];
  await act(async () => button("Sign in to GitHub").click());
  await settle();
  expect(container.textContent).toContain("Run specwithcode provision on ministorm");
});

it("cancels only its own flow", async () => {
  await mount();
  state.replies.start = [flow({ phase: "waiting", deviceCode: CODE })];
  state.replies.cancel = [flow({ phase: "cancelled", message: "Sign-in cancelled." })];
  await act(async () => button("Sign in to GitHub").click());
  await settle();
  await act(async () => button("Cancel").click());
  await settle();
  expect(state.calls.at(-1)).toEqual({
    command: "cancel",
    request: { environmentId: "ministorm", input: { flowId: "flow-1" } },
  });
  expect(container.textContent).toContain("Sign-in cancelled.");
  expect(button("Retry")).toBeTruthy();
});

it("picks up a sign-in already running on that machine", async () => {
  state.replies.status = [flow({ phase: "waiting", deviceCode: CODE })];
  await mount();
  expect(container.textContent).toContain("AB12-CD34");
});

it("reports an RPC failure from an older or unreachable server", async () => {
  await mount();
  state.replies.start = [new Error("")];
  await act(async () => button("Sign in to GitHub").click());
  await settle();
  expect(container.textContent).toContain("ministorm could not start the GitHub sign-in.");
});

it("renders nothing for a server without it or a client that may not change settings", async () => {
  state.supported = false;
  await mount();
  expect(container.textContent).toBe("");
  state.supported = true;
  state.allowed = false;
  await mount();
  expect(container.textContent).toBe("");
});
