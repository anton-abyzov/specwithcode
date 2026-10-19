# Cursor

Cursor V2 runs through the official [`@cursor/sdk`](https://cursor.com/docs/api/sdk/typescript)
TypeScript package. It does not use Cursor's ACP transport for V2 execution.

## Prerequisites

- Node.js 22.13 or newer. The repository's supported Node version satisfies this requirement.
- Sign in with Cursor in **Settings > Providers > Cursor**, or provide a Cursor API key in
  `CURSOR_API_KEY`.
- A model accepted by the Cursor SDK. `auto` is sent to the SDK as its `default` model selection.

SpecWithCode runs Cursor only as the SDK's local agent in the selected workspace. It never starts
Cursor cloud agents. You do not need the Cursor CLI to run Cursor in SpecWithCode.

## Plans and billing

SpaceX, which absorbed xAI, acquired Cursor in August 2026. Since 12 October 2026, new Cursor
accounts are on [The X Subscription](https://x.ai/news/x-subscription):

| Plan    | Price      | Cursor access                                                 |
| ------- | ---------- | ------------------------------------------------------------- |
| Free    | $0         | Starter allowance. No third-party models and no cloud agents. |
| Plus    | $8/month   | Grok and Composer models only. No Auto.                       |
| Premium | $30/month  | Grok models. Claude, GPT and Gemini from prepaid credit.      |
| Super   | $100/month | Grok models. Claude, GPT and Gemini from prepaid credit.      |
| Ultra   | $200/month | Grok models. Claude, GPT and Gemini from prepaid credit.      |
| Teams   | See x.ai   | Plan for teams.                                               |

Grok usage is one pool that refreshes weekly. It is shared with the Grok apps and X, so chatting
in Grok uses the same allowance as Cursor runs in SpecWithCode. Claude, GPT and Gemini need
Premium or higher and bill at API list price from prepaid credit, not from the plan allowance.
See [Cursor models and pricing](https://cursor.com/docs/models-and-pricing).

Earlier Cursor plans keep working for existing subscribers. They have two monthly pools,
Cursor Models and Other Models, plus an overall total.

OpenAI has proposed ending OpenAI model access through Cursor on 12 November 2026. If that
happens, GPT models will no longer be available through a Cursor instance.

SpecWithCode adds no caps of its own. **Usage → Limits** shows one weekly **Included usage** bar
for X Subscription accounts and monthly **Overall**, **Cursor Models** and **Other Models** bars
for earlier plans, or when Cursor's plan details cannot be read. Limits come from the Cursor CLI
login (`agent login`) or `CURSOR_AUTH_TOKEN`, not from signing in inside SpecWithCode. For an
instance signed in inside SpecWithCode, they appear only when that CLI login is the same Cursor
account. On macOS, also turn on Cursor account usage so SpecWithCode can read the CLI login from
Keychain. An explicit `CURSOR_API_KEY` does not report them. See [Usage](./usage.md).

## Sign in

Choose **Sign in**, then open the sign-in page and complete it in your browser. SpecWithCode
updates automatically when sign-in finishes. This works when connected to a remote environment too.
On mobile, use **Settings > Provider accounts** for an already configured Cursor instance.

Each provider instance keeps its own login on the environment that runs it. Your Cursor editor and
CLI login are separate. A configured `CURSOR_API_KEY` overrides browser sign-in; remove that override
to use the browser flow.

Use **Change account** or **Sign out** in the same settings section. Both stop that
instance's running threads and keep their history. Sign-out forgets the saved credential; to revoke
the generated key before it expires, remove it from your Cursor dashboard's API keys.

## V2 Capability Mapping

The adapter supports:

- creating and resuming local Cursor agent threads;
- changing the model and model parameters between turns;
- assistant text, reasoning, tool activity, plans, and todo streaming;
- thread-scoped SpecWithCode MCP tools;
- image attachments;
- interruption, queued app messages, and orchestrator-owned interrupt/restart steering;
- provider conversation snapshots through `Agent.messages.list()`;
- Cursor `task` subagents, projected as read-only child app threads with their tool activity and
  final result.

The public SDK does not currently expose native agent fork, conversation rollback, active steering,
or interactive approval callbacks. Direct active steering is advertised as unsupported, while V2
steering uses the orchestrator's interrupt-and-restart path and preserves the app run identity across
provider turns. Same-provider Cursor forks use the orchestrator's portable full-thread context
handoff into a fresh Cursor agent. The SDK has in-process custom callback tools, but the V2 adapter
intentionally uses the authenticated, thread-scoped MCP server instead.

Portable handoffs summarize eligible timeline items and can omit the end of long messages. Read
[Context in portable handoffs](./portable-handoffs.md) before using a fork for work whose exact
instructions must carry forward.

Cursor task events include an `agentId`, but the local SDK does not register that identifier as a
resumable agent: `Agent.resume()` returns `AgentNotFoundError`. The adapter therefore does not attach
a provider thread to native task projections or advertise subagent thread IDs. A projected child is
read-only: send messages from the parent thread.

Runtime modes map to the controls the local SDK exposes: full access disables its sandbox, while
restricted modes and explicit non-full-access sandbox policies enable it. Explicit approval policy
overrides also control Cursor Auto-review. Auto-review is not represented as an interactive SpecWithCode
approval flow.

The existing Cursor binary path and API endpoint settings belong to the CLI/ACP integration. Cursor
V2 execution does not launch that binary, and the SDK does not expose an API endpoint override.

## Replay And Live Testing

Cursor replay fixtures preserve the SDK boundary: agent open/resume, sends, ordered `onDelta`
updates, terminal results, cancellation, message snapshots, and close. The real V2 adapter,
orchestrator, event store, projections, and checkpoint logic still run in tests.

Record a fixture against the real SDK with:

```bash
pnpm --filter specweave-studio record:cursor-replay --scenario simple
```

Use `--out <path>` to record a temporary probe without replacing a checked-in fixture. Supported
scenarios are listed by the recorder when an invalid scenario is supplied.
