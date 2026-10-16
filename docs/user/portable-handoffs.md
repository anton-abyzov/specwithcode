# Context in portable handoffs

SpecWithCode transfers conversation context when you switch providers, continue through a portable
restart, or use a fork that the provider cannot resume itself.

Short conversations transfer intact. For longer conversations, SpecWithCode favors recent requests and
answers, the original request, and relevant activity such as command outcomes. Selected messages
keep their full text, order, and user or assistant role, including partial work from failed or
interrupted turns. Your new request stays separate and is never shortened to make history fit.

Codex receives historical messages directly when its installed version supports that operation.
Other providers receive the same selection as attributed conversation context. A handoff does not
copy the outgoing provider's reasoning, tool-call state, or attachments.

The handoff includes references to omitted history. The agent can use SpecWithCode's thread-reading tool
to retrieve saved messages and activity, including the remainder of a long item. For an important
constraint, you can still repeat it in your next message. A handoff is a budgeted selection, not an
agent-written summary.

## Two Claude accounts

Moving a thread between two Claude instances with different config homes (two subscriptions) does
not go through a handoff. SpecWithCode copies the native session, `projects/<folder>/<session>.jsonl` and
its subagent folder, from the home that ran it last into the other home and resumes it there, so
the whole conversation, tool state included, carries over. Switching back copies the newer
transcript back. The provider's prompt cache belongs to the account, so the first turn after a
move is uncached either way. When the transcript cannot be found, the switch falls back to the
budgeted handoff described above.

## Context limits

A handoff must leave room for existing provider context, your request and attachments, instructions,
tools, and subsequent work. If even its retrieval references cannot fit, SpecWithCode reports an error
instead of shortening your request. Compact the target conversation or select a larger-context
model before trying again.

Server operators can set `STUDIO_CONTEXT_HANDOFF_TOKEN_CAP` to change the initial history allowance
(default 16,000; clamped to 1,024–64,000). This is an upper bound, not a provider context-window
guarantee. Text accounting conservatively charges one token per UTF-8 byte, including attribution
and JSON escaping. Imported history has a separate 64,000-byte ceiling; your current input and
attachment payloads do not consume that ceiling.

SpecWithCode uses available capacity information for your selected model and options, together with
provider context telemetry. Starting a fresh provider conversation clears prior usage, while keeping
known model capacity. Changing models or context-window options discards stale usage and compaction
thresholds.

When no capacity information is available, SpecWithCode assumes a 128,000-token window. It reserves at
least 16,000 tokens, or a quarter of the window when larger, for instructions, tools, and subsequent
work. Images reserve an estimated 8,192 tokens each, independent of their file size; other
attachments reserve 4,096 each for their references. Existing context is estimated from saved
activity when usage telemetry is unavailable. Known smaller windows still constrain the handoff.
These are fallback estimates, not exact token counts. Image resolution, custom models, and hidden
native context can differ, so the provider may still reject an input.

## Moving a project between machines

A project keeps one logical identity across machines. Each machine can have one or more saved
execution folders for that project. In **Handoff**, choose the machine and its saved folder, or
expand **Choose another folder on a machine** to browse that machine's filesystem and save an
existing checkout. The folder must contain the same umbrella repository. Selecting a folder does
not move work yet; **Review handoff** checks the source and destination before transfer.

New handoffs advance the chosen folder and its nested repositories in place. They do not create
another project checkout under the application's data directory. The destination must be clean,
not ahead of or diverged from the transferred commits, and free of conflicting active work.
Ignored files are preserved; an incoming tracked file that would overwrite one stops the move.
Commit or otherwise preserve local changes before trying again. Both machines must support
handoff into a saved project folder.

Temporary transfer folders are omitted from the destination picker. Older transfers retain their
original recovery path and history. An unpublished old preview can be restarted to choose a saved
folder; a transfer already published must be recovered before beginning another. Application data
still stores private conversation context and recovery receipts, separate from source code.
