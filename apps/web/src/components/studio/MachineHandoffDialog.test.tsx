// @vitest-environment jsdom
import { act, useState, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MachineHandoffButton, MachineHandoffDialog } from "./MachineHandoffDialog";
import { HandoffCopyDoneActions } from "./HandoffCopyDone";
import { copyStatus } from "./HandoffFolderCopy.testkit";
import { FilesTravelChoice, SendSummary } from "./ProjectMoveOptions";
import { Tip } from "./shell/Tip";
import { unloadedMainText } from "../../studio/makeMain";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { TooltipProvider } from "../ui/tooltip";

type HandoffProps = ComponentProps<typeof MachineHandoffDialog>;
const destinations: HandoffProps["destinations"] = [
  {
    key: "m1:project",
    environmentId: "m1",
    label: "MacBook Pro",
    folder: "/projects/product",
    unavailable: null,
  },
  {
    key: "m3:project",
    environmentId: "m3",
    label: "Mac Mini",
    folder: "/projects/product",
    unavailable: null,
  },
  {
    key: "offline:project",
    environmentId: "offline",
    label: "Offline machine",
    folder: "/projects/product",
    unavailable: "Connect this machine first.",
  },
];
const machines: NonNullable<HandoffProps["machines"]> = [
  { value: "m1", label: "MacBook Pro", tone: "ready" },
  { value: "m3", label: "Mac Mini", tone: "ready" },
  { value: "offline", label: "Offline machine", tone: "off", reason: "Offline", disabled: true },
];
const preview: NonNullable<HandoffProps["preview"]> = {
  repositories: [
    { relativePath: ".", head: "abc123456789abcdef" },
    { relativePath: "repositories/server", head: "def123456789abcdef" },
  ],
  messageCount: 8,
};
let root: Root;
let container: HTMLDivElement;
let props: HandoffProps;

async function render(children: ReactNode) {
  await act(async () => root.render(children));
}
async function handoff(overrides: Partial<HandoffProps> = {}) {
  props = { ...props, ...overrides };
  await render(<MachineHandoffDialog {...props} />);
}
function button(label: string) {
  const element = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!element) throw new Error(`Missing button ${label}: ${document.body.textContent}`);
  return element;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
function radio(label: string) {
  const element = [
    ...document.querySelectorAll<HTMLElement>('[data-slot="machine-option"] [role="radio"]'),
  ].find((node) => node.closest('[data-slot="machine-option"]')?.textContent?.includes(label));
  if (!element) throw new Error(`Missing machine ${label}`);
  return element;
}
const folderField = (machine: string) =>
  document.querySelector<HTMLInputElement>(`input[aria-label="Folder on ${machine}"]`);
async function escape() {
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  props = {
    open: true,
    onOpenChange: vi.fn(),
    sourceLabel: "MacBook M4",
    projectTitle: "Product",
    destinations,
    selected: "m1:project",
    onSelect: vi.fn(),
    machines,
    machine: "m1",
    onMachineChange: vi.fn(),
    preview: null,
    phase: "choose",
    error: null,
    consent: false,
    onConsent: vi.fn(),
    onReview: vi.fn(),
    onContinue: vi.fn(),
    onOpenDestination: vi.fn(),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("machine handoff dialog", () => {
  it("names the move and its source, and picks a machine only on an explicit action", async () => {
    await handoff();
    const popup = document.querySelector('[role="dialog"]')!;
    expect(popup.getAttribute("aria-labelledby")).toBe(document.querySelector("h2")?.id);
    expect(document.querySelector("h2")?.textContent).toBe(
      "Continue the coordinator on MacBook Pro",
    );
    expect(document.querySelector('[data-slot="dialog-description"]')?.textContent).toBe(
      "From MacBook M4. The coordinator continues on MacBook Pro. Nothing on MacBook Pro is replaced without asking.",
    );
    expect(radio("MacBook Pro").getAttribute("aria-checked")).toBe("true");
    expect(folderField("MacBook Pro")?.value).toBe("/projects/product");
    expect(props.onMachineChange).not.toHaveBeenCalled();
    await click(radio("Mac Mini"));
    expect(props.onMachineChange).toHaveBeenCalledExactlyOnceWith("m3");
    await handoff({ selected: "m3:project", machine: "m3" });
    expect(radio("Mac Mini").getAttribute("aria-checked")).toBe("true");
    await click(button("Continue the coordinator on Mac Mini"));
    expect(props.onReview).toHaveBeenCalledOnce();
  });

  it("keeps unavailable machines and folders unselectable and explains why", async () => {
    await handoff();
    expect(radio("Offline machine").getAttribute("aria-disabled")).toBe("true");
    await click(radio("Offline machine"));
    expect(props.onMachineChange).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Offline");
    await handoff({ selected: "offline:project", machine: "offline" });
    expect(document.body.textContent).toContain("Connect this machine first.");
    expect(button("Continue the coordinator on Offline machine").disabled).toBe(true);
    await click(button("Continue the coordinator on Offline machine"));
    expect(props.onReview).not.toHaveBeenCalled();
  });

  it("says what a large project's Git review leaves on this machine", async () => {
    const retention = {
      note: "Worker chats did not move.",
      coordinatorMessages: 412,
      omittedMessages: 9418,
      truncatedMessages: 0,
      totalThreads: 1628,
      workers: Array.from({ length: 200 }, (_, i) => ({
        threadId: `worker-${i}`,
        title: `Worker ${i}`,
        branch: null,
        worktreePath: null,
        status: "completed",
        archived: false,
        lastActivityAt: "2026-10-30T00:00:00.000Z",
      })),
      omittedThreads: 1428,
    } as unknown as NonNullable<NonNullable<HandoffProps["preview"]>["retention"]>;
    await handoff({ phase: "review", preview: { ...preview, messageCount: 412, retention } });
    expect(document.querySelector('[data-slot="handoff-git-review"]')!.textContent).toContain(
      "2 repositories, the latest 412 of 9,830 coordinator messages and a summary of 200 of 1,628 worker chats. Older messages and worker transcripts stay here. Committed work only.",
    );
    const elsewhere = {
      ...retention,
      machines: [
        { environmentId: "m4", totalThreads: 0, omittedThreads: 0, omittedMessages: 0 },
        { environmentId: "m3", totalThreads: 1628, omittedThreads: 1428, omittedMessages: 9418 },
      ],
    } as unknown as typeof retention;
    await handoff({
      phase: "review",
      preview: { ...preview, messageCount: 412, retention: elsewhere },
    });
    expect(document.querySelector('[data-slot="handoff-git-review"]')!.textContent).toContain(
      "Older messages and worker transcripts stay on the machines they were written on. Committed work only.",
    );
  });
  it("names the workers whose code a large project's Git review leaves only here", async () => {
    const retention = {
      note: "Worker chats did not move.",
      coordinatorMessages: 412,
      omittedMessages: 9418,
      truncatedMessages: 0,
      totalThreads: 1628,
      workers: [],
      omittedThreads: 1628,
      unmergedWorkers: [
        {
          environmentId: "m4",
          threadId: "worker-1",
          title: "Fix login",
          branch: "inc/0042-login",
          worktreePath: "/work/0042",
        },
        {
          environmentId: "m4",
          threadId: "worker-2",
          title: "Draft notes",
          branch: null,
          worktreePath: "/work/notes",
        },
      ],
      unmergedWorkerCount: 5,
    } as unknown as NonNullable<NonNullable<HandoffProps["preview"]>["retention"]>;
    await handoff({ phase: "review", preview: { ...preview, messageCount: 412, retention } });
    const warning = document.querySelector('[data-slot="handoff-unmerged-workers"]')!;
    expect(warning.textContent).toContain(
      "5 worker chats have a branch or worktree with commits or changes these do not include, or one that could not be checked.",
    );
    expect([...warning.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Fix login · inc/0042-login",
      "Draft notes · /work/notes",
      "and 3 more",
    ]);
    await handoff({
      phase: "review",
      preview: {
        ...preview,
        messageCount: 412,
        retention: { ...retention, unmergedWorkers: [], unmergedWorkerCount: 0 },
      },
    });
    expect(document.querySelector('[data-slot="handoff-unmerged-workers"]')).toBeNull();
  });
  it("hides the choices in the Git review and requires push consent before moving", async () => {
    await handoff({ phase: "review", preview });
    expect(document.querySelector('[data-slot="machine-option"]')).toBeNull();
    expect(document.querySelector('[data-slot="handoff-method"]')).toBeNull();
    const review = document.querySelector('[data-slot="handoff-git-review"]')!;
    expect(review.textContent).toContain(
      "2 repositories, 8 messages. Committed work only. Uncommitted files, sign-ins and running processes stay here.",
    );
    const details = document.querySelector('[data-slot="handoff-commits"]')!;
    expect(details.textContent).toContain("Productabc123456789");
    expect(details.textContent).toContain("repositories/serverdef123456789");
    expect(review.textContent).toContain(
      "Push these commits to their remotes and continue the coordinator on MacBook Pro.",
    );
    expect(button("Continue the coordinator on MacBook Pro").disabled).toBe(true);
    await click(button("Continue the coordinator on MacBook Pro"));
    expect(props.onContinue).not.toHaveBeenCalled();
    await click(document.querySelector<HTMLElement>('[role="checkbox"]')!);
    expect(props.onConsent).toHaveBeenCalledWith(true, expect.anything());
    await handoff({ consent: true });
    expect(button("Continue the coordinator on MacBook Pro").disabled).toBe(false);
    await click(button("Continue the coordinator on MacBook Pro"));
    expect(props.onContinue).toHaveBeenCalledOnce();
  });

  it.each(["checking", "transferring"] as const)(
    "blocks close and repeated actions while %s",
    async (phase) => {
      await handoff({ phase, preview: phase === "transferring" ? preview : null, consent: true });
      expect(document.querySelector('[data-slot="dialog-close"]')).toBeNull();
      expect(() => button("Close")).toThrow();
      if (phase === "checking") {
        expect(radio("Mac Mini").getAttribute("aria-disabled")).toBe("true");
        expect(button("Cancel").disabled).toBe(true);
      }
      const action = button(phase === "checking" ? "Checking…" : "Handing off the coordinator…");
      expect(action.disabled).toBe(true);
      await click(action);
      await escape();
      expect(props.onOpenChange).not.toHaveBeenCalled();
      expect(props.onReview).not.toHaveBeenCalled();
      expect(props.onContinue).not.toHaveBeenCalled();
      if (phase === "transferring") {
        expect(document.querySelector('[role="checkbox"]')?.getAttribute("aria-disabled")).toBe(
          "true",
        );
        await click(document.querySelector<HTMLElement>('[role="checkbox"]')!);
        expect(props.onConsent).not.toHaveBeenCalled();
      }
      expect(document.querySelector('[role="status"][aria-live]')?.textContent).toBe(
        phase === "checking"
          ? "Checking both machines…"
          : "Pushing commits and starting Product on MacBook Pro…",
      );
    },
  );

  it("allows Cancel, the corner close and Escape again after checking finishes", async () => {
    await handoff({ phase: "checking" });
    await escape();
    expect(props.onOpenChange).not.toHaveBeenCalled();
    await handoff({ phase: "choose" });
    expect(
      [...document.querySelectorAll('[data-slot="dialog-footer"] button')].map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["Cancel", "Continue the coordinator on MacBook Pro"]);
    await click(document.querySelector<HTMLElement>('[data-slot="dialog-close"]')!);
    await escape();
    await click(button("Cancel"));
    expect(props.onOpenChange).toHaveBeenCalledTimes(3);
    expect(props.onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("offers the project on the destination after success without another transfer control", async () => {
    await handoff({ phase: "complete", preview, consent: true });
    expect(document.querySelector("h2")?.textContent).toBe("Product is on MacBook Pro");
    expect(document.querySelector('[data-slot="dialog-description"]')?.textContent).toBe(
      "The coordinator continues on MacBook Pro.",
    );
    expect(document.querySelector('[role="status"]')?.textContent).toContain("its own checkout");
    expect(document.querySelector('[role="radio"]')).toBeNull();
    expect(document.querySelector('[role="checkbox"]')).toBeNull();
    await click(button("Open on MacBook Pro"));
    expect(props.onOpenDestination).toHaveBeenCalledOnce();
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it("explains an empty machine list and prevents a review without a target", async () => {
    await handoff({ destinations: [], machines: [], machine: null, selected: "" });
    expect(document.body.textContent).toContain("No other machine is connected.");
    // No machine picked: one filled primary, off, with what it waits for said beside it.
    expect(button("Continue the coordinator on another machine").disabled).toBe(true);
    expect(document.body.textContent).toContain("Choose a machine above.");
    await click(button("Continue the coordinator on another machine"));
    expect(props.onReview).not.toHaveBeenCalled();
  });

  it("shows machines that can still be connected under the list, also when it is empty", async () => {
    const extra = <p data-testid="more-machines">On your account: M5</p>;
    await handoff({ machinesExtra: extra });
    const list = document.querySelector('[data-slot="machine-options"]');
    expect(list?.parentElement?.querySelector('[data-testid="more-machines"]')).not.toBeNull();
    await handoff({ destinations: [], machines: [], machine: null, selected: "" });
    expect(document.body.textContent).toContain("No other machine is connected.");
    expect(document.querySelector('[data-testid="more-machines"]')).not.toBeNull();
  });

  it("asks for a folder on a machine with none saved, and Browse… swaps in the picker", async () => {
    await handoff({
      selected: "",
      machine: "m3",
      destinations: destinations.filter((item) => item.environmentId !== "m3"),
      folderPicker: <p data-testid="picker">Picker</p>,
    });
    expect(document.querySelector('[data-testid="picker"]')).not.toBeNull();
    expect(() => button("Keep the saved folder")).toThrow();
    expect(button("Continue the coordinator on Mac Mini").disabled).toBe(true);
    await handoff({ selected: "m1:project", machine: "m1", destinations });
    expect(document.querySelector('[data-testid="picker"]')).toBeNull();
    await click(button("Browse…"));
    expect(document.querySelector('[data-testid="picker"]')).not.toBeNull();
    expect(folderField("MacBook Pro")).toBeNull();
    await click(button("Keep the saved folder"));
    expect(folderField("MacBook Pro")?.value).toBe("/projects/product");
    // A newly saved folder replaces the picker with that folder.
    await click(button("Browse…"));
    await handoff({
      selected: "m1:new",
      destinations: [
        ...destinations,
        {
          key: "m1:new",
          environmentId: "m1",
          label: "MacBook Pro",
          folder: "/projects/new",
          unavailable: null,
        },
      ],
    });
    expect(document.querySelector('[data-testid="picker"]')).toBeNull();
    expect(document.querySelector('[aria-label="Folder on MacBook Pro"]')).not.toBeNull();
  });

  it("retains the error and exposes explicit source re-review only when provided", async () => {
    await handoff({ phase: "review", preview, error: "Source changed. Review the new commits." });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(props.error);
    expect(document.body.textContent).not.toContain("Review the updated source");
    const restart = vi.fn();
    await handoff({ onRestart: restart });
    await click(button("Review the updated source"));
    expect(restart).toHaveBeenCalledOnce();
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it("keeps an invalid reviewed target disabled and uses the single-repository label", async () => {
    await handoff({
      phase: "review",
      preview: { ...preview, repositories: preview.repositories.slice(0, 1) },
      selected: "missing",
      machine: null,
      consent: true,
    });
    expect(document.body.textContent).toContain("1 repository, 8 messages");
    expect(button("Continue the coordinator on another machine").disabled).toBe(true);
    await handoff({ phase: "complete" });
    expect(document.querySelector('[data-slot="dialog-description"]')?.textContent).toContain(
      "the other machine",
    );
  });
});

describe("shared handoff controls", () => {
  it("forwards a ref and pointer/focus/click events through the actual tooltip trigger", async () => {
    const onClick = vi.fn();
    const onFocus = vi.fn();
    const onMouseEnter = vi.fn();
    let trigger: HTMLButtonElement | null = null;
    await render(
      <TooltipProvider delay={0}>
        <Tip label="Continue on another machine">
          <MachineHandoffButton
            ref={(node) => {
              trigger = node;
            }}
            onClick={onClick}
            onFocus={onFocus}
            onMouseEnter={onMouseEnter}
          />
        </Tip>
      </TooltipProvider>,
    );
    const control = button("Add to another machine…");
    expect(trigger).toBe(control);
    expect(control.getAttribute("aria-label")).toBe("Add this project to another machine");
    expect(control.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    await act(async () => {
      control.focus();
      control.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    await click(control);
    expect(onFocus).toHaveBeenCalledOnce();
    expect(onMouseEnter).toHaveBeenCalledOnce();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "opens and closes a shared dialog with corner close=%s",
    async (cornerClose) => {
      function Example() {
        const [open, setOpen] = useState(false);
        return (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger render={<Button />}>Open example</DialogTrigger>
            <DialogPopup
              showCloseButton={cornerClose}
              bottomStickOnMobile={false}
              variant={cornerClose ? "default" : "media"}
            >
              <DialogHeader>
                <DialogTitle>Example</DialogTitle>
                <DialogDescription>Dialog details</DialogDescription>
              </DialogHeader>
              <DialogPanel scrollFade={false}>Content stays inside the panel.</DialogPanel>
              <DialogFooter variant={cornerClose ? "default" : "bare"}>
                <DialogClose render={<Button />}>Dismiss example</DialogClose>
              </DialogFooter>
            </DialogPopup>
          </Dialog>
        );
      }
      await render(<Example />);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      await click(button("Open example"));
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        "Content stays inside the panel.",
      );
      expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-describedby")).toBe(
        document.querySelector('[data-slot="dialog-description"]')?.id,
      );
      expect(document.querySelectorAll('[data-slot="dialog-close"]')).toHaveLength(
        cornerClose ? 2 : 1,
      );
      const close = cornerClose
        ? document.querySelector<HTMLElement>(
            '[data-slot="dialog-popup"] > [data-slot="dialog-close"]',
          )!
        : button("Dismiss example");
      await click(close);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    },
  );

  it("shows uncommitted changes inline and offers to commit them", async () => {
    const onCommit = vi.fn();
    const changes = { state: "dirty", fileCount: 3, committing: false, error: null, onCommit };
    await handoff({ sourceChanges: changes as NonNullable<HandoffProps["sourceChanges"]> });
    const note = document.querySelector('[data-slot="handoff-source-changes"]')!;
    expect(note.textContent).toContain(
      "3 uncommitted files stay on MacBook M4: Git carries commits only.",
    );
    expect(note.closest('[data-slot="handoff-along"]')).not.toBeNull();
    await click(button("Commit for me"));
    expect(onCommit).toHaveBeenCalledOnce();
    await handoff({
      sourceChanges: { ...changes, committing: true } as NonNullable<HandoffProps["sourceChanges"]>,
    });
    expect(button("Committing…").disabled).toBe(true);
    await handoff({
      sourceChanges: { ...changes, onCommit: null } as NonNullable<HandoffProps["sourceChanges"]>,
    });
    expect(document.body.textContent).not.toContain("Commit for me");
    await handoff({
      sourceChanges: { ...changes, state: "clean", fileCount: 0 } as NonNullable<
        HandoffProps["sourceChanges"]
      >,
    });
    // Nothing uncommitted: one checked line says so, with no Commit for me.
    expect(document.querySelector('[data-slot="handoff-source-changes"]')?.textContent).toContain(
      "No uncommitted changes on MacBook M4.",
    );
    expect(document.body.textContent).not.toContain("Commit for me");
  });

  it("saves the machine silently: there is no remember-this-machine control", async () => {
    await handoff();
    expect(document.querySelector('[data-slot="handoff-remember-machine"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Remember this machine");
  });
});

describe("handoff file method and intent", () => {
  const methodRadio = (label: string) => {
    const element = [
      ...document.querySelectorAll<HTMLElement>('[data-slot="handoff-method"] [role="radio"]'),
    ].find((node) => node.closest("label")?.textContent?.includes(label));
    if (!element) throw new Error(`Missing method ${label}`);
    return element;
  };
  // The copy flow shows the method under its own Details, read from the dialog.
  const copyFlow = (
    <div data-testid="copy-flow">
      <FilesTravelChoice />
    </div>
  );

  it("puts how files travel under Details, in the copy flow and the Git move alike", async () => {
    const onMethodChange = vi.fn();
    await handoff({ method: "clone", onMethodChange, copyFlow });
    expect(document.querySelector('[data-testid="copy-flow"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="machine-option"]')).toBeNull();
    expect(document.querySelector('[data-slot="handoff-method"] legend')?.textContent).toBe(
      "How files travel",
    );
    // Download from GitHub is the default and comes first; copying the whole folder is second.
    // The Git-only way is no choice of its own: only an opening that starts on it lists it.
    const labels = [
      ...document.querySelectorAll('[data-slot="handoff-method"] [role="radio"]'),
    ].map((node) => node.closest("label")?.textContent ?? "");
    expect(labels).toHaveLength(2);
    expect(labels[0]).toContain("Download from GitHub (recommended)");
    expect(labels[1]).toContain("Copy the whole folder from ");
    expect(methodRadio("Download from GitHub").getAttribute("aria-checked")).toBe("true");
    expect(() => methodRadio("Continue the coordinator here")).toThrow();
    expect(document.body.textContent).not.toMatch(/\{\w+\}/);
    await handoff({
      method: "folder",
      onMethodChange,
      copyFlow: undefined,
      workspaceContext: { projectFolder: "/Users/me/product" },
    });
    const more = document.querySelector('[data-slot="handoff-more-options"]')!;
    expect(more.textContent).toContain("Details");
    expect(more.querySelector('[data-slot="handoff-method"]')).not.toBeNull();
    // The Workspace locations rows live under Details, not on top of the screen.
    expect(more.querySelector('[data-slot="handoff-workspace-summary"]')).not.toBeNull();
    // Opened on it, it is listed as what it does, so the person can leave it.
    expect(methodRadio("Continue the coordinator here").getAttribute("aria-checked")).toBe("true");
    expect(button("Continue the coordinator on MacBook Pro")).toBeDefined();
    await click(methodRadio("Download from GitHub"));
    expect(onMethodChange).toHaveBeenLastCalledWith("clone");
  });

  it("names the whole-folder way by what it does: Add copies, Sync compares", async () => {
    const from = { sourceLabel: "MacBook" };
    const labels = () =>
      [...document.querySelectorAll('[data-slot="handoff-method"] [role="radio"]')].map(
        (node) => node.closest("label")?.querySelector("span.block")?.textContent ?? "",
      );
    await handoff({ ...from, method: "copy", intent: "copy", onMethodChange: vi.fn(), copyFlow });
    expect(labels()).toEqual([
      "Download from GitHub (recommended)",
      "Copy the whole folder from MacBook",
    ]);
    // A project with no Git remote has nothing to download: the whole folder is the only way.
    await handoff({
      ...from,
      method: "copy",
      intent: "copy",
      onMethodChange: vi.fn(),
      copyFlow,
      wholeFolderOnly: true,
    });
    expect(labels()).toEqual(["Copy the whole folder from MacBook"]);
    await handoff({
      ...from,
      method: "copy",
      intent: "copy",
      onMethodChange: vi.fn(),
      copyFlow,
      wholeFolderOnly: false,
      sync: { machine: "m5", folder: "/Users/sam/atlas" },
    });
    expect(labels()).toEqual(["Download from GitHub (recommended)", "Compare all files…"]);
    expect(document.querySelector("h2")?.textContent).toBe("Sync Product: MacBook and m5");
    expect(document.querySelector('[data-slot="dialog-description"]')?.textContent).toBe(
      "m5 already has this project at /Users/sam/atlas. Compare all files compares the two folders and adds what m5 is missing. The coordinator stays on MacBook.",
    );
    await handoff({
      ...from,
      method: "copy",
      intent: "copy",
      copyFlow,
      sync: { machine: "m5", folder: "/Users/sam/atlas" },
      copyDoneOn: "m5",
    });
    expect(document.querySelector("h2")?.textContent).toBe("Product is in sync on MacBook and m5");
  });

  it("says the copy there fast-forwards to the commits this machine pushes", async () => {
    // Since 1326 a Git move into an existing copy publishes its commits, and the copy there
    // fast-forwards to exactly them in every repository.
    await handoff({ phase: "review", preview: { ...preview, gitSync: true } });
    const review = document.querySelector('[data-slot="handoff-git-review"]')!;
    expect(review.textContent).toContain(
      "MacBook M4 pushes its commits, and Product on MacBook Pro fast-forwards to them in every repository.",
    );
    expect(review.textContent).toContain(
      "Push these commits and continue the coordinator on MacBook Pro.",
    );
    expect(review.textContent).not.toContain("Nothing is pushed");
    expect(document.querySelector('[data-slot="handoff-stale-copy"]')).toBeNull();
  });

  it("holds the move when the copy there cannot fast-forward, until the person says anyway", async () => {
    const onAccept = vi.fn();
    await handoff({
      phase: "review",
      preview: { ...preview, gitSync: true },
      consent: true,
      staleCopy: {
        skipped: {
          reason: "local-commits",
          message: "The copy there was not updated to this machine's commits.",
          repository: "repositories/anton-abyzov/specwithcode",
        },
        accepted: false,
        onAccept,
      },
    });
    const alert = document.querySelector('[data-slot="handoff-stale-copy"]')!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain(
      "MacBook Pro's copy will not be updated to MacBook M4's latest commits",
    );
    expect(alert.textContent).toContain(
      "repositories/anton-abyzov/specwithcode on MacBook Pro has commits MacBook M4 does not have, so it cannot fast-forward.",
    );
    expect(alert.textContent).toContain("Nothing on MacBook Pro is overwritten");
    const primary = [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) =>
      /^Continue the coordinator on /.test(node.textContent ?? ""),
    )!;
    expect(primary.disabled).toBe(true);
    await click(alert.querySelector<HTMLElement>('[role="checkbox"]')!);
    expect(onAccept).toHaveBeenCalledWith(true);
    await handoff({
      phase: "review",
      preview: { ...preview, gitSync: true },
      consent: true,
      staleCopy: {
        skipped: { reason: "dirty", message: "x" },
        accepted: true,
        onAccept,
      },
    });
    const again = [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) =>
      /^Continue the coordinator on /.test(node.textContent ?? ""),
    )!;
    expect(again.disabled).toBe(false);
  });

  it("titles a copy Add and a Git move Continue, and offers no Git-only choice", async () => {
    const onMethodChange = vi.fn();
    await handoff({ method: "copy", intent: "copy", onMethodChange, copyFlow });
    expect(document.querySelector("h2")?.textContent).toBe("Add Product to another machine");
    expect(document.querySelector('[data-slot="dialog-description"]')?.textContent).toBe(
      "From MacBook M4. Nothing on the other machine is replaced without asking.",
    );
    await handoff({
      method: "copy",
      intent: "copy",
      onMethodChange,
      copyFlow,
      copyTargetLabel: "m5",
    });
    expect(document.querySelector("h2")?.textContent).toBe("Add Product to m5");
    // "Continue the coordinator here" does the Git-only move; the copy does not offer it.
    expect(() => methodRadio("Continue the coordinator here")).toThrow();
    expect(document.body.textContent).not.toContain("Git only, no file copy");
    await handoff({ intent: "move", copyFlow: undefined, copyTargetLabel: null, method: "folder" });
    expect(methodRadio("Continue the coordinator here").closest("label")?.textContent).toContain(
      "Always moves the coordinator there.",
    );
    expect(document.querySelector("h2")?.textContent).toBe(
      "Continue the coordinator on MacBook Pro",
    );
  });

  it("titles a finished copy with where the project is and when it got there", async () => {
    await handoff({ method: "copy", intent: "copy", copyFlow, copyDoneOn: "linux-mini" });
    expect(document.querySelector("h2")?.textContent).toBe("Product is on linux-mini");
    const copyDoneAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await handoff({
      method: "copy",
      intent: "copy",
      copyFlow,
      copyDoneOn: "linux-mini",
      copyDoneAt,
    });
    expect(document.querySelector("h2")?.textContent).toBe(
      "Product is on linux-mini (added 2h ago)",
    );
    await handoff({
      method: "copy",
      intent: "move",
      copyFlow,
      copyDoneOn: "linux-mini",
      copyDoneAt,
    });
    expect(document.querySelector("h2")?.textContent).toBe("Product is on linux-mini");
  });

  describe("Send: no Copy or move, the real Main, and the plan", () => {
    const copyAt = (id: string, workspaceRoot: string) => ({ id, workspaceRoot });
    const facts = (over: Record<string, unknown> = {}) => ({
      holding: { kind: "copy" as const, copy: copyAt("p", "/Users/anton/specweave") },
      picked: null,
      onPick: vi.fn(),
      mainLabel: "m4",
      localFiles: 3,
      ...over,
    });
    const text = (slot: string) =>
      document.querySelector(`[data-slot="${slot}"]`)?.textContent ?? null;
    const description = () => text("dialog-description");
    /** The folder copy as the dialog hosts it: the summary and how files travel. */
    const folderCopy = (sourceLabel = "MacBook M4") => (
      <div data-testid="copy-flow">
        <SendSummary move={false} sourceLabel={sourceLabel} targetLabel="m5" />
        <FilesTravelChoice />
      </div>
    );
    const copyTo = (over: Partial<HandoffProps> = {}) =>
      handoff({
        method: "clone",
        intent: "copy",
        onMethodChange: vi.fn(),
        copyFlow: folderCopy(),
        copyTargetLabel: "m5",
        send: facts(),
        ...over,
      });

    it("asks no Copy or move on the folder method: a copy keeps Main where it is", async () => {
      for (const method of ["clone", "copy"] as const) {
        await copyTo({ method });
        expect(document.querySelector('[data-slot="handoff-coordinator"]')).toBeNull();
        expect(document.querySelector("[data-send-choice]")).toBeNull();
        expect(document.body.textContent).not.toContain("Copy or move");
        expect(document.body.textContent).not.toContain("Move to m5");
        expect(document.querySelector("h2")?.textContent).toBe("Add Product to m5");
        expect(text("send-plan")).toBe(
          "Copy 3 changed local files into ~/specweave on m5. The coordinator stays on m4.",
        );
      }
    });

    it("names the real Main in the header, not the machine the dialog opened on", async () => {
      await copyTo();
      expect(description()).toBe(
        "From MacBook M4. The coordinator stays on m4. Nothing on m5 is replaced without asking.",
      );
      // Before a machine is picked there are no send facts: Main is named all the same.
      await copyTo({ send: null, copyTargetLabel: null, mainLabel: "m4" });
      expect(description()).toBe(
        "From MacBook M4. The coordinator stays on m4. Nothing on the other machine is replaced without asking.",
      );
      await copyTo({ mainLabel: null });
      // Nothing in sight names Main: it says so without guessing the source.
      await copyTo({ send: facts({ mainLabel: null }) });
      expect(description()).toBe("From MacBook M4. Nothing on m5 is replaced without asking.");
      expect(text("send-plan")).toContain("The coordinator stays where it is.");
    });

    it("still moves Main with Git only, and says so before the click", async () => {
      await handoff({ method: "folder", onMethodChange: vi.fn(), send: facts() });
      // MacBook Pro already has a copy: nothing is copied, so it reads as making it main.
      expect(document.querySelector("h2")?.textContent).toBe(
        "Continue the coordinator on MacBook Pro",
      );
      expect(description()).toBe(
        "From MacBook M4. The coordinator continues on MacBook Pro. Nothing on MacBook Pro is replaced without asking.",
      );
      expect(document.querySelector('[data-slot="handoff-coordinator"]')).toBeNull();
      expect(document.querySelector('[data-slot="send-existing-copy"]')).toBeNull();
      expect(document.body.textContent).not.toContain("Sync brings it up to date");
      expect(text("send-plan")).toBe(
        "Push this machine's commits, then continue the coordinator in ~/specweave on MacBook Pro. The coordinator continues on MacBook Pro. 3 uncommitted files stay here.",
      );
      await click(button("Continue here"));
      expect(props.onReview).toHaveBeenCalledOnce();
      // The review, where consent is given, keeps the Make-main title and button.
      await handoff({
        phase: "review",
        preview: { ...preview, gitSync: true },
        method: "folder",
        send: facts(),
        consent: true,
      });
      expect(document.querySelector("h2")?.textContent).toBe(
        "Continue the coordinator on MacBook Pro",
      );
      expect(button("Continue here").disabled).toBe(false);
    });

    it("moves nothing to the machine that holds Main", async () => {
      await handoff({
        method: "folder",
        onMethodChange: vi.fn(),
        send: facts({
          holding: { kind: "main", copy: copyAt("p", "/Users/anton/specweave") },
          mainLabel: "MacBook Pro",
        }),
      });
      expect(text("send-existing-copy")).toBe(
        "MacBook Pro already has the coordinator, at ~/specweave.",
      );
      expect(description()).toContain("The coordinator stays on MacBook Pro.");
      expect(button("Continue the coordinator on MacBook Pro").disabled).toBe(true);
      // Nothing to plan: the line above already says there is nothing to move.
      expect(text("send-plan")).toBeNull();
    });

    it("says a source is not linked to the destination's project, and moves no Main", async () => {
      const onMethodChange = vi.fn();
      const send = facts({ otherProject: { main: "m4" } });
      await copyTo({ sourceLabel: "m1", copyFlow: folderCopy("m1"), onMethodChange, send });
      expect(description()).toBe(
        "From m1. m5 has this repository as a separate project (coordinator on m4). Nothing on m5 is replaced without asking.",
      );
      const note = document.querySelector('[data-slot="send-unlinked"]')!;
      expect(note.getAttribute("role")).toBe("note");
      expect(note.textContent).toBe(
        "Only files go into m5's folder. Its coordinator stays on m4. To make them one project, link m1 to it from the machine menu.",
      );
      expect(text("send-plan")).toBe(
        "Copy 3 changed local files into ~/specweave on m5. The coordinator stays on m4.",
      );
      // The Git-only move is no choice here: it would move the coordinator into that project.
      expect(() => methodRadio("Continue the coordinator here")).toThrow();
      // The Git move itself refuses too, whatever led to it, and its way says why.
      await handoff({
        sourceLabel: "m1",
        method: "folder",
        intent: "move",
        copyFlow: undefined,
        copyTargetLabel: null,
        send,
      });
      expect(description()).toContain(
        "MacBook Pro has this repository as a separate project (coordinator on m4).",
      );
      expect(text("send-unlinked")).toContain(
        "The coordinator cannot continue on MacBook Pro: it has this repository as a separate project.",
      );
      expect(text("send-plan")).toBeNull();
      const git = methodRadio("Continue the coordinator here");
      expect(git.getAttribute("aria-disabled")).toBe("true");
      expect(git.closest("label")?.textContent).toContain(
        "Not available: it would move the coordinator into a separate project.",
      );
      expect(button("Continue the coordinator on MacBook Pro").disabled).toBe(true);
      await click(button("Continue the coordinator on MacBook Pro"));
      expect(props.onReview).not.toHaveBeenCalled();
      expect(onMethodChange).not.toHaveBeenCalled();
    });

    it("offers Continue the coordinator on the done screen of a copy into a linked copy", async () => {
      const run = vi.fn();
      const offer = { key: "m5:p", machine: "m5", main: "m4", reason: null, note: null };
      const done = (
        <HandoffCopyDoneActions
          copy={copyStatus("completed") as never}
          mode="copy-only"
          busy={false}
          targetLabel="m5"
          copyAgain={false}
          canCopyAgain={false}
          canTransfer={false}
          canUndo={false}
          undoPreview={null}
          linkReview={false}
          startNewLocked={false}
          onCopyAgain={vi.fn()}
          onTransfer={null}
          onOpen={vi.fn()}
          onUndo={vi.fn()}
          onLink={vi.fn()}
          onStartNew={vi.fn()}
        />
      );
      const finished = (over: Partial<HandoffProps>) =>
        copyTo({ copyFlow: done, copyDoneOn: "m5", ...over });
      const makeMain = () =>
        document.querySelector<HTMLButtonElement>('[data-slot="copy-make-main"]');
      // A first copy, or a copy into another project's copy, has no switch to offer.
      await finished({ makeMain: null });
      expect(makeMain()).toBeNull();
      await finished({ makeMain: { offer: { ...offer, kind: "move" }, run } });
      expect(makeMain()?.textContent).toBe("Continue the coordinator on m5");
      expect(makeMain()?.disabled).toBe(false);
      await click(makeMain()!);
      expect(run).toHaveBeenCalledOnce();
      // Off with the menu's own reason while the switch cannot run.
      const { reason } = unloadedMainText({ machine: "m5", main: "m4" });
      await finished({ makeMain: { offer: { ...offer, kind: "blocked", reason }, run } });
      expect(makeMain()?.disabled).toBe(true);
      expect(makeMain()?.title).toBe(
        reason.text.replace(/\{(\w+)\}/g, (slot, name: string) => reason.values?.[name] ?? slot),
      );
    });

    it("keeps each copy's role among several: the one that is Main takes no move", async () => {
      const onPick = vi.fn();
      const several = {
        kind: "several" as const,
        copies: [copyAt("a", "/Users/anton/a"), copyAt("b", "/Users/anton/b")],
        mainId: "b",
      };
      const git = (over: Record<string, unknown>) =>
        handoff({
          method: "folder",
          onMethodChange: vi.fn(),
          send: facts({ holding: several, mainLabel: "MacBook Pro", ...over }),
        });
      await git({ onPick });
      expect(text("send-existing-copy")).toBe(
        "MacBook Pro has this project in 2 folders. Pick one.",
      );
      expect(text("send-plan")).toBeNull();
      const picker = document.querySelector('[data-slot="send-copy-picker"]')!;
      expect(picker.textContent).toContain("Coordinator");
      await click(
        [...picker.querySelectorAll<HTMLElement>('[role="radio"]')].find((node) =>
          node.closest("label")?.textContent?.includes("~/a"),
        )!,
      );
      expect(onPick).toHaveBeenCalledWith("a");
      await git({ picked: "b" });
      expect(button("Continue the coordinator on MacBook Pro").disabled).toBe(true);
      expect(text("send-plan")).toBe("MacBook Pro already has the coordinator, at ~/b.");
      await git({ picked: "a" });
      // The picked copy is not Main: nothing is copied, Main switches there.
      expect(button("Continue here").disabled).toBe(false);
      expect(text("send-plan")).toContain("continue the coordinator in ~/a on MacBook Pro");
    });
  });

  it("shows no close control and freezes the method while the copy runs locked", async () => {
    const onMethodChange = vi.fn();
    await handoff({ method: "copy", onMethodChange, copyFlow, copyBusy: true });
    expect(() => button("Close")).toThrow();
    expect(document.querySelector('[data-slot="dialog-close"]')).toBeNull();
    await escape();
    expect(props.onOpenChange).not.toHaveBeenCalled();
    await click(methodRadio("Download from GitHub"));
    expect(onMethodChange).not.toHaveBeenCalled();
  });

  it("lets a running copy close unless it locks the dialog for a critical step", async () => {
    const onMethodChange = vi.fn();
    await handoff({
      method: "copy",
      onMethodChange,
      copyFlow,
      copyBusy: true,
      copyLocked: false,
    });
    // Measuring and copying keep running on the machines: closing is allowed,
    // switching the file method is not.
    // The corner X is the only close control.
    expect(
      document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"][aria-label="Close"]')
        ?.disabled,
    ).toBe(false);
    await click(methodRadio("Download from GitHub"));
    expect(onMethodChange).not.toHaveBeenCalled();
    await escape();
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    vi.mocked(props.onOpenChange).mockClear();
    await click(
      document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"][aria-label="Close"]')!,
    );
    expect(props.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    vi.mocked(props.onOpenChange).mockClear();

    await handoff({ copyLocked: true });
    expect(document.querySelector('[data-slot="dialog-close"][aria-label="Close"]')).toBeNull();
    await escape();
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });

  it("goes Back from an unpublished Git review, which discards the preview", async () => {
    const onBack = vi.fn();
    await handoff({ method: "folder", onMethodChange: vi.fn(), phase: "review", preview, onBack });
    expect(document.querySelector('[data-slot="handoff-method"]')).toBeNull();
    await click(button("Back"));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("offers no Back once the checkpoint is published", async () => {
    await handoff({ method: "folder", onMethodChange: vi.fn(), phase: "review", preview });
    expect(() => button("Back")).toThrow();
    expect(document.querySelector('[data-slot="machine-option"]')).toBeNull();
  });
});
