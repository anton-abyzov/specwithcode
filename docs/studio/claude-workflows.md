# Native Claude workflows

SpecWithCode's native Claude workflow policy is separate from reasoning effort:

- **Disabled** removes workflow preapprovals and denies the Workflow tool. A native disable flag also prevents advanced launch settings from enabling it.
- **On request** keeps workflows available for explicit requests and saved workflow commands. Existing native permission checks still approve or deny each launch.
- **Automatic** enables Claude's ultracode orchestration setting for threads that leave the Ultracode toggle unset. It preserves the selected reasoning effort and native permission policy.

## Ultracode toggle

Claude Code models that support Ultracode (those with Extra High effort, such as Opus 5.5) show an **Ultracode** toggle in the model's traits menu, next to reasoning effort. The composer then reads, for example, "Opus 5.5 · Medium · Ultracode". The toggle sends Claude Code's `ultracode` session setting, which keeps the chosen effort.

- An explicit On or Off wins over the workflow mode, except that **Disabled** always turns Ultracode off, because Claude Code needs workflows for it.
- Left unset, it follows the mode: on in Automatic, off otherwise.
- Older selections that stored "Ultracode" as the effort read as Extra High with Ultracode on, which is how they ran.
- Left unset, the menu marks neither choice and says it follows the workflow mode.
- Ultracode is launch context, like the workflow mode: an idle query reopens with resume when the effective value changes, and a running background workflow keeps the value it started with until it settles.

Environment and project instructions are additive. SpecWithCode includes mandatory runtime rules, both instruction additions, and attached SpecWithCode MCP guidance in the main system append and the documented `--append-subagent-system-prompt` flag. The native agent's default system prompt and user/project/local Claude configuration remain enabled. A main SDK system append alone does not reach workflow workers.

Existing inline or file-based worker prompt additions are preserved in that compiled context. SpecWithCode reads a configured file relative to the project directory, limits it to 256 KiB, and passes one inline append; it never sends the conflicting inline and file flags together. Read failures report a fixed error without file contents.

Changing effective instructions or workflow policy changes the native query identity. An idle query is reopened with fresh instructions; an active native background workflow blocks replacement until it settles or the user stops it. System prompt snapshots are disabled so a resumed session uses the current instructions rather than its first prompt.

Only actual user messages originating from SpecWithCode web or mobile are stamped as human input. Scheduled tasks, peer messages and other relayed text retain their original provenance. Claude's keyword trigger can therefore distinguish a typed `ultracode` prompt from relayed content. An explicit “use a workflow” request remains the route for programmatic smoke tests.

Native workflow tasks remain on the provider thread's background roster after the lead's first result. The roster displays native phase/worker progress and clears on a native completion, failure or stop notification. SpecWithCode does not invent agent identities or pause/resume handles that the current SDK does not expose.

The native path uses Claude Code authentication. Anthropic Managed Agents beta workflows use a separate API-authenticated executor; a subscription session is not an API credential.

## Local candidate

`specweave-studio-workflows` starts a separate local candidate and prints its loopback URL. Open that URL, then Settings → Agents. The command does not open a browser automatically. Its default profile is `~/.local/share/specweave-studio-workflow-candidate`; projects and settings in the regular SpecWithCode profile are separate.

The installed candidate is retained under `~/.local/share/specweave-studio-workflows/releases/`, including its web client and runtime dependencies. Its launcher does not depend on a development worktree. The regular `specweave-studio` command continues to select the regular installation.

## Bounded native verification

Run with Node 22.20, the installed SpecWithCode SDK and an authenticated private Claude executable:

```sh
node scripts/studio-verify/claude-workflows.mjs --help
node scripts/studio-verify/claude-workflows.mjs --run --output-dir /absolute/new/scratch-directory
```

The runner uses the production workflow policy compiler, one saved two-worker workflow, restricted tools, disabled fixture hooks and a maximum $0.25 estimated query budget. It verifies actual native worker journal results against the runtime result file for environment, project, project-file and mandatory browser instructions. Existing authentication is read by Claude and never copied; no live SpecWithCode store is opened. The receipt proves this bounded native run, not SpecWithCode UI acceptance, capacity or Managed Agents API access.
