// @vitest-environment jsdom
import { act, useState, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MachineHandoffButton, MachineHandoffDialog } from "./MachineHandoffDialog";
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
  { key: "m1:project", label: "MacBook Pro", folder: "/projects/product", unavailable: null },
  { key: "m3:project", label: "Mac Mini", folder: "/projects/product", unavailable: null },
  {
    key: "offline:project",
    label: "Offline machine",
    folder: "/projects/product",
    unavailable: "Connect this machine first.",
  },
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
function radio(key: string) {
  const element = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find(
    (node) =>
      node.getAttribute("data-slot") === "radio" &&
      node.closest("label")?.textContent?.includes(key),
  );
  if (!element) throw new Error(`Missing machine ${key}`);
  return element;
}
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
  it("announces the project and source and selects a destination only on an explicit action", async () => {
    await handoff();
    const popup = document.querySelector('[role="dialog"]')!;
    expect(popup.getAttribute("aria-labelledby")).toBe(document.querySelector("h2")?.id);
    expect(document.querySelector('[data-slot="dialog-description"]')?.textContent).toBe(
      "Move Product forward from MacBook M4.",
    );
    expect(radio("MacBook Pro").getAttribute("aria-checked")).toBe("true");
    expect(props.onSelect).not.toHaveBeenCalled();
    await click(radio("Mac Mini"));
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith("m3:project");
    await handoff({ selected: "m3:project" });
    expect(radio("Mac Mini").getAttribute("aria-checked")).toBe("true");
    await click(button("Review handoff"));
    expect(props.onReview).toHaveBeenCalledOnce();
  });

  it("keeps unavailable destinations unselectable and explains why", async () => {
    await handoff();
    expect(radio("Offline machine").getAttribute("aria-disabled")).toBe("true");
    await click(radio("Offline machine"));
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Connect this machine first.");
    await handoff({ selected: "offline:project" });
    expect(button("Review handoff").disabled).toBe(true);
    await click(button("Review handoff"));
    expect(props.onReview).not.toHaveBeenCalled();
  });

  it("freezes the reviewed destination and requires publication consent before transfer", async () => {
    await handoff({ phase: "review", preview });
    expect(radio("Mac Mini").getAttribute("aria-disabled")).toBe("true");
    await click(radio("Mac Mini"));
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("2 repositories, 8 retained messages");
    expect(document.querySelector("details")?.textContent).toContain("Productabc123456789");
    expect(document.querySelector("details")?.textContent).toContain(
      "repositories/serverdef123456789",
    );
    expect(button("Continue on MacBook Pro").disabled).toBe(true);
    await click(button("Continue on MacBook Pro"));
    expect(props.onContinue).not.toHaveBeenCalled();
    await click(document.querySelector<HTMLElement>('[role="checkbox"]')!);
    expect(props.onConsent).toHaveBeenCalledWith(true, expect.anything());
    await handoff({ consent: true });
    expect(button("Continue on MacBook Pro").disabled).toBe(false);
    await click(button("Continue on MacBook Pro"));
    expect(props.onContinue).toHaveBeenCalledOnce();
  });

  it.each(["checking", "transferring"] as const)(
    "blocks close and repeated actions while %s",
    async (phase) => {
      await handoff({ phase, preview: phase === "transferring" ? preview : null, consent: true });
      expect(document.querySelector('[data-slot="dialog-close"]')).toBeNull();
      expect(button("Close").disabled).toBe(true);
      expect(radio("Mac Mini").getAttribute("aria-disabled")).toBe("true");
      const action = button(phase === "checking" ? "Checking…" : "Transferring…");
      expect(action.disabled).toBe(true);
      await click(button("Close"));
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
      expect(document.querySelector('[role="status"]')?.textContent).toBe(
        phase === "checking"
          ? "Checking code and machine access…"
          : "Transferring code and context…",
      );
    },
  );

  it("allows footer close, corner close, and Escape again after checking finishes", async () => {
    await handoff({ phase: "checking" });
    await escape();
    expect(props.onOpenChange).not.toHaveBeenCalled();
    await handoff({ phase: "choose" });
    await click(button("Close"));
    await click(document.querySelector<HTMLElement>('[data-slot="dialog-close"]')!);
    await escape();
    expect(props.onOpenChange).toHaveBeenCalledTimes(3);
    expect(props.onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("offers the destination coordinator after success without another transfer control", async () => {
    await handoff({ phase: "complete", preview, consent: true });
    expect(document.querySelector("h2")?.textContent).toBe("Handoff ready");
    expect(document.querySelector('[data-slot="dialog-description"]')?.textContent).toContain(
      "MacBook Pro",
    );
    expect(document.querySelector('[role="status"]')?.textContent).toContain("its own checkout");
    expect(document.querySelector('[role="radio"]')).toBeNull();
    expect(document.querySelector('[role="checkbox"]')).toBeNull();
    await click(button("Open coordinator on MacBook Pro"));
    expect(props.onOpenDestination).toHaveBeenCalledOnce();
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it("explains an empty destination list and prevents a review without a target", async () => {
    await handoff({ destinations: [], selected: "" });
    expect(document.body.textContent).toContain("Add this project on another connected machine");
    expect(button("Review handoff").disabled).toBe(true);
    await click(button("Review handoff"));
    expect(props.onReview).not.toHaveBeenCalled();
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
      consent: true,
    });
    expect(document.body.textContent).toContain("1 repository, 8 retained messages");
    expect(button("Continue on selected machine").disabled).toBe(true);
    await handoff({ phase: "complete" });
    expect(document.querySelector('[data-slot="dialog-description"]')?.textContent).toContain(
      "the destination",
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
    const control = button("Handoff");
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
});
