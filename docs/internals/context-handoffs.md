# Context handoffs

Portable provider and fork handoffs are textual summaries. They do not claim native provider context
parity.

`ContextHandoffServiceV2` includes user messages, assistant messages, command executions, file
changes, checkpoints, and prior handoffs. It skips other turn item types. For text-bearing items,
`compactText` replaces every whitespace run with one space, trims the result, and returns at most
240 characters. A truncated value contains the first 237 characters followed by `...`. File changes
carry the filename, while checkpoints carry only the number of files.

Provider handoffs use either the full eligible app history or the delta since that provider last
participated. Fork merge-back handoffs summarize eligible delta items from the child. Neither path
reconstructs provider-native session state, tool state, approvals, or omitted text.

Legacy v1 continuation uses a separate algorithm. It considers only user and assistant messages,
walks backward from the newest message, and builds a transcript suffix within a 32,000-character
budget. Do not describe that migration budget as the limit for portable handoffs, and do not describe
the 240-character prefix as a migration rule.

## Pointer handoffs

A handoff never has to carry the whole conversation. Each one names where the receiving agent can
rebuild what it leaves out: `studio_thread_read` for the app's thread history, and the paths of
every native Claude Code and Codex transcript the thread ran on this machine
(`~/.claude/projects/<cwd slug>/<session id>.jsonl`, `~/.codex/sessions/YYYY/MM/DD/rollout-*-<thread
id>.jsonl`, in any configured provider home). `AgentSessionScanner.locateSession` finds them by
listing file names only; transcript contents are read by the receiving agent, locally, when it needs
them.

Two rules keep a handoff from dead-ending on context size:

- Returning to a provider whose resumed native session has no room for the handoff
  (`nativeSessionTooFullForHandoff`) starts a fresh native session instead, with a full-thread
  handoff. The old session stays on disk and is one of the pointers.
- When no history item fits the delivery budget, the handoff still goes out as a pointer only (no
  items, the recovery marker and the transcript paths), within `POINTER_HANDOFF_FLOOR` bytes.
  `ContextHandoffBudgetError` remains only for a pointer that cannot fit even that floor.
