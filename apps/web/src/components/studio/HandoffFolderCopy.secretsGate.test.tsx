// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  copyHandlers,
  CopyFixture,
  copyStatus,
  findButton,
  summary,
  type FixtureOptions,
} from "./HandoffFolderCopy.testkit";
import { resetSealedRoutes } from "../../studio/copySecretsRoute";

// Secrets from a window that may not send them (signed in to the source through Connect).

const state = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  handlers: {} as Record<string, (input: unknown) => unknown>,
  uuid: 0,
  homes: {} as Record<string, string | null>,
  link: null as unknown as (...args: unknown[]) => Promise<unknown>,
  /** This window's access:write on the source, as the session reports it. */
  sourceAccess: "unknown" as "granted" | "denied" | "unknown",
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScopeAccess: () => state.sourceAccess,
  readEnvironmentScopeAccess: () => state.sourceAccess,
}));
vi.mock("../../state/filesystem", () => ({
  filesystemEnvironment: { browse: (input: unknown) => input },
  useFilesystemReadAccess: () => ({ canReadFiles: true }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (input: { environmentId: string } | null) => ({
    data:
      input && state.homes[input.environmentId]
        ? { parentPath: state.homes[input.environmentId], entries: [] }
        : null,
    isPending: !!input && !state.homes[input.environmentId],
  }),
}));
vi.mock("../../studio/machineHandoff", () => ({
  machineHandoff: new Proxy({}, { get: (_target, name) => name }),
}));
vi.mock("../../studio/projectLink", () => ({
  projectLink: new Proxy({}, { get: (_target, name) => `link:${String(name)}` }),
  linkCopyAsWorkers: (...args: unknown[]) => state.link(...args),
}));
vi.mock("./ProjectLinkDialog", () => ({
  ProjectLinkDialog: (props: { initialCandidate: unknown; initialKept: string }) => (
    <div data-slot="link-dialog">{JSON.stringify([props.initialCandidate, props.initialKept])}</div>
  ),
}));
// The credentials list has its own test (CopyCredentialsChecklist.test.tsx).
vi.mock("./CopyCredentialsChecklist", () => ({ CopyCredentialsChecklist: () => null }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: string) => async (request: unknown) => {
    state.calls.push([name, request]);
    try {
      return { _tag: "Success", value: await state.handlers[name]!(request) };
    } catch (error) {
      return { _tag: "Failure", error };
    }
  },
}));
vi.mock("../settings/MachineReadinessChecklist", () => ({
  MachineReadinessChecklist: (props: { environmentId: string; projectId: string }) => (
    <p data-slot="readiness-stub">
      Readiness {props.environmentId} {props.projectId}
    </p>
  ),
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (failure: { error: unknown }) => failure.error,
}));
vi.mock("../../lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/utils")>()),
  randomUUID: () => `00000000-0000-4000-8000-00000000000${++state.uuid}`,
}));

let root: Root;
let container: HTMLDivElement;
let statuses: Array<Record<string, unknown>>;
const names = () => state.calls.map(([name]) => name);
const button = (label: string) => findButton(container, label);
const click = async (label: string) => {
  await act(async () => button(label).click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};
const mount = (overrides: FixtureOptions = {}) =>
  act(async () => root.render(<CopyFixture {...overrides} />));
const dialogButton = (label: string) => {
  const matches = [...document.querySelectorAll<HTMLButtonElement>("button")].filter(
    (element) => element.textContent?.trim() === label,
  );
  expect(matches).toHaveLength(1);
  const result = matches[0]!;
  expect(result.closest('[data-slot="dialog-footer"]')).not.toBeNull();
  expect(result.closest('[data-slot="scroll-area-viewport"]')).toBeNull();
  return result;
};
const dialogClick = async (label: string) => {
  await act(async () => dialogButton(label).click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

beforeEach(() => {
  state.sourceAccess = "unknown";
  resetSealedRoutes();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  localStorage.clear();
  state.calls = [];
  state.uuid = 0;
  state.homes = { kioskD: "/home/sam", deskB: "/Users/sam" };
  state.link = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ status: "linked" }));
  statuses = [copyStatus("previewed"), copyStatus("applied")];
  state.handlers = copyHandlers({
    calls: () => state.calls,
    nextStatus: () => statuses.shift() ?? copyStatus("applied"),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const KEY = "specwithcode:folder-copy:laptopE:source";
const sentSecrets = () =>
  state.calls
    .filter(([name]) => name === "copySecrets")
    .map(([, request]) => (request as { input: { paths: string[] } }).input.paths);
const stagedOnSource = (files: Array<{ path: string; size: number }>) => {
  const read = state.handlers.copySourceStatus!;
  state.handlers.copySourceStatus = async (input) => ({
    ...((await read(input)) as object),
    secrets: files.length ? { files, approvedAt: 1, destinationLabel: "Kiosk D" } : null,
  });
};

it("copies without secrets, and says where to send them from, in a window that may not send them", async () => {
  // A window on another machine (signed in through Connect) holds no access:write there.
  state.sourceAccess = "denied";
  try {
    statuses = [copyStatus("previewed"), copyStatus("applied")];
    await mount();
    const along = container.querySelector('[data-slot="copy-along-secrets"]')!;
    expect(along.textContent).toContain("Secrets (.env, keys): left on Laptop E");
    expect(along.textContent).toContain(
      "Only SpecWithCode on Laptop E can send secrets. To include them, start this copy in the SpecWithCode window on Laptop E.",
    );
    expect(along.querySelector('[data-slot="checkbox"]')!.hasAttribute("data-disabled")).toBe(true);
    // A warning, not helper text: it changes what the copy carries, before it starts.
    const locked = () => container.querySelector('[data-slot="copy-secrets-locked"]')!;
    expect(locked().textContent).toContain("Only SpecWithCode on Laptop E can send secrets.");
    expect(locked().className).toContain("text-warning-foreground");
    await click("Copy to Kiosk D");
    expect(container.textContent).toContain("Secrets (.env, keys): 1 file, left on Laptop E");
    expect(locked().className).toContain("text-warning-foreground");
    // The copy records that its form said so, so it may be approved without them.
    expect(JSON.parse(localStorage.getItem(KEY)!).secretsStay).toBe(true);
    await click("Copy to Kiosk D");
    // Approval goes ahead; nothing asks the source for a grant this window lacks.
    expect(names()).toContain("copyApprove");
    expect(names()).not.toContain("copySecrets");
    expect(container.textContent).not.toContain("requires access:write");
  } finally {
    state.sourceAccess = "unknown";
  }
});

it("takes secrets staged earlier off the source before approving from that window", async () => {
  // Laptop E's own window staged .env; this window retries the copy without access:write there.
  state.sourceAccess = "denied";
  stagedOnSource([{ path: ".env", size: 10 }]);
  statuses = [copyStatus("previewed"), copyStatus("applied")];
  await mount();
  await click("Copy to Kiosk D");
  await click("Copy to Kiosk D");
  expect(sentSecrets()).toEqual([[]]);
  expect(names().indexOf("copySecrets")).toBeLessThan(names().indexOf("copyApprove"));
});

it("stops before approval when staged secrets cannot be taken off", async () => {
  state.sourceAccess = "denied";
  stagedOnSource([{ path: ".env", size: 10 }]);
  state.handlers.copySecrets = () => {
    throw new Error("This connection requires access:write.");
  };
  statuses = [copyStatus("previewed"), copyStatus("applied")];
  await mount();
  await click("Copy to Kiosk D");
  await click("Copy to Kiosk D");
  expect(names()).not.toContain("copyApprove");
  expect(container.textContent).toContain(
    "Secrets are still set to go from Laptop E, and this window can't take them off. Untick Secrets in the SpecWithCode window on Laptop E, or update SpecWithCode on Laptop E, then copy again.",
  );
});

it("keeps the person's secrets choice for a window that may send them", async () => {
  state.sourceAccess = "denied";
  statuses = [copyStatus("previewed"), copyStatus("previewed"), copyStatus("applied")];
  await mount();
  await click("Copy to Kiosk D");
  // The saved copy still says Secrets included; only this window leaves them out.
  expect(JSON.parse(localStorage.getItem(KEY)!).secrets).toEqual({ included: true, out: [] });
  await act(async () => root.unmount());
  root = createRoot(container);
  state.sourceAccess = "granted";
  await mount();
  expect(container.textContent).toContain("Secrets (.env, keys): 1 file, included");
  await click("Copy to Kiosk D");
  expect(sentSecrets()).toEqual([[".env"]]);
});

it("approves without secrets from a window that may not send them, so nothing staged travels", async () => {
  state.sourceAccess = "denied";
  statuses = [copyStatus("previewed"), copyStatus("applied")];
  await mount();
  await click("Copy to Kiosk D");
  await click("Copy to Kiosk D");
  const approval = state.calls.find(([name]) => name === "copyApprove")![1] as {
    input: Record<string, unknown>;
  };
  expect(approval.input).toEqual({ operationId: expect.any(String), withoutSecrets: true });
});

it("approves with the list it sent from a window that may send secrets", async () => {
  state.sourceAccess = "granted";
  statuses = [copyStatus("previewed"), copyStatus("applied")];
  await mount();
  await click("Copy to Kiosk D");
  await click("Copy to Kiosk D");
  const approval = state.calls.find(([name]) => name === "copyApprove")![1] as {
    input: Record<string, unknown>;
  };
  // The destination then finishes only with every one of them.
  expect(approval.input).toEqual({ operationId: expect.any(String), expectedSecrets: [".env"] });
});

// The secret files a real copy detected and left behind (an umbrella with nested repositories).
const REAL_RUN = [
  ".env",
  ".env.bak-20260715",
  ".env.cloudflare",
  "repositories/acme/specwithcode/.env",
  "repositories/acme/vskill-platform/.dev.vars",
  "repositories/acme/vskill-platform/.env",
  "repositories/acme/vskill-platform/.env.local",
  "repositories/acme/vskill-platform/crawl-worker/.env",
  "repositories/acme/vskill-platform/scanner-worker/.env",
  "scripts/.cf-monitor.env",
];
const detected = {
  ...summary,
  totals: { ...summary.totals, secret: { files: REAL_RUN.length, bytes: 100 } },
  secretFiles: REAL_RUN.map((path) => ({ path, size: 10 })),
};
const measureRealRun = () => {
  const offer = state.handlers.copyOffer!;
  state.handlers.copyOffer = (request) => ({
    ...(offer(request) as object),
    status: { state: "scanned", summary: detected, error: null },
  });
  state.handlers.copySourceStatus = () => ({ state: "scanned", summary: detected, error: null });
};

it("sends every detected secret file with the default choice, then approves with all of them", async () => {
  state.sourceAccess = "granted";
  measureRealRun();
  statuses = [
    copyStatus("previewed"),
    copyStatus("applied", {
      secrets: REAL_RUN.map((path) => ({ path, writtenAs: path, size: 10, state: "written" })),
    }),
  ];
  await mount();
  // Nothing was ticked or unticked: this is the default "Copy everything".
  await click("Copy to Kiosk D");
  expect(container.textContent).toContain("Secrets (.env, keys): 10 files, included");
  await click("Copy to Kiosk D");
  expect(sentSecrets()).toEqual([REAL_RUN]);
  expect(names().indexOf("copySecrets")).toBeLessThan(names().indexOf("copyApprove"));
  const approval = state.calls.find(([name]) => name === "copyApprove")![1] as {
    input: Record<string, unknown>;
  };
  expect(approval.input).toEqual({ operationId: expect.any(String), expectedSecrets: REAL_RUN });
  expect(left()).toBeNull();
  expect(container.textContent).not.toContain("stayed on Laptop E");
});

it("offers the secret files again when Retry follows a copy the destination stopped for them", async () => {
  state.sourceAccess = "granted";
  measureRealRun();
  const stopped = copyStatus("failed", {
    failedStep: "applied",
    committed: false,
    projectId: null,
    error: {
      code: "refused",
      message:
        "10 secret files approved for this copy were no longer offered by Laptop E. The other files are in place here. Retry to send them again.",
    },
  });
  statuses = [copyStatus("previewed"), stopped];
  await mount();
  await click("Copy to Kiosk D");
  await click("Copy to Kiosk D");
  expect(container.textContent).toContain("were no longer offered by Laptop E");
  expect(sentSecrets()).toEqual([REAL_RUN]);
  // Another window withdrew the list meanwhile: Retry sends it again, then retries.
  statuses = [
    copyStatus("applied", {
      secrets: REAL_RUN.map((path) => ({ path, writtenAs: path, size: 10, state: "written" })),
    }),
  ];
  state.handlers.copyRetry = () => copyStatus("applying");
  await click("Retry");
  expect(sentSecrets()).toEqual([REAL_RUN, REAL_RUN]);
  expect(names().lastIndexOf("copySecrets")).toBeLessThan(names().indexOf("copyRetry"));
  expect(left()).toBeNull();
});

const left = () => container.querySelector('[data-slot="copy-secrets-left"]');
const resumed = (extra: Record<string, unknown> = {}) =>
  localStorage.setItem(
    KEY,
    JSON.stringify({
      operationId: "00000000-0000-4000-8000-000000000009",
      environmentId: "kioskD",
      mode: "copy-only",
      targetFolder: "/home/sam/project",
      projectId: null,
      secrets: { included: true, out: [] },
      ...extra,
    }),
  );

it("says on Done that only the source's own window can send the secrets that stayed", async () => {
  state.sourceAccess = "denied";
  statuses = [copyStatus("previewed"), copyStatus("applied")];
  await mount();
  await click("Copy to Kiosk D");
  await click("Copy to Kiosk D");
  expect(left()!.textContent).toBe(
    "1 secret-like file (.env and similar) stayed on Laptop E. This window can't send them: only SpecWithCode on Laptop E can. Start the copy again there with Secrets ticked.",
  );
  // No action here: copying again from this window would leave them behind again.
  expect(left()!.querySelector("button")).toBeNull();
});

it("offers Copy again with secrets on Done in a window that can send them", async () => {
  state.sourceAccess = "granted";
  statuses = [copyStatus("previewed"), copyStatus("applied")];
  await mount();
  // The person unticks Secrets, so the copy leaves .env on Laptop E.
  await act(async () =>
    container
      .querySelector<HTMLElement>('[data-slot="copy-along-secrets"] [data-slot="checkbox"]')!
      .click(),
  );
  await click("Copy to Kiosk D");
  await click("Copy to Kiosk D");
  expect(sentSecrets()).toEqual([[]]);
  expect(left()!.textContent).toContain(
    "1 secret-like file (.env and similar) stayed on Laptop E. To send them, copy again with Secrets ticked.",
  );
  expect(left()!.textContent).not.toContain("Let me choose file types first");
  const first = JSON.parse(localStorage.getItem(KEY)!).operationId as string;
  statuses = [
    copyStatus("previewed"),
    copyStatus("applied", {
      secrets: [{ path: ".env", writtenAs: ".env", size: 10, state: "written" }],
    }),
  ];
  await act(async () => findButton(left()!, "Sync again with secrets").click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  // A fresh copy of the same folder and machine, with every secret ticked.
  const again = JSON.parse(localStorage.getItem(KEY)!);
  expect(again.operationId).not.toBe(first);
  expect(again).toMatchObject({ environmentId: "kioskD", secrets: { included: true, out: [] } });
  await click("Copy to Kiosk D");
  expect(sentSecrets()).toEqual([[], [".env"]]);
  expect(left()).toBeNull();
});

it("names the source's window on Done while this window's access is unconfirmed", async () => {
  // An unanswered session may turn out denied: no promise, and no button, from here.
  state.sourceAccess = "unknown";
  statuses = [copyStatus("previewed"), copyStatus("applied")];
  await mount();
  await act(async () =>
    container
      .querySelector<HTMLElement>('[data-slot="copy-along-secrets"] [data-slot="checkbox"]')!
      .click(),
  );
  await click("Copy to Kiosk D");
  await click("Copy to Kiosk D");
  expect(left()!.textContent).toBe(
    "1 secret-like file (.env and similar) stayed on Laptop E. To send them, start the copy again in SpecWithCode on Laptop E with Secrets ticked.",
  );
  expect(left()!.querySelector("button")).toBeNull();
});

it("offers no Copy again with secrets when a fresh copy would carry none of what stayed", async () => {
  state.sourceAccess = "granted";
  // Only a home-folder secret exists, and Kiosk D cannot receive those.
  const read = state.handlers.copySourceStatus!;
  state.handlers.copySourceStatus = async (input) => {
    const value = (await read(input)) as { summary: Record<string, unknown> };
    return {
      ...value,
      summary: { ...value.summary, secretFiles: [{ path: "~/.config/tool/key", size: 10 }] },
    };
  };
  statuses = [copyStatus("previewed"), copyStatus("applied")];
  await mount();
  await click("Copy to Kiosk D");
  await click("Copy to Kiosk D");
  // The text names no action either: copying again would leave it behind again.
  expect(left()!.textContent).toBe("1 secret-like file (.env and similar) stayed on Laptop E.");
  expect(left()!.querySelector("button")).toBeNull();
});

const unread = () => container.querySelector('[data-slot="copy-secrets-unread"]');

it("shows the warning at a review whose secret list could not be read, before approving without secrets", async () => {
  // Started with secrets included; this window then turned out unable to send them, and the
  // source does not answer on reopen.
  state.sourceAccess = "denied";
  resumed();
  state.handlers.copySourceStatus = () => {
    throw new Error("Laptop E did not answer.");
  };
  statuses = [copyStatus("previewed"), copyStatus("applied")];
  await mount();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(names()).not.toContain("copyApprove");
  const warning = unread()!.querySelector('[data-slot="copy-secrets-locked"]')!;
  expect(warning.textContent).toBe(
    "Only SpecWithCode on Laptop E can send secrets. To include them, start this copy in the SpecWithCode window on Laptop E.",
  );
  expect(unread()!.textContent).toContain("Secrets (.env, keys): left on Laptop E");
  expect(unread()!.querySelector('[data-slot="checkbox"]')!.hasAttribute("data-disabled")).toBe(
    true,
  );
  // Approving a review that shows the warning is the person's decision.
  await click("Copy to Kiosk D");
  const approval = state.calls.find(([name]) => name === "copyApprove")![1] as {
    input: Record<string, unknown>;
  };
  expect(approval.input).toEqual({ operationId: expect.any(String), withoutSecrets: true });
  expect(JSON.parse(localStorage.getItem(KEY)!).secretsStay).toBe(true);
});

it("lets the person untick Secrets at a review whose secret list cannot be read", async () => {
  state.sourceAccess = "granted";
  resumed();
  state.handlers.copySourceStatus = () => {
    throw new Error("Laptop E did not answer.");
  };
  statuses = [copyStatus("previewed"), copyStatus("applied")];
  await mount();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(unread()!.textContent).toContain("Secrets (.env, keys): included");
  expect(unread()!.textContent).toContain(
    "The list of secret files has not been read from Laptop E yet.",
  );
  await click("Copy to Kiosk D");
  expect(names()).not.toContain("copyApprove");
  expect(container.textContent).toContain("or untick Secrets to copy without them.");
  // The instruction has a box to untick.
  await act(async () => unread()!.querySelector<HTMLElement>('[data-slot="checkbox"]')!.click());
  expect(unread()!.textContent).toContain("Secrets (.env, keys): left on Laptop E");
  expect(JSON.parse(localStorage.getItem(KEY)!).secrets.included).toBe(false);
  await click("Copy to Kiosk D");
  const approval = state.calls.find(([name]) => name === "copyApprove")![1] as {
    input: Record<string, unknown>;
  };
  expect(approval.input).toEqual({ operationId: expect.any(String), withoutSecrets: true });
  expect(names()).not.toContain("copySecrets");
});

it("reads the secret list before approving a reopened copy that could not read it", async () => {
  state.sourceAccess = "granted";
  resumed();
  const read = state.handlers.copySourceStatus!;
  let reads = 0;
  state.handlers.copySourceStatus = (input) => {
    reads += 1;
    // The source did not answer while the dialog reopened.
    if (reads === 1) throw new Error("Laptop E did not answer.");
    return read(input);
  };
  statuses = [copyStatus("previewed"), copyStatus("applied")];
  await mount();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  await click("Copy to Kiosk D");
  // Included secrets are never approved with nothing staged.
  expect(sentSecrets()).toEqual([[".env"]]);
  expect(names().indexOf("copySecrets")).toBeLessThan(names().indexOf("copyApprove"));
});

it("does not approve included secrets blind when the secret list cannot be read", async () => {
  state.sourceAccess = "granted";
  resumed();
  state.handlers.copySourceStatus = () => {
    throw new Error("Laptop E did not answer.");
  };
  statuses = [copyStatus("previewed"), copyStatus("applied")];
  await mount();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  await click("Copy to Kiosk D");
  expect(names()).not.toContain("copyApprove");
  expect(names()).not.toContain("copySecrets");
  expect(container.textContent).toContain(
    "The list of secret files could not be read from Laptop E. Try again once Laptop E is reachable, or untick Secrets to copy without them.",
  );
});

it("stops a Replace all left running at the review when this window turned out unable to send secrets", async () => {
  // The form said included; the source's session then showed this window may not send them.
  state.sourceAccess = "denied";
  resumed({ replaceAll: true, replaceAllOutcome: "copy" });
  statuses = [copyStatus("previewed"), copyStatus("previewed"), copyStatus("applied")];
  await mount();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(names()).not.toContain("copyApprove");
  expect(container.textContent).toContain("Only SpecWithCode on Laptop E can send secrets.");
  expect(JSON.parse(localStorage.getItem(KEY)!).replaceAll).toBeUndefined();
  // The review shows the warning; approving there is the person's decision.
  await click("Copy to Kiosk D");
  const approval = state.calls.find(([name]) => name === "copyApprove")![1] as {
    input: Record<string, unknown>;
  };
  expect(approval.input).toEqual({ operationId: expect.any(String), withoutSecrets: true });
  expect(JSON.parse(localStorage.getItem(KEY)!).secretsStay).toBe(true);
});

// A window signed in to the source through Connect, where the source can send secrets
// sealed to the destination machine: the ticked line is the one approval.
const sealedWindow = (route: () => unknown = () => ({ sealed: true })) => {
  state.sourceAccess = "denied";
  state.handlers.copySecretsRoute = route;
  state.handlers.copySealedSecrets = state.handlers.copySecrets!;
  state.handlers.copySecrets = ({ input }: any) => {
    if (input.paths.length > 0) throw new Error("This connection requires access:write.");
    return { state: "scanned", summary, error: null, secrets: null };
  };
};
const sealedSecrets = () =>
  state.calls
    .filter(([name]) => name === "copySealedSecrets")
    .map(([, request]) => (request as { input: { paths: string[] } }).input.paths);

it("sends every detected secret sealed after the one ticked line, from a window without access:write", async () => {
  sealedWindow();
  measureRealRun();
  statuses = [
    copyStatus("previewed"),
    copyStatus("applied", {
      secrets: REAL_RUN.map((path) => ({ path, writtenAs: path, size: 10, state: "written" })),
    }),
  ];
  await mount();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  // The source was asked about this destination, and the line reads as in its own window.
  expect(state.calls.find(([name]) => name === "copySecretsRoute")![1]).toEqual({
    environmentId: "laptopE",
    input: { destinationEnvironmentId: "kioskD" },
  });
  const along = container.querySelector('[data-slot="copy-along-secrets"]')!;
  expect(along.textContent).toContain("Secrets (.env, keys): included");
  expect(along.textContent).toContain("Sent sealed by Laptop E straight to Kiosk D.");
  expect(along.querySelector('[data-slot="checkbox"]')!.hasAttribute("data-disabled")).toBe(false);
  expect(container.querySelector('[data-slot="copy-secrets-locked"]')).toBeNull();
  // Nothing was ticked or unticked: this is the default "Copy everything".
  await click("Copy to Kiosk D");
  expect(container.textContent).toContain("Secrets (.env, keys): 10 files, included");
  expect(container.textContent).toContain("Sent sealed by Laptop E straight to Kiosk D.");
  expect(JSON.parse(localStorage.getItem(KEY)!).secretsStay).toBeUndefined();
  await click("Copy to Kiosk D");
  // One sealed send with every file, no plain send, and no further prompt.
  expect(sealedSecrets()).toEqual([REAL_RUN]);
  expect(sentSecrets()).toEqual([]);
  expect(names().indexOf("copySealedSecrets")).toBeLessThan(names().indexOf("copyApprove"));
  const approval = state.calls.find(([name]) => name === "copyApprove")![1] as {
    input: Record<string, unknown>;
  };
  expect(approval.input).toEqual({ operationId: expect.any(String), expectedSecrets: REAL_RUN });
  expect(left()).toBeNull();
  expect(container.textContent).not.toContain("stayed on Laptop E");
});

it("leaves secrets on the source, unticked, when the person unticks the line in that window", async () => {
  sealedWindow();
  statuses = [copyStatus("previewed"), copyStatus("applied")];
  await mount();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const box = container.querySelector<HTMLElement>(
    '[data-slot="copy-along-secrets"] [data-slot="checkbox"]',
  )!;
  await act(async () => box.click());
  await click("Copy to Kiosk D");
  await click("Copy to Kiosk D");
  expect(sealedSecrets()).toEqual([]);
  const approval = state.calls.find(([name]) => name === "copyApprove")![1] as {
    input: Record<string, unknown>;
  };
  expect(approval.input).toEqual({ operationId: expect.any(String), withoutSecrets: true });
});

it("says why when the destination does not take the source's secrets", async () => {
  sealedWindow(() => ({ sealed: false, reason: "not_allowed" }));
  statuses = [copyStatus("previewed"), copyStatus("applied")];
  await mount();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const locked = container.querySelector('[data-slot="copy-secrets-locked"]')!;
  expect(locked.textContent).toContain(
    "Kiosk D takes secrets from Laptop E only while Laptop E has full access there as your own machine. Allow that on Kiosk D, or start this copy in the SpecWithCode window on Laptop E.",
  );
  expect(container.querySelector('[data-slot="copy-along-secrets"]')!.textContent).toContain(
    "Secrets (.env, keys): left on Laptop E",
  );
  await click("Copy to Kiosk D");
  await click("Copy to Kiosk D");
  expect(sealedSecrets()).toEqual([]);
  const approval = state.calls.find(([name]) => name === "copyApprove")![1] as {
    input: Record<string, unknown>;
  };
  expect(approval.input).toEqual({ operationId: expect.any(String), withoutSecrets: true });
});

it("stops at the review when the sealed way is gone by the time of the approval", async () => {
  let reachable = true;
  sealedWindow(() => (reachable ? { sealed: true } : { sealed: false, reason: "unreachable" }));
  statuses = [copyStatus("previewed"), copyStatus("previewed"), copyStatus("applied")];
  await mount();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  await click("Copy to Kiosk D");
  reachable = false;
  await click("Copy to Kiosk D");
  // The form said included, so nothing is approved without them unseen.
  expect(names()).not.toContain("copyApprove");
  expect(sealedSecrets()).toEqual([]);
  expect(container.textContent).toContain("Laptop E can't reach Kiosk D right now");
});

it("does not approve when the source refuses to seal the secrets", async () => {
  sealedWindow();
  state.handlers.copySealedSecrets = () => {
    throw new Error("Kiosk D did not give a key for the secret files.");
  };
  statuses = [copyStatus("previewed"), copyStatus("applied")];
  await mount();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  await click("Copy to Kiosk D");
  await click("Copy to Kiosk D");
  expect(names()).not.toContain("copyApprove");
  expect(container.textContent).toContain("Kiosk D did not give a key for the secret files.");
});
