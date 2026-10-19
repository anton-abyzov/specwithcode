# Muse Code and usable fallback suggestions

## Connect Muse Code

1. Install the native CLI using the [official Muse Code instructions](https://dev.meta.ai/docs/muse-code).
2. Run `muse` on the execution machine, sign in, and complete native workspace trust. In Muse settings, check Contributor mode before sending private code: Meta says it is on by default and permits training; Standard mode does not.
3. In SpecWithCode, open **Settings → Providers → Add Provider → Muse Code**. Save the instance, set its binary path if needed, and refresh it.
4. Select the model offered by the native account. **Muse Wonder Full requires Power Usage or Maximum Usage**. It is a separate model, not Muse Wonder with `max` reasoning effort. An API key does not provide Full.

Model names/IDs come from the installed CLI's provider catalogue. The integration does not invent a Full model ID or include bundled/configuration catalogues as entitlement evidence. A native subscription usage observation is also required for Full; an instance with `META_API_KEY` cannot expose it. Meta's native model admission remains authoritative.

Sources checked 2026-10-14: [Models](https://dev.meta.ai/docs/models), [Wonder launch and subscription plans](https://dev.meta.ai/resources/blog/build-with-muse-wonder), [SDK](https://meta-models.github.io/muse-code-sdk/next/).

## What the preview supports

The adapter uses the official `@muse-code/sdk` 1.4.8 and `muse serve` protocol. It streams assistant text, reasoning summaries and tool output, carries native session IDs across reconnects, applies discovered model/effort choices, and cancels native turns. It preserves once-scoped approval choices and native approval-stage guards. Restored approvals are recovered from the native pending-request surface.

Structured native question dialogs are not supported: the client declares that limitation and cancels pending questions with a reason asking the agent to use chat. Image prompts, rollback/fork, compaction, injected MCP tools, and background title/commit/PR generation are not supported in this preview. Configure another provider for background text generation. The native sandbox stays under Muse's own configuration; SpecWithCode approval mode maps to Muse approval policy, not to a claim about sandbox isolation.

A missing CLI, missing account usage, unsupported protocol fingerprint or failed probe remains explicit. An enabled instance without a confirmed subscription observation is not offered as an automatic fallback. SDK compatibility does not establish acceptance of a particular installed CLI/account.

## Fallback eligibility

A suggestion requires an enabled, installed, available provider, authenticated status, a discovered model, and a successful usage observation no more than five minutes old. Unknown, failed, stale, future-dated, denied and exhausted usage is excluded. An exhausted window reaching its reset time does not itself establish renewed capacity, even when another window still has headroom. Refresh Providers to obtain new evidence.

Explicitly configured fallback models must also exist in account discovery. Custom model strings do not prove model access. Automatic selection does not pick pay-per-token providers. Existing explicit credit-recovery actions retain their separate authorization and native checks.

Grok Build and Cursor remain distinct execution providers; selecting one does not infer a subscription or credits for the other.

On The X Subscription, Cursor's Grok usage draws from the same weekly pool as the Grok apps and X. A Cursor fallback can therefore find that pool already spent by Grok use outside SpecWithCode. Check its **Included usage** bar (shown when the Cursor CLI login is the same account) before relying on it.

## Verification boundary

Tests drive the pinned SDK against an isolated local MSP process, including live streaming, model readback, approvals, resume replay, questions, cancellation and failure. The browser fixture uses the real model picker at 320px and 1440px in light/dark themes. These tests neither authenticate a real Muse account nor consume paid model usage.

Before release acceptance, verify on an eligible native account: CLI sign-in, account discovery of Wonder Full, one authorized turn, native approval, cancellation, and reconnect. No account was purchased, authenticated or charged during implementation.

Native validation on 2026-10-14: official macOS ARM64 CLI 1.4.8-R6256.1 matches SDK 1.4.8 and passed a real offline echo turn, streamed output, durable-session shutdown and reconnect with isolated XDG state. CLI 1.4.8 correctly failed against SDK 1.4.7 before the pin was updated. This validates the native transport and lifecycle, not a Meta account or Wonder Full entitlement.
