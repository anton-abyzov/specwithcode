import {
  ASSISTANT_CITATION_MAX_COMMENT_LENGTH,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@specweave-studio/contracts";
import { act, useState, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";

const mocks = vi.hoisted(() => ({ observeSource: vi.fn(), dispose: vi.fn(), navigate: vi.fn() }));
vi.mock("./AssistantCitationSource", () => ({
  observeAssistantCitationCommentSource: mocks.observeSource,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  Link: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <a onClick={onClick}>{children}</a>
  ),
}));
// Keep the real chip/editor lifecycle while replacing DOM positioning and floating layers.
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  PopoverPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../ui/button", () => ({
  Button: (props: React.ComponentProps<"button">) => <button {...props} />,
}));

import { ProjectMessageRoutingContext } from "../../studio/projectMessageRouting";
import { PopoverPopup } from "../ui/popover";
import { AssistantCitationChip } from "./AssistantCitationChip";

const citation = {
  version: 1 as const,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("source"),
  text: "hello",
  start: 0,
  end: 5,
  prefix: "",
  suffix: "",
};
// The observer owns DOM access; these identities let us check which anchor survives.
const sourceAnchor = {
  source: {},
  range: {},
  viewport: {},
} as AssistantCitationSourceAnchor;

let renderer: ReactTestRenderer;

function mount(onSave = vi.fn(() => true)) {
  function Composer() {
    const [open, setOpen] = useState(true);
    return (
      <AssistantCitationChip
        citation={citation}
        commentEditor={{ open, sourceAnchor, onOpenChange: setOpen, onSave }}
      />
    );
  }
  act(() => {
    renderer = create(<Composer />);
  });
  return onSave;
}

function typeComment(value: string) {
  act(() => renderer.root.findByType("textarea").props.onChange({ currentTarget: { value } }));
}

function removeSource() {
  const { onUnavailable } = mocks.observeSource.mock.lastCall![0];
  act(() => onUnavailable());
}

function clickButton(label: string) {
  act(() =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.props.children === label)!
      .props.onClick(),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.observeSource.mockReset().mockReturnValue(mocks.dispose);
  mocks.dispose.mockClear();
});

afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("citation comment source disappearance", () => {
  it("preserves an over-length draft at the composer until it can be shortened and saved", () => {
    const onSave = mount();
    const draft = "x".repeat(ASSISTANT_CITATION_MAX_COMMENT_LENGTH + 1);
    typeComment(draft);
    removeSource();

    expect(renderer.root.findByType("textarea").props.value).toBe(draft);
    expect(renderer.root.findByType("textarea").props["aria-invalid"]).toBe(true);
    expect(renderer.root.findByType(PopoverPopup).props.anchor).toBeUndefined();
    expect(renderer.root.findByType(PopoverPopup).props.side).toBe("top");
    expect(onSave).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalled();
    expect(mocks.observeSource).toHaveBeenCalledTimes(1);

    typeComment("shortened comment");
    clickButton("Save");
    expect(onSave).toHaveBeenCalledWith("shortened comment");
    expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
  });

  it("preserves a rejected save and allows a later retry", () => {
    const onSave = mount(vi.fn(() => false));
    typeComment("keep this draft");
    removeSource();

    expect(onSave).toHaveBeenCalledWith("keep this draft");
    expect(renderer.root.findByType("textarea").props.value).toBe("keep this draft");
    expect(renderer.root.findByType(PopoverPopup).props.anchor).toBeUndefined();
    onSave.mockReturnValue(true);
    clickButton("Save");
    expect(onSave).toHaveBeenLastCalledWith("keep this draft");
    expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
  });

  it("still allows explicit cancellation after source disappearance", () => {
    const onSave = mount(vi.fn(() => false));
    typeComment("discard this draft");
    removeSource();
    onSave.mockClear();
    clickButton("Cancel");
    expect(onSave).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
  });

  it("saves and closes when the source disappears with a valid draft", () => {
    const onSave = mount();
    typeComment("saved comment");
    removeSource();
    expect(onSave).toHaveBeenCalledWith("saved comment");
    expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
  });
});

const openThread = vi.fn(() => true);
const routing = {
  coordinatorThreadId: null,
  send: async () => undefined,
  openCoordinator: () => undefined,
  openThread,
};

describe("opening the cited passage", () => {
  const click = () => {
    const preventDefault = vi.fn();
    act(() => renderer.root.findByType("a").props.onClick({ button: 0, preventDefault }));
    expect(preventDefault).toHaveBeenCalled();
  };
  beforeEach(() => {
    mocks.navigate.mockReset();
    openThread.mockClear();
  });

  it("opens the thread in the project's right panel at the passage", () => {
    act(() => {
      renderer = create(
        <ProjectMessageRoutingContext.Provider value={routing}>
          <AssistantCitationChip citation={citation} />
        </ProjectMessageRoutingContext.Provider>,
      );
    });
    click();
    expect(openThread).toHaveBeenCalledWith(citation.threadId, citation.environmentId, {
      hash: expect.stringMatching(/^assistant-citation=/),
      state: { assistantCitationActivation: expect.any(String) },
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("opens the thread full page outside a project", () => {
    act(() => {
      renderer = create(<AssistantCitationChip citation={citation} />);
    });
    click();
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/$environmentId/$threadId",
        hash: expect.stringMatching(/^assistant-citation=/),
      }),
    );
  });
});
