# Thread status in SpecWithCode

| Group          | Meaning                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Waiting on you | A current approval, unanswered question, sign-in, proposed plan, held queue, or explicit decision in the latest report needs the person. |
| Working        | A turn or a child has current execution evidence.                                                                                        |
| Waiting        | Work depends on CI, a review, a PR merge, subagents, or background work. The row names the dependency.                                   |
| Unavailable    | The host cannot provide current state.                                                                                                   |
| Idle           | No current execution, dependency wait, or user request is known. A failed run keeps its failure label.                                   |
| Resolved       | The conversation is settled.                                                                                                             |

A dependency never adds to the user-attention count or creates an input notification. A genuine unanswered child request still does. Expand a row's requests to open the child that owns the current card.

The subagent chip's total includes history. Its breakdown distinguishes working, queued, waiting on work, completed, failed, stopped, interrupted, unknown, and requests for the person. Only running execution counts as working. An unreachable child stays unknown.

Terminal native-child receipts carry their completion time into the shell summary. They suppress stale roots, while a newer child execution stays visible. The same verdict drives the collapsed list, header chip, and expanded child list.

An answer applies to every update-restored copy of that same request. Answered copies no longer drive attention or current question cards. Different questions and approvals remain separate. Historical reports and receipts are retained.

Pending coordinator requests are live controls, not paged history. The bounded thread snapshot retains their approval/question cards as dependencies even if their original turn lies outside the current history window. Answer receipts from a restored request's family travel with it, so the same pending-request derivation can suppress answered copies. Dependencies do not move history cursors or inflate visible rows. The Threads summary explicitly breaks an actionable total into coordinators and workers when a coordinator is included; worker group counts remain counts of worker rows.

The subagent popup scopes to the selected thread's lineage subtree and that thread's own workflow records, across all runs. Known projection records belonging to another thread or conflicting with a known child's lineage are excluded; native/app-owned copies of the same child share one entry. Current and recent work is first: user input, live/queued/dependency work, unknown state, then work finished within 30 minutes. Entire ancestry branches move together, so a completed parent never hides an active descendant. Older terminal branches stay under collapsed History, ordered newest first. Counts include both sections; workflow/subagent kinds stay explicit. Switching threads remounts the popup and collapses history. No runtime state or Stop hold changes.
