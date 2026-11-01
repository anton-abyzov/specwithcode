import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

interface HostProps {
  readonly children?: ReactNode;
  readonly accessibilityLabel?: string;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly style?: { readonly maxHeight?: number };
}

function host(tag: "div" | "button" | "span") {
  return function Host(props: HostProps) {
    const Tag = tag;
    return (
      <Tag
        aria-label={props.accessibilityLabel}
        className={props.className}
        data-disabled={props.disabled ? "true" : undefined}
        data-max-height={props.style?.maxHeight}
      >
        {props.children}
      </Tag>
    );
  };
}

vi.mock("react-native", () => ({
  Pressable: host("button"),
  ScrollView: host("div"),
  Text: host("span"),
  View: host("div"),
}));
vi.mock("../../components/AppText", () => ({ AppText: host("span") }));
vi.mock("../../lib/cn", () => ({
  cn: (...classes: ReadonlyArray<string | false | null | undefined>) =>
    classes.filter(Boolean).join(" "),
}));

import type { RuntimeRequestId } from "@specweave-studio/contracts";

import type { PendingApproval } from "../../lib/threadActivity";
import { PendingApprovalCard } from "./PendingApprovalCard";

const REQUEST_ID = "req-1" as RuntimeRequestId;

function approval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    requestId: REQUEST_ID,
    requestKind: "command",
    createdAt: "2026-10-31T00:00:00Z",
    detail: "cat <<'EOF'\nhello\nEOF",
    responseCapability: "live",
    ...overrides,
  };
}

function render(
  value: PendingApproval,
  options: {
    readonly pendingCount?: number;
    readonly responding?: boolean;
    readonly canOperateThread?: boolean;
  } = {},
): string {
  return renderToStaticMarkup(
    <PendingApprovalCard
      canOperateThread={options.canOperateThread ?? true}
      approval={value}
      {...(options.pendingCount !== undefined ? { pendingCount: options.pendingCount } : {})}
      respondingApprovalId={options.responding ? REQUEST_ID : null}
      onRespond={async () => {}}
    />,
  );
}

function buttonLabels(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>(?:<span[^>]*>)?([^<]*)/g)].map((match) => match[1]!);
}

describe("PendingApprovalCard", () => {
  it("titles the card by kind when no app is named", () => {
    expect(render(approval())).toContain(">Command approval<");
    expect(render(approval({ requestKind: "file-read" }))).toContain(">File read approval<");
    expect(render(approval({ requestKind: "permission" }))).toContain(">App permission approval<");
    expect(render(approval({ requestKind: "mcp-elicitation", appName: "Linear" }))).toContain(
      ">Linear<",
    );
  });

  it("shows the command monospaced in a bounded well", () => {
    const html = render(approval());
    expect(html).toMatch(/data-max-height="140"/);
    expect(html).toMatch(/aria-label="Command"/);
    expect(html).toMatch(/class="font-mono[^"]*"[^>]*>cat &lt;&lt;&#x27;EOF&#x27;/);
  });

  it("shows the file path for a file change", () => {
    const html = render(
      approval({
        requestKind: "file-change",
        detail: undefined,
        fileChange: { fileName: "src/app.ts" },
      }),
    );
    expect(html).toContain(">File change approval<");
    expect(html).toMatch(/aria-label="File path"/);
    expect(html).toContain(">src/app.ts<");
  });

  it("counts other pending approvals", () => {
    expect(render(approval(), { pendingCount: 3 })).toContain(">1 of 3<");
    expect(render(approval(), { pendingCount: 1 })).not.toContain("1 of");
    expect(render(approval())).not.toContain("1 of");
  });

  it("stacks accept first and leaves cancel as a quiet last button", () => {
    const html = render(
      approval({
        options: [
          { decision: "cancel", label: "Cancel" },
          { decision: "decline", label: "Decline", warning: "Stops the run" },
          { decision: "accept", label: "Approve", warning: "Runs a network call" },
          { decision: "acceptForSession", label: "Always allow this session" },
        ],
      }),
    );
    expect(buttonLabels(html)).toEqual([
      "Approve",
      "Always allow this session",
      "Decline",
      "Cancel",
    ]);
    expect(html).toMatch(/Approve<\/span><\/button><span[^>]*>Runs a network call/);
    expect(html).toMatch(/Decline<\/span><\/button><span[^>]*>Stops the run/);
    expect(html).toMatch(/<button[^>]*class="[^"]*bg-transparent[^"]*"[^>]*><span[^>]*>Cancel/);
  });

  it("defaults to Approve, Always allow this session and Decline", () => {
    expect(buttonLabels(render(approval()))).toEqual([
      "Approve",
      "Always allow this session",
      "Decline",
    ]);
  });

  it("disables every button when the request is not live or already answering", () => {
    for (const html of [
      render(approval({ responseCapability: "not_resumable" })),
      render(approval(), { responding: true }),
      render(approval(), { canOperateThread: false }),
    ]) {
      const buttons = html.match(/<button[^>]*>/g) ?? [];
      expect(buttons).toHaveLength(3);
      for (const button of buttons) expect(button).toContain('data-disabled="true"');
    }
    expect(render(approval({ responseCapability: "not_resumable" }))).toContain(
      "no longer available",
    );
    for (const button of render(approval()).match(/<button[^>]*>/g) ?? []) {
      expect(button).not.toContain("data-disabled");
    }
  });
});
