# Assistant turn rendering: Claude desktop vs Codex desktop

Read-only reverse engineering of the shipped bundles, done 2026-10-12. Nothing in `/Applications` was modified and no extracted code was executed.

## Sources

**Claude desktop** (`/Applications/Claude.app`, asar extracted to `/tmp/re-turns/claude/x`). The asar holds only the Electron shell: `.vite/renderer/main_window` is a 2.3 MB window-chrome bundle (`MainWindowPage-*.css`, fonts), and `.vite/build/mainView.js` loads `https://claude.ai`. **The chat renderer is not in the asar.** It is served remotely from `assets-proxy.anthropic.com/claude-ai/v2/assets/v1/*`. To get evidence, the app's own HTTP cache (`~/Library/Application Support/Claude/Cache/Cache_Data`, read-only) was parsed: bodies were zstd-decoded into `/tmp/re-turns/claude-dec`, and entries cached in the last few days were copied to `/tmp/re-turns/claude-recent`. The main stylesheet is `c6a992d55-Drv_MyUK.css`. The JS chunks are `shared-2` (CDS message primitives), `shared-9` (TurnStatus), `shared-12` (markdown renderer), `shared-13` (assistant message), `shared-14` (compact transcript) and `c1c1ec7b9-*` (Claude Code desktop, internally "epitaxy"). Two surfaces share the same design system (CDS, `data-cds=*`): the classic claude.ai chat and the Claude Code desktop transcript (`.epitaxy-root`).

**Codex desktop** (`/Applications/Codex.app`, asar extracted to `/tmp/re-turns/codex/x`). The renderer is bundled locally in `webview/` (`index.html` + `assets/`).

---

## 1. Turn layout

### Claude

- **User message**: right-aligned bubble. The row is `group/row mb-1 mt-1 flex w-full flex-col items-end`, and the bubble component is CDS `[data-cds=UserMessage]`. Bubble classes: `rounded-[var(--cds-message-bubble-radius)] px-[var(--cds-message-bubble-pad-x)] py-[var(--cds-message-bubble-pad-y)]` + `text-heading font-normal break-words select-text` + `bg-[var(--cds-bg-user-message)]`. Text sits inside `whitespace-pre-wrap` (`data-testid="user-message"`).
  - Tokens (`.cds-root [data-cds=UserMessage]`): `--cds-message-bubble-radius: calc(var(--cds-radius) + .25rem)` = 0.375 + 0.25 = **10px**; `--cds-message-bubble-pad-x: var(--cds-pad-lg)` = **12px**; `--cds-message-bubble-pad-y: var(--cds-pad-md)` = **8px**; `--cds-message-bubble-measure: 85%` (max-width **85%**).
  - A roomier variant also ships: radius `1.5rem`, pad `1rem`/`.75rem`, measure `min(85%, 29.5rem)`.
  - Background: `--cds-bg-user-message: var(--cds-bg-neutral)` → `--cds-alpha-1: hsl(from var(--cds-neutral-900) h s l / 5%)`, so a 5% tint of the text color, theme-aware. Persona tints exist as `color-mix(in oklab, var(--color-blue-400) 10%, transparent)`.
  - Font: `--font-user-message: var(--font-ui)` (Anthropic Sans).
- **Assistant message**: plain, full-width prose, no bubble. Root `data-testid="assistant-message"` / `[data-cds=AssistantMessage]` inside `group/message-row min-w-0`. CDS sets `--cds-assistant-message-text-inset: 4px` and `--cds-assistant-message-text-stop: clamp(0px, (100% - 384px) * .175, 56px)`, so prose gets a small left inset and a right "stop" gutter of up to 56px. Classic chat also adds `pr-8` on p/ul/ol/headings and `pl-[var(--msg-text-inset,0.5rem)]`. An optional `[data-variant=bubble]` assistant style exists but is not the default.
- **Column width**: classic claude.ai uses `max-w-3xl` (768px). Claude Code desktop uses `--max-content-width: var(--chat-column-measure, 768px)`, switchable to `960px` (`[data-transcript-width=m]`) or `1280px` (`[data-transcript-width=l]`).

### Codex

Paths below are under `webview/assets/`.

- **User message**: right-aligned bubble. Wrapper `relative col-start-2 min-w-0 justify-self-end` > `flex w-full flex-col items-end gap-1` (`user-message-*.js`). Bubble: `bg-user-message text-user-message min-w-0 max-w-(--user-chat-width) overflow-hidden break-words px-(--thread-content-margin) py-2.5 rounded-2xl`, with `--user-chat-width:70%`, `--radius-2xl:calc(var(--spacing)*5.5)` and `--thread-content-margin:calc(var(--spacing)*4)` (`user-message-*.css`). That is max-width **70%**, radius **22px**, padding **10px 16px**. Background `--color-background-user-message: color-mix(in oklab, var(--color-text) 5%, transparent)`, a 5% tint of the text color. A compact variant uses `min(456px, 100%)`, radius 16px, padding 12px and `corner-shape: superellipse(1)`.
- **Assistant message**: plain, full-width prose, no bubble (`_MarkdownRoot_*`), capped by the thread column.
- **Column width**: `--thread-content-max-width: 48rem` (**768px**), compact `40rem`, wide blocks `56rem`. Body wrapper `mx-auto w-full max-w-(--thread-body-max-width) px-toolbar`.

---

## 2. Markdown renderer and prose typography

### Claude

- **Library**: a react-markdown-style pipeline (`remarkPlugins`, `rehypePlugins`, `remarkRehypeOptions`, `components`, `urlTransform` props). It is built on micromark/remark/rehype with `hast-util-to-jsx-runtime` in `vendor-markdown-*.js`, plus GFM, KaTeX and a custom `micromark-extension-directive` for `antDirective`. Streaming goes through an in-house progressive renderer (class `progressive-markdown` while streaming, `standard-markdown` once settled; props `isStreaming`, `holdBack`, `useStreamingFadeIn`, `earlySettle`). Code highlighting uses **Shiki**, lazy-loaded (`createHighlighterCore` + `createJavaScriptRegexEngine`). Lowlight is used only in the tiptap composer.
- **Fonts**: `--font-claude-response: var(--font-anthropic-serif)` in classic chat (serif responses) and `var(--font-ui)` (Anthropic Sans) in Claude Code desktop. `--font-mono: var(--font-anthropic-mono)`.
- **Body size**:
  - Classic chat: `.font-claude-response-body{font-size:1rem;line-height:1.5}`, and the message root is `contents font-claude-response leading-[1.65rem]`.
  - Claude Code desktop: `.epitaxy-transcript-typography{--chat-body:.875rem;--chat-leading:1.42857}`, which is 14px/20px. Size S is 13px and size L is 15px/1.46667.
  - Compact surfaces use `--msg-font-size:.8125rem` and `--msg-code-font-size:.75rem`.
- **Paragraph spacing (CDS `.prose`)**: `--_prose-flow: .75em`. Each p/ul/ol/pre/table gets `margin-block-start: var(--_prose-flow)` with end 0. After a heading: `flow * .667`. After a list/table/hr: `flow * 2`. The overview feed uses `--_prose-flow: .5lh`.
- **Headings (CDS `.prose`)**:

  | Level  | Size    | Line-height | Space above  |
  | ------ | ------- | ----------- | ------------ |
  | h1     | 1.75em  | 1.25        | flow × 3     |
  | h2     | 1.375em | 1.25        | flow × 2.5   |
  | h3     | 1.125em | 1.3         | flow × 2     |
  | h4     | 1em     | 1.3         | flow × 1.667 |
  | h5, h6 | .875em  | 1.3         | flow × 1.667 |

  Weight is `--cds-font-weight-bold` = 600. The classic chat components (`Xx` map in `shared-12`) differ: h1 `mt-3 -mb-1 text-[1.375rem] font-bold`, h2 `text-[1.125rem]`, h3/h4 `text-base`, h5 `text-sm`. The Claude Code compact transcript overrides to h2 `1.0625rem`, h3 `.9375rem` and h4/h5 `.875rem`.

- **Lists**:
  - CDS: `:is(ul,ol){padding-inline-start:2em}`, `li{margin-block-start:calc(flow * .333);padding-inline-start:.5em}`. Nested markers are disc → circle → square, and decimal → lower-alpha → lower-roman.
  - Classic: `list-disc flex flex-col gap-1 ps-8 mb-3`, `li` = `whitespace-normal break-words ps-2`, with markers `[&>li::marker]:text-[0.7em]`.
- **Bold**: `b,strong{font-weight:600}`. The variable font axis is `"wght" 530` in dark mode.
- **Inline code (CDS)**: `code:not(pre code){font-family:var(--_prose-font-mono);color:var(--cds-text-danger);background:var(--cds-alpha-1);border:.5px solid var(--cds-border);border-radius:.4em;padding:.0625em .25em;font-size:.9em}`. Classic equivalent: `bg-text-200/5 border-0.5 border-border-300 text-danger-000 rounded-[0.4rem] px-1 py-px text-[0.9rem]`. The text is red/danger-tinted.
- **Code block (CDS)**: `pre{background:var(--cds-bg-neutral);border:.5px solid var(--cds-border-strong);border-radius:calc(var(--cds-radius)*1.5)` (9px)`;padding:.875rem;font-size:.875em;line-height:1.625;tab-size:2}`. Classic: `code-block__code !my-0 !rounded-[var(--msg-block-radius,0.5rem)] !text-sm !leading-relaxed` inside a `rounded-[var(--msg-block-radius)] border-0.5 border-border-300 my-3` frame with a language header (`"{language} code"`).
- **Other elements**: hr is `.5px` top border, `my-3 mx-1.5`. Blockquote is `border-s-4 border-[hsl(var(--border-300)/0.1)] ps-4 text-text-300`. Links use `text-underline-offset:3px` with the decoration at 60% transparent, going solid on hover.

### Codex

- **Library**: unified/remark (micromark) with GFM and a remark-breaks style newline-to-break step, rendered to React by a custom mdast renderer (`allowBasicHtml`, `components`, `streamingTokenKeys`). No react-markdown or streamdown. Code highlighting uses highlight.js; Shiki is used only for diffs.
- **Body**: `--codex-chat-font-size` defaults to `--text-base` = **14px**, line height `14px × 1.625` = **22.75px** (`--leading-relaxed`). Space unit `--markdown-space` = font size / 4 = 3.5px. Code 13px in Electron.
- **Fonts**: `-apple-system-body, ui-sans-serif, -apple-system, system-ui, "Segoe UI", …`; mono `ui-monospace, "SFMono-Regular", "SF Mono", Menlo, …`.
- **Paragraphs**: `margin: 0 0 space`, between paragraphs `space × 4` = **14px**.
- **Headings**: weight 600. h1 1.5× (21px), h2 1.25×, h3 1.125×, h4 1×.
- **Lists**: `padding-inline-start: line-height`, items `space × 1.5`, no gap between items, semibold markers, disc → circle → square.
- **Inline code**: `color-mix(in srgb, ghost-hover 60%, text 6%)` background, radius 6px, padding `1px 6px`, `.92em`, mono. Neutral, not red.
- **Code block**: radius 20px with a subtle border and surface gradient, header `min-h-12 ps-4 pe-1.5 text-sm font-medium` with "Copy code", body `px-4 pb-3`, line height `max(1.5em, 20px)`, outer margin `space × 5`.

---

## 3. Work / tool-activity summary row

### Claude

- **Strings**:
  - Thinking: `"Thought for {seconds}s"`, `"Thought for {minutes}m {seconds}s"`, `"Thought for {hours}h {minutes}m"`, `"Thought process"`, `"Thinking…"`.
  - Tools are aggregated into one sentence-case list, capped at 2–3 phrases: `"Ran"`, `"Read"`, `"Searched"`, `"Edited"`, `"Used {name}"`, `"Used a tool"`, `"Used {count} tools"`. The first phrase is capitalised and the rest are lower-cased.
  - Sub-tasks get `"took {elapsed}"`.
  - **No "Worked for" string exists** anywhere in the cached Claude bundles.
- **Component**: CDS `[data-cds=TurnStatus]`, a Base UI Collapsible (`Ee.Root`) with `[data-cds=TurnStatusStep]` children. Props include `state` (`pending|busy|blocked|done|failed`), `label`, `meta`, `elapsedSeconds`, `stepCount`, `defaultOpen` (defaults to **false**, so it is collapsed) and `mergeBusyStep`.
  - Row: `group/status flex w-full min-w-0 flex-col`. Label: `text-secondary` → `group-hover/status:text-primary`, single line `whitespace-nowrap text-ellipsis`. Steps are `text-muted`, turning `text-secondary` when hovered or open.
  - Indented by `ps-[var(--cds-assistant-message-text-inset)]` (4px), so it aligns with the prose.
- **Classic chat**: the toggle is `data-testid="collapsed-steps-toggle"`: `flex items-center px-3 py-2 flex-1 text-sm`, a `CaretUp` (size sm) icon in `text-muted group-hover/collapse-indicator:text-secondary`, and a vertical timeline rail `grow w-[1px] bg-border` connecting step icons. It uses a rail, not a horizontal divider.
- Timeline text in the compact transcript: `group/timeline-text text-text-300 !font-base`, at `--msg-timeline-font-size: .75rem`.

### Codex

- **Strings**: `Worked for {time}`, `Working for {time}` (after 1s; `Working` before), `You stopped after {time}`, `Thought for {elapsed}`. Activity summaries join plural phrases with `Intl.ListFormat`: "Ran commands", "Read files", "Searched the web", "Edited files", "Called tools"; command rows read `Ran {command} in {elapsed}`. "Explored" appears only in the Markdown export, not the UI.
- **Style**: a ghost button, `text-tertiary` (foreground at 50%), `tabular-nums`, chat font size, with a 14px chevron rotating 0° → 90° over .15s.
- **Divider**: `pt-1` > `w-full border-t border-default` (foreground at 8%) under the row.
- **Collapse**: the activity folds automatically once the final answer starts streaming and stays open while the agent works; a person's choice to open it persists.

---

## 4. Timestamp separators

### Claude

- **No in-transcript day/time separators were found.** Time is shown per message in the action bar as `MessageActions.Timestamp`: a CDS `RelativeTime` with a tooltip (`tooltipSide`, `tooltipTimeZone`).
- Failed sends show `"Not delivered · {time}"`. Its format is `formatTime(d,{timeStyle:"short"})` for today, `{month:"short",day:"numeric"}` for earlier this year, and adds `year` for older messages.
- Elsewhere (schedules) the strings are `"Today at {time}"`, `"Tomorrow at {time}"` and `"{date} at {time}"`, with time `{hour:"numeric",minute:"2-digit"}` and date `{weekday:"short",month:"short",day:"numeric"}`.

### Codex

- **Component**: `flex justify-center py-4 role=separator` > `<time class="text-sm leading-5 font-normal text-tertiary select-none">`, the day part in `font-medium`. Strings `<day>{date}</day> {time}`, and `<day>{date}</day> at {time}` past a week.
- **Format**: "Today" / "Yesterday" (relative, capitalised), the long weekday within 7 days, `{weekday:'short', month:'short', day:'numeric'}` within a year, then with the year. Time `{hour:'numeric', minute:'2-digit'}`.
- **When**: before the first turn if it is over 1 hour old, before a person's message more than 1 hour after the last answer, and between two answers more than 10 minutes apart.

---

## 5. Assistant action bar

### Claude

- **Component**: CDS `MessageActions` (`role="toolbar"`, `data-cds="MessageActions"`) with base classes `flex items-center select-none [&_button]:text-muted [&_button:hover:not([aria-pressed=true])]:text-primary`. The default button size is **`xs`**: `--cds-h-control--xs` 1.25–1.5rem (20–24px), icon `.75–1rem`, radius 5–6px. Buttons are ghost and icon-only.
- **Actions in order** (`shared-13`):

  | Action        | testid                   | Icon                              |
  | ------------- | ------------------------ | --------------------------------- |
  | Copy          | `action-bar-copy`        | `Copy` → check, "Copied"          |
  | Read aloud    | `action-bar-read-aloud`  |                                   |
  | Good response | `action-bar-thumbs-up`   | `ThumbsUp` / `ThumbsUpFilled`     |
  | Bad response  | `action-bar-thumbs-down` | `ThumbsDown` / `ThumbsDownFilled` |
  | Retry         | `action-bar-retry`       | `ArrowClockwise`                  |
  | Overflow      | `action-bar-overflow`    | `DotsHorizontal`                  |

  A version switcher (`< 2/3 >`) and a timestamp are also available. User messages get Edit (`Edit`) and rewind (`ArrowCounterClockwise`, `!text-muted hover:!text-primary`, size xs).

- **Visibility**: revealed on hover. `[data-cds=MessageActions][data-reveal]{--cds-message-actions-opacity:0}` switches to 1 on `.group/message-row:hover` or `:focus-within`. Reveal-in: delay `.1s`, duration `--cds-dur-snap` (.12s), ease `cubic-bezier(.32,.72,0,1)`. Reveal-out: 60ms.
  - `[data-always-visible]` pins the bar, typically on the latest turn (`alwaysVisible` prop).
  - Touch devices (`pointer:coarse`, `hover:none`) always show it.

### Codex

- **Row**: `mt-1.5 flex min-h-5 flex-wrap items-center justify-start gap-0.5 electron:-translate-x-1` (6px above, 2px gaps, pulled 4px left to align icons with the text).
- **Order**: Copy ("Copy response"), Good / Bad response, Fork ("Branch in new chat"), optional extras (hook stats, "Goal achieved in {time}", memories cited), then the time `ms-1.5 text-xs text-tertiary` (today `9:53 PM`, within a week with the weekday, else `Oct 5`).
- **Buttons**: ghost, about 26px (18px icon with 4px padding), `rounded-md` in Electron.
- **Visibility**: `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100`, always visible on the most recent turn (`alwaysShowActions` from `isMostRecentTurn`). User messages have their own hover row with "Copy message" and "Edit message".

---

## 6. Vertical spacing between turns

### Claude

- **Classic chat**: `mt-[var(--msg-gap,1.5rem)]`, so **24px** between turns. The compact variant uses `--msg-gap: .25rem`. The assistant bottom padding is `pb-[var(--msg-assistant-pb,0.75rem)]` (`.375rem` compact). User rows add `mb-1 mt-1`.
- **Claude Code desktop**: `gap-[var(--chat-turn-gap)] pt-[var(--chat-turn-gap)]` on the turn list. `--chat-turn-gap: calc(var(--chat-body) * var(--chat-leading) * .75)` = **15px** at 14px/20px, overridden to `calc(var(--spacing)*5)` = **20px** (16px when compact). Within a turn, `--chat-item-gap` is body × leading × .5 = **10px**. The tail turn is `group/message-row flex w-full flex-col gap-xs`.

### Codex

- The virtualized turn list uses a **12px** gap; inside a turn `flex flex-col gap-3` (12px) separates the work summary, activity and answer. The static transcript uses `gap-4` (16px) per turn with `pt-4 pb-8`.

---

## Recommended for Studio

Both apps agree on the shape: the person's message is a tinted bubble on the right (5% of the text color), the answer is unboxed prose in a ~768px column, work is folded into one muted line above the answer, and the action row under the answer stays visible on the latest turn and appears on hover elsewhere. Studio's thread view (`MessagesTimeline`) already follows this. The coordinator conversation (`apps/web/src/components/studio/CoordinatorConversation.tsx`) did not: it labelled every answer "Coordinator" and had no work line, separators or actions. It now takes:

| Element         | Choice                                                                                                                                                              | From                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Person's bubble | right-aligned, max 70%, radius 22px, padding 10px 16px, `--message-surface`                                                                                         | Codex (Claude's 10px radius reads as a card, not a message)                  |
| Answer          | full-width prose, no bubble, author label visually hidden but kept for screen readers                                                                               | both                                                                         |
| Body text       | 14px, line height 1.625                                                                                                                                             | Codex (Claude Code desktop is 14px/1.43, tighter than the reference)         |
| Work line       | `Worked for {duration}` with a chevron, muted, 8% divider below; opens that run's tool output on the coordinator's page (the full page when the reply names no run) | Codex string and divider; Claude's collapsed-by-default rule                 |
| Time separator  | centered, 13px muted, "Today 9:53 PM" / "Yesterday" / weekday within a week / short date; at the first message and after a pause of 1 hour or a new day             | Codex (Claude has none)                                                      |
| Actions         | copy, then the time with a full-date tooltip; visible on the latest answer, on hover or focus elsewhere, always on touch                                            | both                                                                         |
| Spacing         | 20px between a message and its answer, 28px between turns                                                                                                           | between Codex (12–16px) and Claude (20–24px), leaving room for the work line |

Not adopted: feedback thumbs, retry, read aloud and fork. The coordinator has no rating pipeline, and retry and fork belong to its full thread page, which the work line opens. Claude's serif response font and red inline code were left out in favour of the app's existing `ChatMarkdown` styles, which the thread view already uses.
