# Transcript detail

What a conversation shows of an agent's work. One rule for web, desktop and iOS; the cases in `packages/shared/src/transcriptDetail.cases.json` encode it, and both `apps/web/src/components/chat/transcriptDetailCases.test.ts` and `apps/ios/SWCKit/Tests/SWCSyncTests/TranscriptDetailCasesTests.swift` run every case. Change the rule here, then the cases, then both clients.

## Two settings, two jobs

- **Replies** (`responseStyle`: Concise or Detailed) tells the agent how to write. It never hides rows.
- **Show** (`timelineDetail`: Results only, Folded steps, Everything) decides which rows the conversation shows. Desktop and web keep it per browser, with a per-thread override; the phone keeps its own. The header reads both, for example "Replies: Concise · Folded steps".

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
