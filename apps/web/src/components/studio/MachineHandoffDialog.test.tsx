// @vitest-environment jsdom
import { act, useState, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MachineHandoffButton, MachineHandoffDialog } from "./MachineHandoffDialog";
import { FilesTravelChoice } from "./ProjectMoveOptions";
import { Tip } from "./shell/Tip";
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
const toggle = (label: string) => {
  const element = [...document.querySelectorAll<HTMLElement>('[data-slot="toggle"]')].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!element) throw new Error(`Missing toggle ${label}`);
  return element;
};
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
    expect(document.querySelector("h2")?.textContent).toBe("Hand off Product");
    expect(document.querySelector('[data-slot="dialog-description"]')?.textContent).toBe(
      "From MacBook M4 to another machine. Nothing there is replaced without asking.",
    );
    expect(radio("MacBook Pro").getAttribute("aria-checked")).toBe("true");
    expect(folderField("MacBook Pro")?.value).toBe("/projects/product");
    expect(props.onMachineChange).not.toHaveBeenCalled();
    await click(radio("Mac Mini"));
    expect(props.onMachineChange).toHaveBeenCalledExactlyOnceWith("m3");
    await handoff({ selected: "m3:project", machine: "m3" });
    expect(radio("Mac Mini").getAttribute("aria-checked")).toBe("true");
    await click(button("Hand off to Mac Mini"));
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
    expect(button("Hand off to Offline machine").disabled).toBe(true);
    await click(button("Hand off to Offline machine"));
    expect(props.onReview).not.toHaveBeenCalled();
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
      "Push these commits to their remotes and continue the project on MacBook Pro.",
    );
    expect(button("Hand off to MacBook Pro").disabled).toBe(true);
    await click(button("Hand off to MacBook Pro"));
    expect(props.onContinue).not.toHaveBeenCalled();
    await click(document.querySelector<HTMLElement>('[role="checkbox"]')!);
    expect(props.onConsent).toHaveBeenCalledWith(true, expect.anything());
    await handoff({ consent: true });
    expect(button("Hand off to MacBook Pro").disabled).toBe(false);
    await click(button("Hand off to MacBook Pro"));
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
      const action = button(phase === "checking" ? "Checking…" : "Handing off…");
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
    ).toEqual(["Cancel", "Hand off to MacBook Pro"]);
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
      "The coordinator now runs on MacBook Pro.",
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
    expect(button("Hand off").disabled).toBe(true);
    expect(document.body.textContent).toContain("Choose a machine above.");
    await click(button("Hand off"));
    expect(props.onReview).not.toHaveBeenCalled();
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
    expect(button("Hand off to Mac Mini").disabled).toBe(true);
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
    expect(button("Hand off to selected machine").disabled).toBe(true);
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
    const control = button("Hand off project");
    expect(trigger).toBe(control);
    expect(control.getAttribute("aria-label")).toBe("Continue this project on another machine");
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
    expect(note.textContent).toContain("3 uncommitted files on MacBook M4.");
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
    expect(document.querySelector('[data-slot="handoff-source-changes"]')!.textContent).toContain(
      "No uncommitted changes on MacBook M4.",
    );
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
  // The copy flow shows the method under its own More options, read from the dialog.
  const copyFlow = (
    <div data-testid="copy-flow">
      <FilesTravelChoice />
    </div>
  );

  it("puts how files travel under More options, in the copy flow and the Git move alike", async () => {
    const onMethodChange = vi.fn();
    await handoff({ method: "copy", onMethodChange, copyFlow });
    expect(document.querySelector('[data-testid="copy-flow"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="machine-option"]')).toBeNull();
    expect(document.querySelector('[data-slot="handoff-method"] legend')?.textContent).toBe(
      "How files travel",
    );
    expect(methodRadio("Copy everything except secrets").getAttribute("aria-checked")).toBe("true");
    await click(methodRadio("Send committed work through Git only"));
    expect(onMethodChange).toHaveBeenCalledExactlyOnceWith("folder");
    await handoff({ method: "folder", onMethodChange, copyFlow: undefined });
    const more = document.querySelector('[data-slot="handoff-more-options"]')!;
    expect(more.querySelector('[data-slot="handoff-method"]')).not.toBeNull();
    expect(methodRadio("Send committed work through Git only").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(button("Hand off to MacBook Pro")).toBeDefined();
    await click(methodRadio("Clone clean repositories from Git"));
    expect(onMethodChange).toHaveBeenLastCalledWith("clone");
  });

  it("titles the dialog by intent and keeps Git for moves only", async () => {
    const onMethodChange = vi.fn();
    await handoff({ method: "copy", intent: "copy", onMethodChange, copyFlow });
    expect(document.querySelector("h2")?.textContent).toBe("Copy Product");
    expect(methodRadio("Send committed work through Git only").getAttribute("aria-disabled")).toBe(
      "true",
    );
    await click(methodRadio("Send committed work through Git only"));
    expect(onMethodChange).not.toHaveBeenCalled();
    await handoff({ intent: "move" });
    expect(document.querySelector("h2")?.textContent).toBe("Hand off Product");
  });

  it("titles a finished copy of files only as copied, and a finished move as on", async () => {
    await handoff({ method: "copy", intent: "copy", copyFlow, copyDoneOn: "ministorm" });
    expect(document.querySelector("h2")?.textContent).toBe("Product is copied to ministorm");
    await handoff({ method: "copy", intent: "move", copyFlow, copyDoneOn: "ministorm" });
    expect(document.querySelector("h2")?.textContent).toBe("Product is on ministorm");
  });

  it("switches the Git move to a files-only copy from the segmented choice", async () => {
    const onIntentChange = vi.fn();
    await handoff({ method: "folder", onMethodChange: vi.fn(), onIntentChange });
    expect(document.querySelector('[data-slot="handoff-intent"]')?.getAttribute("aria-label")).toBe(
      "What to do",
    );
    expect(toggle("Hand off and continue there").getAttribute("aria-pressed")).toBe("true");
    await click(toggle("Copy files only"));
    expect(onIntentChange).toHaveBeenCalledExactlyOnceWith("copy");
  });

  it("shows no close control and freezes the method while the copy runs locked", async () => {
    const onMethodChange = vi.fn();
    await handoff({ method: "copy", onMethodChange, copyFlow, copyBusy: true });
    expect(() => button("Close")).toThrow();
    expect(document.querySelector('[data-slot="dialog-close"]')).toBeNull();
    await escape();
    expect(props.onOpenChange).not.toHaveBeenCalled();
    await click(methodRadio("Send committed work through Git only"));
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
    await click(methodRadio("Send committed work through Git only"));
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
