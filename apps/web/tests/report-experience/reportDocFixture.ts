// A saved report as `studio_report_save` writes it: flat frontmatter with a
// thread id, its title and an ISO save time, then a wide table, code and a
// Mermaid diagram. Used by `/report-doc.html`; synthetic, no live state.
export const REPORT_DOC_PATH =
  "/Users/fixture/work/atlas/.specweave/reports/threads/2026-11-24-review-of-pr-877.md";
export const LINKED_DOC_PATH =
  "/Users/fixture/work/atlas/.specweave/increments/0042-season/spec.md";

export const REPORT_DOC = `---
title: "Review of PR 877, Suggestion clipboard fix"
thread: "thread:delegated-task:command%3Amcp%3A50ade8c8%3Adelegate-task%3Areview-pr877"
threadTitle: "Review PR 877 suggestion clipboard"
savedAt: "2026-11-24T16:16:00.739Z"
head: afa860030f4789c75f5319252ee4aac1d4f2357a
reviewer: Claude Opus 5.5 (cross-family; author is an OpenAI model)
date: November 24, 2026
verdict: ship once the PR Gate runs for real (undraft); no code fix required
---

# PR 877 review at \`afa86003\`

## Verdict

The code is right: ship it. Every case the prior round asked for behaves correctly against the real \`remark-parse@11.0.0\` parser. See the [increment spec](${LINKED_DOC_PATH}) and the [plan](../../increments/0042-season/plan.md).

## Scope

| File | Change | Risk | Owner | Tests | Notes |
|---|---|---|---|---|---|
| \`apps/web/src/components/chat/MessageCopyButton.tsx\` | \`unwrapQuotedReply\` plus opt-in \`copyQuotedReply\` prop | Low | Web | 14 new | Quote markers stripped only on assistant copies |
| \`apps/web/src/components/chat/MessagesTimeline.tsx\` | assistant copy button opts in (line 3587) | Low | Web | covered | — |
| \`apps/web/src/components/studio/CoordinatorConversation.tsx\` | coordinator copy opts in for \`role === "assistant"\` (lines 1376-1381) | Medium | Studio | 3 new | Needs the PR Gate to run for real |
| \`apps/web/package.json\`, \`pnpm-lock.yaml\` | \`remark-parse\` added, \`unified\` moved from dev to runtime deps | Low | Build | lockfile | Reviewed lock change recorded |

## Flow

\`\`\`mermaid
flowchart LR
  Copy[Copy button] --> Unwrap{Quoted reply?}
  Unwrap -- yes --> Strip[Strip quote markers]
  Unwrap -- no --> Keep[Copy as written]
  Strip --> Clipboard
  Keep --> Clipboard
\`\`\`

## How the function works

\`\`\`ts
export function unwrapQuotedReply(markdown: string): string {
  const tree = unified().use(remarkParse).parse(markdown);
  return tree.children.every((node) => node.type === "blockquote") ? stripQuotes(markdown) : markdown;
}
\`\`\`

- [x] Real parser, not a regex
- [x] Nested quotes keep their inner markers
- [ ] PR Gate ran on a non-draft head
`;

export const LINKED_DOC = `---
title: Season registration and payments
status: active
---

# Season registration and payments

Families register players for the season and pay online.

## Acceptance criteria

- [x] AC-01: A family registers two players in one checkout.
- [ ] AC-02: A refund reaches the card within five days.
`;
