# Report experience: reading before chrome

October 23, 2026. Increment 1035. Source and fixture work; not installed acceptance.

## What the screenshot actually shows

This is a self-contained HTML attachment published through SpecWithCode's `html_render` MCP tool, not a native Claude hosted artifact and not the Markdown Report reader. The exact retained attachment is `/Users/you/.specwithcode/m4/userdata/attachments/thread-delegated-task-command-3amcp-3a3c51614c-1991-45f1-b868-b911fd0f85fd-3adel-491f0b71-c8c4-4860-a8af-f5a153e914fb-html.html` (2,311,833 characters). Its HTML title is “PS23: season completion, registration and cloning”. It contains the screenshot's exact Winter-draft heading, three working tabs, inline screenshots and evidence links. This is a historical inspection, not a new verification of PS23 data.

The author chose 29px Georgia headings, an 18px serif lead, metadata before the outcome, and a 728px article. The server injects theme/bootstrap code; the stored default is near-black. The client normally posts its current theme. Source inspection and the headless fixture confirmed a mismatch: the shell paints `#262624`, while the HTML hook used the old `#0a0a0a` palette. The fix reads painted CSS semantic tokens and observes appearance changes. Forcing every stored page to a new stylesheet would damage arbitrary dashboards and interactive artifacts.

Generation: MCP HTML tools → HTML preparation/image inlining/theme bootstrap → attachment reference. Rendering: timeline HTML row → HtmlRenderFrame → sandboxed HtmlRenderDocument. The expand button calls the file-open callback, labelled Open in panel. The existing ViewerOverlayHost already supports a spacious reader, Escape, linked-document navigation and an optional conversation. That is the appropriate expansion destination.

## Attribution

The previous project note points to [Ray Amjad's video](https://www.youtube.com/watch?v=IFNum8_oAD8), with retained analysis at `/Users/you/Downloads/e2e-evidence-local/visual-replies-20261021/concept-findings.md`. It describes an attention-saving ladder of writing, diagrams, HTML and video. That is secondary interpretation. No primary Karpathy source establishing this report template was verified. We should describe the idea as choosing the representation that makes a result easiest to understand, not call this a Karpathy report.

## Primary-source comparison

| Approach | Useful here | Decision |
| --- | --- | --- |
| [Claude artifacts](https://academy.claude.com/tutorials/intro-to-artifacts) | Claude describes a dedicated artifact page, sharing and collaboration, in addition to the adjacent panel. | Borrow focused reading, not another crowded sidebar. Hosted artifacts remain a separate account/publishing feature. |
| [Agent SDK custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools) | MCP custom tools expose application capabilities to agents. | Keep this provider-neutral renderer; a Claude harness does not supply a host UI automatically. |
| [Mermaid accessibility](https://mermaid.js.org/config/accessibility.html), [security](https://mermaid.js.org/config/usage.html) | Declarative flow/sequence diagrams; accessible title/description; strict mode disables clickable diagram content. | Use existing Markdown Mermaid for technical diagrams. Do not add a remote runtime for a three-step report flow. |
| [Chart.js accessibility](https://www.chartjs.org/docs/latest/general/accessibility.html) | Quantitative charts, with explicit canvas accessibility and text alternatives required. | Use only for real numerical series; this PS23 explanation is a state transition, not a chart. |
| Semantic HTML / inline SVG | Small flows, no dependency, portable, theme-aware, text accessible. | Chosen for the report example's publication/registration gates. |

The earlier 1019 investigation found experimental native Artifact tool contracts in the installed CLI/SDK, with default-off gates. That research is not proof of live entitlement. Nothing here turns them on, publishes remotely or changes provider permissions.

## Alternatives considered

1. Keep the full page inline and improve its fonts. Preserves direct interaction, but long reports still engulf the conversation and expansion still needs repair.
2. Compact preview → focused reader. Gives the outcome visual space, makes the open action explicit, and preserves the same live document when moved. Chosen.
3. Always split chat and report. Useful for editing, but repeats the crowding the user rejected. Make conversation an explicit optional action.

## Design

Quiet app chrome around an authored page. The preview has a persistent title, type description and Open report button; long content is clipped visibly, with a continuation affordance. Preview content is inert so clipped controls cannot trap keyboard focus. Opening moves the same iframe mount into the existing reader, rather than reloading its tabs or losing local interaction state. Closing returns to the original card and trigger. The conversation is initially folded.

Use the app's semantic background, foreground, border and accent tokens; no new global palette. The example's standalone palette is paper `#ffffff`, ink `#20242b`, muted `#586270`, line `#dce1e8`, blue `#285dc1`, dark surface `#20242b`. System sans for prose and headings; 16px body, 28px title, 20px sections. Left aligned, measured line length, outcome first, facts secondary. A connected publication flow is the one distinctive visual element. No ornamental numbers or charts.

```text
Conversation                       Focused reader
┌ title              Open report ┐ ┌ origin / report             Close ┐
│ outcome preview                │ │                                  │
│ state flow / evidence glimpse  │ │          readable page           │
│                 Open to explore│ │          useful diagram          │
└────────────────────────────────┘ │          evidence / details      │
                                   └──────────────────────────────────┘
```

## Preservation and limits

Historical attachment bytes are unchanged. New generation guidance and an example improve future pages; arbitrary old serif headings are not silently rewritten. The iframe retains its opaque sandbox origin. No additional network library, paid call, live-data change or release is required. The approved release owner integrates the reviewed PR; installed acceptance remains a distinct follow-up.


## Verification receipt

The real HtmlRenderFrame, BrowserDocumentFrame, useHtmlRenderTheme and ViewerOverlayHost run in an isolated Vite fixture. Only asset acquisition and settings inputs are stubbed; no live store or provider session is used. Native SpecWithCode preview automation stayed headless with `open:false`, `show:false`. Evidence is retained at `/Users/you/.specwithcode/m4/worktrees/report-experience-1035/.artifacts/report-experience/evidence.json`.

Four light/dark × desktop/mobile cases (1280×900 and 390×844) each capture the inline card and focused reader. All have one opaque-origin iframe, no horizontal overflow, a folded conversation and matching host/report backgrounds. Keyboard checks cover tab selection, iframe Escape, trigger-focus restoration and skipping inert preview controls. The same original PS23 bytes retain the Cloning tab after close/reopen. A 7,577px report uses the outer scroller and retains scrollTop 2,600 after reopening. An authored document-level Escape preventDefault wins; a live CSS background update reaches the iframe without changing its load identity.

Chrome's [state-preserving moveBefore API](https://developer.chrome.com/blog/movebefore-api) keeps iframe state intact. Engines without this API use ordinary reparenting and may reload the document; that compatibility path does not claim state retention. Historical stored pages have no newly added Escape bridge, so iframe-focused Escape on those pages remains a known limitation. Their toolbar Close and host-focused Escape work. The historical source is not rewritten.

The example is an illustrative authoring pattern, clearly labelled, not a new PS23 audit. The original report's text, screenshots, tabs and evidence remain intact. Source checks and this browser fixture are not installed-app acceptance. No merge or release is performed by this lane.
