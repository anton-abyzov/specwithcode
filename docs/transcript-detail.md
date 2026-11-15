# Transcript detail

What a conversation shows of an agent's work. One rule for web, desktop and iOS; the cases in `packages/shared/src/transcriptDetail.cases.json` encode it, and both `apps/web/src/components/chat/transcriptDetailCases.test.ts` and `apps/ios/SWCKit/Tests/SWCSyncTests/TranscriptDetailCasesTests.swift` run every case. Change the rule here, then the cases, then both clients.

## Two settings, two jobs

- **Replies** (`responseStyle`: Concise or Detailed) tells the agent how to write. It never hides rows.
- **Show** (`timelineDetail`: Results only, Folded steps, Everything) decides which rows the conversation shows. Each device keeps its own default for every thread, and a thread can keep its own level on that device. Nothing about Show is sent to agents or synced between devices.

## The control

One control in the conversation's header holds both, on desktop, web, iOS and Android.

- **Agent replies in this project**: Concise or Detailed. It is the project's setting on every machine that has the project, so it is read-only when this connection may not change settings there, and reads "Mixed" when the project's checkouts disagree. Phones change it only on machines that accept per-key project overrides.
- **Conversation shows**: the three levels, each listed once with its description.
- **Applies to**: This thread or Every thread. A level chosen under "Every thread" is the device's default and this thread follows it. Under "This thread" it is this thread's own. Switching to "This thread" pins the level on screen; switching to "Every thread" drops the thread's own level.

The header button reads "Concise · Folded steps". As the header narrows the reply style goes first, then the level; the button's accessible name always carries both ("Agent replies: Concise. Show: Folded steps (this thread)"), and it is highlighted while the thread has its own level.

On desktop and web ⌥⌘O (Ctrl+Alt+O) moves every conversation on screen to its next level: a thread with its own level moves that level, the others move the default. The toast says which ("Show: Everything", "Show in this thread: Results only"). Settings > Appearance > What threads show and the command palette's "Change what threads show" set the default.

## Rows

| Row                                           | Results only                                       | Folded steps (default)                                  | Everything                                         |
| --------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| Your messages                                 | shown                                              | shown                                                   | shown                                              |
| The turn's reply (its last agent text)        | shown                                              | shown                                                   | shown                                              |
| Notes (agent text before the reply)           | settled: folded; running: only the latest          | settled: folded; running: shown                         | shown                                              |
| Thinking                                      | never, even opened                                 | folded with the steps around it                         | shown                                              |
| Commands, tool calls, edits, searches, agents | folded                                             | folded; on iOS an agent still at work stays visible     | shown                                              |
| A failed step                                 | a "N failed" count on its fold                     | settled: a count on the fold; running: shown on its own | shown                                              |
| The turn's own error                          | shown                                              | shown                                                   | shown                                              |
| Approvals, questions, access requests         | shown (web and desktop: a card above the composer) | shown (web and desktop: a card above the composer)      | shown (web and desktop: a card above the composer) |

## Folds

- A **settled turn** folds all its steps into one row before the reply: "Worked · Ran 2 commands · 4 tool calls".
- A **running turn** keeps its notes in place. In Folded steps each run of two or more consecutive steps is one row ("Used 3 tools" on web, "Worked · …" on iOS); a single step between two notes shows as itself. The run still being worked on is the **live row**: it names the latest step or reads "Working · …", with a spinner, even when it holds one step. In Results only the turn shows its latest note and one live row for all its steps.
- A turn waiting on your approval or answer counts as in progress.
- Tap or click a fold to open its steps; open again to close. Opening is remembered per fold while the turn is in the same state; when a running turn settles, its folds become the one settled fold, closed.
