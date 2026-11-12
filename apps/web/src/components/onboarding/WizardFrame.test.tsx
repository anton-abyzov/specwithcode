// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  escapeLeavesSetup,
  handleWizardEnter,
  primaryForEnter,
  shownStages,
  stageAfter,
  stageBefore,
  WizardFooterSlot,
  WizardStepFooter,
  type WizardStage,
} from "./WizardFrame";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const stages = (access: boolean): readonly WizardStage[] => [
  { id: "connect", label: "Sign in" },
  { id: "agents", label: "Agents" },
  { id: "access", label: "Access", when: access },
  { id: "projects", label: "Projects" },
];

it("builds the bar from the list and leaves a stage out by its condition", () => {
  expect(shownStages(stages(true)).map((stage) => stage.label)).toEqual([
    "Sign in",
    "Agents",
    "Access",
    "Projects",
  ]);
  expect(shownStages(stages(false)).map((stage) => stage.label)).toEqual([
    "Sign in",
    "Agents",
    "Projects",
  ]);
});

it("steps over a stage that is left out, forwards and back", () => {
  expect(stageAfter(stages(true), "agents")).toBe("access");
  expect(stageAfter(stages(false), "agents")).toBe("projects");
  expect(stageBefore(stages(false), "projects")).toBe("agents");
  // A stage hidden while it is open still knows its neighbours.
  expect(stageAfter(stages(false), "access")).toBe("projects");
  expect(stageBefore(stages(false), "access")).toBe("agents");
  expect(stageBefore(stages(true), "connect")).toBeNull();
  expect(stageAfter(stages(true), "projects")).toBeNull();
});

const buttons = () => [...container.querySelectorAll("button")];
const button = (label: string) => buttons().find((b) => b.textContent?.trim() === label);

it("draws Back on the left, then the skip action and the primary with its Enter key", async () => {
  const back = vi.fn();
  const skip = vi.fn();
  const primary = vi.fn();
  await act(async () =>
    root.render(
      <WizardStepFooter
        back={{ onClick: back }}
        skip={{ label: "Keep Supervised", onClick: skip }}
        primary={{ label: "Use Full access", onClick: primary }}
      />,
    ),
  );
  expect(buttons().map((b) => b.textContent?.trim())).toEqual([
    "Back",
    "Keep Supervised",
    "Use Full access",
  ]);
  expect(button("Back")!.closest('[data-slot="wizard-footer-leading"]')).not.toBeNull();
  expect(button("Use Full access")!.closest('[data-slot="wizard-footer-actions"]')).not.toBeNull();
  expect(button("Keep Supervised")!.closest('[data-slot="wizard-footer-actions"]')).not.toBeNull();
  // The key label is a hint for the eye; the button's name stays its label.
  const key = button("Use Full access")!.querySelector("kbd")!;
  expect(key.getAttribute("aria-hidden")).toBe("true");
  expect(key.getAttribute("data-key")).toMatch(/^(↵|Enter)$/);
  expect(document.activeElement).toBe(button("Use Full access"));
  await act(async () => button("Keep Supervised")!.click());
  await act(async () => button("Back")!.click());
  expect([back, skip, primary].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 0]);
});

it("has no Back on the first step", async () => {
  await act(async () =>
    root.render(<WizardStepFooter primary={{ label: "Continue", onClick: vi.fn() }} />),
  );
  expect(buttons().map((b) => b.textContent?.trim())).toEqual(["Continue"]);
});

function SavingStep({ save }: { save: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <WizardStepFooter
      error={error}
      primary={{
        label: busy ? "Saving…" : "Use Full access",
        busy,
        onClick: () => {
          setBusy(true);
          setError(null);
          void save()
            .catch(() => setError("That was not saved. Try again."))
            .finally(() => setBusy(false));
        },
      }}
    />
  );
}

it("lets a step stay open and say why when its primary fails", async () => {
  let fail!: (reason: Error) => void;
  const save = vi.fn(
    () =>
      new Promise<void>((_, reject) => {
        fail = reject;
      }),
  );
  await act(async () => root.render(<SavingStep save={save} />));
  await act(async () => button("Use Full access")!.click());
  expect(button("Saving…")!.disabled).toBe(true);
  expect(container.querySelector("[role=alert]")).toBeNull();
  await act(async () => fail(new Error("no")));
  expect(container.querySelector("[role=alert]")?.textContent).toBe(
    "That was not saved. Try again.",
  );
  expect(button("Use Full access")!.disabled).toBe(false);
});

it("says in the footer why its actions are off", async () => {
  await act(async () =>
    root.render(
      <WizardStepFooter
        note="Setup can be closed once the import finishes."
        back={{ onClick: vi.fn(), disabled: true }}
        skip={{ label: "Do not import projects", onClick: vi.fn(), disabled: true }}
        primary={{ label: "Importing…", onClick: vi.fn(), busy: true }}
      />,
    ),
  );
  expect(container.querySelector("[role=status]")?.textContent).toBe(
    "Setup can be closed once the import finishes.",
  );
  expect(buttons().every((b) => b.disabled)).toBe(true);
});

function Frame({ onPrimary, disabled = false }: { onPrimary: () => void; disabled?: boolean }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <div data-slot="dialog-popup" data-testid="popup" onKeyDown={handleWizardEnter}>
      <WizardFooterSlot slot={slot}>
        <div data-slot="dialog-panel">
          <p tabIndex={-1}>Text</p>
          <input aria-label="Folder" />
          <input type="checkbox" aria-label="Project" />
          <button type="button">Check again</button>
          <a href="#docs">Docs</a>
          <textarea aria-label="Notes" />
          <form onSubmit={(event) => event.preventDefault()}>
            <input aria-label="Pairing link" />
          </form>
          <div className="xterm">
            <input aria-label="Terminal" />
          </div>
          <div data-wizard-keys="off">
            <input aria-label="Terminal drawer" />
          </div>
          <WizardStepFooter primary={{ label: "Continue", onClick: onPrimary, disabled }} />
        </div>
      </WizardFooterSlot>
      <div ref={setSlot} data-slot="wizard-footer-slot" />
    </div>
  );
}

const enter = (target: Element, init: KeyboardEventInit = {}) =>
  act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }),
    );
  });
const field = (label: string) => container.querySelector(`[aria-label="${label}"]`)!;

it("draws the footer in the slot below the panel, out of the scroll", async () => {
  await act(async () => root.render(<Frame onPrimary={vi.fn()} />));
  const primary = button("Continue")!;
  expect(primary.closest('[data-slot="wizard-footer-slot"]')).not.toBeNull();
  expect(primary.closest('[data-slot="dialog-panel"]')).toBeNull();
});

it("presses the primary on Enter from anywhere in the step", async () => {
  const onPrimary = vi.fn();
  await act(async () => root.render(<Frame onPrimary={onPrimary} />));
  await enter(container.querySelector("p")!);
  await enter(field("Folder"));
  await enter(field("Project"));
  await enter(container.querySelector('[data-testid="popup"]')!);
  expect(onPrimary).toHaveBeenCalledTimes(4);
});

it("leaves Enter to a terminal, a form, a button, a link and a text area", async () => {
  const onPrimary = vi.fn();
  await act(async () => root.render(<Frame onPrimary={onPrimary} />));
  await enter(field("Terminal"));
  await enter(field("Terminal drawer"));
  await enter(field("Pairing link"));
  await enter(field("Notes"));
  await enter(button("Check again")!);
  await enter(container.querySelector("a")!);
  // A second line or a shortcut is not the plain key.
  await enter(field("Folder"), { shiftKey: true });
  await enter(field("Folder"), { metaKey: true });
  expect(onPrimary).not.toHaveBeenCalled();
});

it("does nothing on Enter while the primary is off, or from outside the dialog", async () => {
  const onPrimary = vi.fn();
  await act(async () => root.render(<Frame onPrimary={onPrimary} disabled />));
  await enter(field("Folder"));
  expect(onPrimary).not.toHaveBeenCalled();
  const popup = container.querySelector('[data-testid="popup"]')!;
  expect(primaryForEnter(popup, document.body)).toBeNull();
  expect(primaryForEnter(popup, null)).toBeNull();
});

it("leaves setup on Escape from the dialog, and keeps Escape for a terminal", async () => {
  await act(async () => root.render(<Frame onPrimary={vi.fn()} />));
  expect(escapeLeavesSetup(field("Folder"))).toBe(true);
  expect(escapeLeavesSetup(button("Continue")!)).toBe(true);
  expect(escapeLeavesSetup(document.body)).toBe(true);
  expect(escapeLeavesSetup(field("Terminal"))).toBe(false);
  expect(escapeLeavesSetup(field("Terminal drawer"))).toBe(false);
  // The sign-in window and other surfaces outside the dialog keep their own Escape.
  const outside = document.createElement("div");
  outside.append(document.createElement("input"));
  document.body.append(outside);
  expect(escapeLeavesSetup(outside.firstElementChild)).toBe(false);
  // And with nothing focused while such a window is open, the key is not setup's either.
  outside.setAttribute("role", "dialog");
  expect(escapeLeavesSetup(document.body)).toBe(false);
  outside.setAttribute("role", "alertdialog");
  expect(escapeLeavesSetup(document.body)).toBe(false);
  outside.remove();
  expect(escapeLeavesSetup(document.body)).toBe(true);
});
