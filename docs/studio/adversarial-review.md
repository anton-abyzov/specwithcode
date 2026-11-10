# Adversarial review and model tiers

SpecWithCode can have a different model family review work another model did: Codex GPT-6.1 Sol
reviewing a feature Claude built, for example. The reviewer looks for bugs, risky assumptions,
missed requirements and security problems, ranks findings by severity with `path:line` evidence,
and is told not to edit anything. That is an instruction in its prompt, not a sandbox: the review
thread runs with the work thread's runtime mode, so read the review before trusting the checkout.

## Start a review

- **By hand:** open a thread's menu (header or sidebar) or the command palette and choose
  **Adversarial review**. The app picks a reviewer, starts a new thread named
  "Adversarial review: <thread>" on the same checkout, and says which model reviews. When no
  other family can review now, it says why for each model it tried.
- **When a feature finishes:** turn on **Review finished features automatically** in project
  settings. When a thread's run finishes and every task of its SpecWeave increment is done or
  skipped, one review starts for that increment. It is off by default, because each review
  spends the reviewer's quota.

Review threads are never reviewed themselves, and they are not linked to the increment. A thread
that only names an increment in its title or branch does not start a review of it; it must claim,
be linked to, or work on the increment's branch. A review of work in the project root does not
switch the root's branch; the reviewer diffs the branch from where it is.

## Who reviews

**Reviewer order** (Settings > Providers > Adversarial review, or per project) is tried in order,
like the fallback order of a thread that runs out:

1. Each entry, then the same model on every other provider that serves it (GitHub Copilot).
2. Entries in the model family that did the work are skipped. Families come from the model,
   not the provider, so Claude through Copilot still counts as Claude.
3. Availability is the fallback system's own: signed-out, not ready, usage full or at its limit,
   billed per token, and models kept out of automatic use are skipped. A provider that reports no
   usage (Copilot) counts as ready at its place in the order unless it stopped a thread on its
   limit.

An empty list uses each provider's regular model, OpenAI first, then Meta (Muse), Google, xAI,
and Claude last.

## Regular and frontier models

Each provider has a **regular** model for everyday work and a **frontier** model for hard work.
Built-in defaults:

| Provider | Regular     | Frontier        |
| -------- | ----------- | --------------- |
| Claude   | Opus 5.5    | Fable 5.2       |
| Codex    | GPT-6.1 Sol | GPT-6 Astra     |
| Muse     | Wonder 1.0  | Wonder Full 1.0 |

Providers that serve other vendors' models (GitHub Copilot, OpenCode) use the same model another
provider names, when they list it. Change any of them in Settings > Providers > Regular and
frontier models; a model the provider does not list is never used, and a missing frontier model
falls back to regular.

The app uses regular unless asked otherwise: reviews run on regular unless **Review depth** is
Frontier, and `studio_thread_launch` / `delegate_task` take `tier: "regular" | "frontier"` when
they name a provider without a model. A worker in the "complex" lane defaults to frontier. The
default model for new chats is not changed by these settings.

## The skill

`.agents/skills/adversarial-review/SKILL.md` holds the same procedure for agents working in a
repository that has it. The review thread's first message carries the whole procedure as well,
so a review works where the skill is not installed.
