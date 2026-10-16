# Managed Agents dynamic workflows beta

SpecWithCode provides a separate, explicit Anthropic API path for text workflows:

```sh
specweave-studio managed-agents status --config managed-agents.json
specweave-studio managed-agents run --beta --config managed-agents.json --prompt-file task.txt --receipt run.json
```

Set `ANTHROPIC_API_KEY` in the process environment. Claude Code subscription login does not authenticate this API. The existing environment must belong to that API account. SpecWithCode neither creates an environment during `run` nor uploads repositories, local authentication folders, MCP credentials or SpecWithCode stores.

```json
{
  "enabled": true,
  "environmentId": "env_YOUR_EXISTING_ENVIRONMENT",
  "model": "claude-sonnet-4-6",
  "maxCostCents": "100",
  "timeoutSeconds": 120,
  "globalInstructions": "Your shared environment rules.",
  "projectInstructions": "Your project rules."
}
```

`maxCostCents` is a string of whole US cents, so `"100"` sets a $1 session list-cost limit. Anthropic can charge for work already in flight when a budget is reached. The timeout bounds event streaming; setup and cleanup have separate request timeouts. Choose a limited-network environment without attached repositories or vaults for text-only tasks.

Both lead and predefined worker receive SpecWithCode's mandatory runtime rules plus the explicit global and project instructions. Managed Agents does not automatically read local `CLAUDE.md`, `AGENTS.md`, Claude Code settings or SpecWithCode's native project settings. Put required context in this dedicated config and the supplied task text. Inline workers are disabled so a lead cannot silently replace the worker system instructions. The first beta implementation allows text replies and orchestration only; it does not expose shell, filesystem, web or MCP tools.

The service uses `managed-agents-2026-04-01` and `multiagent_20261001`, creates a pinned predefined worker and lead, starts a budgeted session, and asks the lead to start a workflow. Anthropic lets the lead decide whether to create a workflow; a lead-only response produces a nonzero exit. This CLI is separate from SpecWithCode's native Claude Code provider and its workflows setting. It is not a UI provider selector or cloud coding workspace.

Progress includes typed workflow and phase states. Success requires a completed workflow, final session `end_turn`, complete thread evidence, no observed thread errors, and accepted cleanup. A completed workflow is execution evidence. Check independent worker answers before treating the task as verified: receipts intentionally contain `verified: false`. Anthropic does not expose a workflow's structured worker return as an event. SpecWithCode supplies one constrained custom tool, `studio_report_result`, so workers can report their own answer directly to the client. It records bounded text, performs no external operation, and is acknowledged before the workflow continues. The receipt separates normal messages from these reports and matches each report to its independently listed thread and pinned worker system.

Missing, malformed, empty or truncated thread evidence produces a nonzero exit. Each completed run needs an independently listed worker, and every workflow worker must match the pinned agent system and provide a direct report. A lead's completion message alone cannot satisfy these checks.

SpecWithCode archives only the exact agents and session it created; it preserves the configured environment. On early exit it interrupts active work, asks the lead to stop open workflows, then waits for idle before archiving. At the budget limit, it attempts an eligible idle archive without increasing the budget. The beta API can refuse archive while a run is open; the exact failed resource remains visible in progress and receipts and produces a nonzero exit. It never claims successful cleanup after a refusal.

The paid smoke harness is opt-in and requires a new output directory:

```sh
node scripts/studio-verify/managed-agents-workflows.mjs
node scripts/studio-verify/managed-agents-workflows.mjs --beta-smoke --output /tmp/studio-managed-smoke
```

The first command is offline preflight. `--beta-smoke` creates one ephemeral cloud environment with no allowed network hosts, runs a $1-budget arithmetic workflow with two independent workers and sequential reporting, checks global/project/headless markers in worker answers, and archives its own resources. It runs within a 180-second wall-clock target and saves receipts rather than printing credentials.

References: [Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview), [multiagent orchestration](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration), [workflow runs](https://platform.claude.com/docs/en/managed-agents/workflow-runs), [agent systems](https://platform.claude.com/docs/en/managed-agents/agent-setup), [budgets](https://platform.claude.com/docs/en/managed-agents/budgets), [cloud environments](https://platform.claude.com/docs/en/managed-agents/environments).
