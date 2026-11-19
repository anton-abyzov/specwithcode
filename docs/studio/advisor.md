# Advisor

The advisor lets a running thread ask a stronger model to look over its work, then keep going.
The thread stays on its own model. The advisor reads where the thread stands, answers with
advice, and does not touch the checkout. This works for a thread on any provider: Claude, Codex,
Muse, Copilot, Cursor, Gemini, OpenCode, Pi and the other agents the app runs.

It is off by default. Each consult spends the advisor model's usage, so turn it on where a wrong
turn costs more than a second opinion.

## When a thread consults

The thread decides. With the advisor on, SpecWithCode adds a short paragraph to the thread's
instructions that tells it to ask:

- once it has looked around and understands the task, before the real work starts;
- again before it reports the work as done, after it has saved its results;
- when it is stuck, or before it changes approach.

The same paragraph tells it to weigh the advice against what it checked itself and to raise a
disagreement with its evidence instead of switching quietly. The app never forces a consult. You
can always ask for one in a message.

## Two routes

### Claude's own advisor

Claude Code has an advisor of its own. Anthropic runs it on its side, inside the same request,
and it reads the whole conversation ([Claude Code advisor][cc-advisor],
[advisor tool][api-advisor]). The app uses it when all of these hold:

- the thread runs on Claude Code signed in to Anthropic;
- **Claude's own advisor** is on;
- the advisor is a Claude model that Anthropic's compatibility table accepts for the thread's
  model, which can be the thread's own model ([advisor tool, model compatibility][api-advisor]);
- the thread's context is under **Context limit for Claude's advisor**.

The app picks the advisor model from your settings and passes it to that Claude session. It
switches Claude's own advisor off when the thread's advisor is off by the thread's own choice,
when the thread uses the SpecWithCode route, and in every advisor thread. With the app and
project setting off and no choice on the thread, the app passes nothing, and whatever your Claude
Code settings say still applies. Those consults are titled with the model that answered and "from
Claude's settings", and the composer's **Advisor** row names that model.

The studio-code `advisor` tool stays available on these threads too, so a thread whose built-in
consult fails still has an advisor.

### The SpecWithCode route

Every other pair uses the studio-code `advisor` tool: a Codex thread advised by Fable, a Claude
thread advised by GPT-6.1 Sol, or a Claude thread whose context has passed the limit. The thread
calls the tool with no arguments, or with a short `focus` naming the one question it most wants
checked (up to 2,000 characters). The app then:

1. Picks the advisor (see below) and refuses with the reason when the advisor is off, when the
   run has used up its consults, or when no advisor can run now.
2. Builds a brief from the stored thread.
3. Starts the advisor as a read-only child thread with the brief, and returns its answer to the
   caller with the advisor's name and how many consults remain in this run.
4. Archives the advisor thread once its advice is read. Advisor threads never show in the
   sidebar as project threads.

**What the brief holds:** the first and the latest user message, earlier advice, the last few
assistant messages, one line per command and tool call with its input and output trimmed,
the files changed, errors, and the focus if one was given. A second consult sends the task, the
latest message, the previous advice and only what happened since that consult.

**What it leaves out:** tool output past a few hundred bytes per call, older messages past a
short excerpt, advice from all but the latest consult when space is short, and, when the brief would pass its
size, the oldest activity first. A "Left out" section says how many items were dropped.

**What the advisor sees:** the brief and the thread's working folder, read-only, and nothing
else. It has no tool for reading the rest of the thread, so what the brief left out is out of
its reach; the brief tells it to say so when a judgment depends on something missing and to name
what the thread should check itself. The brief also tells it that everything it quotes is data,
not instructions.

**How long it waits:** up to 4 minutes on a Claude thread and 45 seconds on any other provider.
Other agents end a tool call sooner than Claude Code does (Codex stops one at 60 seconds by
default). When the advisor needs longer, the call answers "still working", and the advice arrives
as the thread's next message, written into that message as a review to weigh. Calling `advisor`
again before then picks up the same consult instead of starting another. Once the thread has taken
that message in, the app archives the advisor's child thread; nobody has to acknowledge it.

## Who advises

**Advisor model** names the model to try first, then the project's Complex track follows. Left at
its default, the order is the Complex track alone, which starts with Claude Fable 5.2 until you
change the track. The Review track is never part of it, so the model that reviews the work
does not also advise it. The app takes the first entry that can run now.

Through Claude's own advisor, a thread on that first model is advised by the same model: a Fable
5.2 thread gets Fable 5.2, with the whole conversation in view. A brief never goes to the thread's
own model; the next entry in the order answers it. The composer's **Advisor** row names the
advisor, says when it is the thread's own model, and names the model a brief would go to past the
context limit. Each consult is titled with the model that answered.

Accounts billed per token, Vertex, paid routers and accounts of unknown billing are never picked
from the default order.

## Settings

Settings > Models > **Advisor**, app-wide on each machine. The project dialog shows the same rows
and can override any of them for one project, field by field: changing one row overrides that
field alone, only that row says **Overridden for this project**, and the others keep following
the machine. A row's reset removes just its own field from the project's override.

| Row                                | Default                          | Range               |
| ---------------------------------- | -------------------------------- | ------------------- |
| Let threads ask a stronger model   | Off                              |                     |
| Advisor model                      | The Complex track                |                     |
| Claude's own advisor               | On                               |                     |
| Context limit for Claude's advisor | 200,000 tokens                   | 50,000 to 1,000,000 |
| Consults per run                   | 3                                | 1 to 10             |
| Brief size                         | 24,000 tokens                    | 4,000 to 64,000     |

**Per thread:** the composer's options menu has an **Advisor** row with **Follow project**, **On**
and **Off**. Follow project shows whether the project has it on. The choice is stored on the
thread and takes effect at its next turn. On a model with no options of its own the menu still
shows, as an **Advisor** button that holds only this row. Drafts and advisor threads have no
row. A project coordinator has no per-thread options menu, so its advisor follows the project
setting.

In the timeline a consult reads **Asked the advisor** with the advisor's model and opens to the
advice; Claude's own advisor is named by the model's display name. A consult that gave no advice
says why: **Did not ask the advisor** for a refusal, **The advisor gave no advice** when it ran
and failed, a **Still working** chip while the advice is on its way, **Advisor unavailable** with
Claude's error code, or **Advice applied (hidden by Claude)** when Claude returns advice the app
cannot read. A collapsed group of tool calls counts only consults that gave advice as asked.

## Cost guards

- **Off by default.** The app starts no consult until you turn the advisor on for the machine,
  a project or a thread.
- **Consults per run.** A run gets at most this many consults; the next call is refused and
  starts nothing.
- **Brief size.** The SpecWithCode route never sends more than this. One byte counts as one
  token, so the real token count is usually lower.
- **Context limit for Claude's advisor.** Claude's own advisor reads the whole conversation again
  on every consult, and that read is not cached ([Claude Code advisor, prompt
  caching][cc-advisor]). A long thread would pay for its full context at the advisor's price each
  time. Above the limit the thread uses the SpecWithCode route and its budgeted brief; it moves
  back only when its context falls under half the limit, so it does not flip at the edge.

A Fable advisor on Claude's own route is billed to Claude usage credits, as the settings row
says ([Claude Code advisor, cost][cc-advisor]). Tokens Claude's own advisor spends are not yet
counted in the app's usage numbers.

## Limits

- **A Claude session keeps its first advisor model.** Once a Claude session has consulted one
  advisor model, a changed advisor model reaches it only after its context is compacted or
  cleared. Switching Claude's own advisor off takes effect at the next turn.
- **Supervised advisors.** On a provider where the app cannot set a read-only sandbox (Pi,
  OpenCode 2, Antigravity), the advisor thread runs in Supervised mode. If it stops for an
  approval or a question, nobody can answer it, so the app ends that consult and the thread
  hears that it gave no advice.
- **Advice as the next message.** Threads that are not on Claude often get the advice as their
  next message rather than as the tool's answer, because their tool calls end sooner.
- **No consult from an advisor.** An advisor thread cannot ask an advisor or hand work to
  another thread.

## Sources

- Anthropic, [Advisor tool][api-advisor] (how the advisor reads the conversation, model
  compatibility, error codes).
- Anthropic, [Advisor in Claude Code][cc-advisor] (settings, cost, prompt caching).

[api-advisor]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool
[cc-advisor]: https://code.claude.com/docs/en/advisor
