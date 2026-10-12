# GitHub Copilot and Grok in Studio

Studio uses the providers' official coding agents through the Agent Client Protocol (ACP). The agents own authentication, model access and billing. Studio supplies the conversation, tool display, approvals, cancellation and retained native session identity.

## Add GitHub Copilot

Open **Settings → Providers → Add provider** on the environment where you want the agent to run. Choose **GitHub Copilot** in the featured registry agents, confirm its identity and finish the install/sign-in wizard. The entry resolves the official `github-copilot-cli` registry record on that environment. Installation occurs only after you choose it; Studio never substitutes a different registry match. For an existing instance, **Install / update agent** prepares the registry version and refreshes that instance. Startup and catalog refresh do not install or upgrade these agents implicitly.

An existing Copilot install can also use **Local ACP command**: executable `copilot`, with separate arguments `--acp`, `--stdio`, and `--no-auto-update`. Authenticate on the same machine with `copilot login --device-code` if the native sign-in requires a terminal. Studio does not extract tokens from your GitHub or editor credentials.

Copilot CLI 1.0.95 does not advertise a model catalog over ACP ([copilot-cli#4880](https://github.com/github/copilot-cli/issues/4880)), so the picker shows only **Default**, which leaves the choice to the CLI: `COPILOT_MODEL`, then `model` in `~/.copilot/settings.json`, then the CLI's own default. On Copilot Free and Student that is always `auto` routing. To choose a model, open the Copilot instance's **Models** section, add a custom model with the exact Copilot ID (for example `claude-opus-5.5`) and select it in the composer. Studio sends that ID with `session/set_model`. Switching a running thread back to **Default** sends `auto`, so the session stops using the custom model. A CLI that later advertises a catalog fills the picker without a Studio update.

Copilot accepts any non-empty ID, including a mistyped one. On the Copilot Free account tested, an ID the account could not use was served through `auto` routing with nothing reported over ACP; behaviour on paid plans is untested. The model that served a turn is recorded in `~/.copilot/session-state/<session id>/events.jsonl`. GitHub's documentation checked on October 10, 2026 lists Claude Opus 5.5 and Grok 4.7 for Copilot CLI. Opus 5.5 requires an eligible Pro+, Max, Business or Enterprise plan; organization policy and account budget can further restrict access. A model name in documentation or a custom entry does not establish entitlement. Copilot usage consumes the account's AI credits; Studio does not invent a remaining balance.

## Add Grok

Use the native **Grok** option for an existing CLI. This retains Studio's Grok-specific skills, reasoning controls, usage reporting and text-generation support. Authenticate with `grok login --device-auth` on that environment, or configure an `XAI_API_KEY` in its provider environment. Updating an existing CLI remains a separate action.

For a Studio-managed install, choose **Grok Build** in the featured registry agents. This uses the official `grok-build` distribution and the shared ACP runtime. Registry agents support chat but do not offer Studio's automatic commit, PR, branch-name or title generation. Adding another instance does not create a second isolated provider account; the native credential store remains authoritative. Managed Grok installation keeps its executable and installer configuration inside Studio’s tools directory; normal runtime authentication still uses the environment’s native credential store. Both managed agents disable CLI self-updates. Use **Install / update agent** to upgrade or repair a missing managed executable.

Grok models and reasoning choices are discovered from the CLI. A CLI that reports `grok-4.7` makes it selectable without a Studio update. The clean, signed-out Grok 1.0.50 probe used for this change advertised Grok 4.6 and 4.5; it did **not** establish native Grok 4.7 access. The xAI API separately documents `grok-4.7`. Use the CLI's supported custom-model configuration when routing to an API model; adding a display-only model name in Studio cannot grant API access.

## Approvals and continuation

Keep approval prompts enabled while validating a new provider. Studio answers ACP permission requests through the same approval UI used by its other ACP agents. Provider-native policy can affect when those requests are sent. Copilot ACP is public preview, and GitHub has an open report about older builds executing tools without sending permission requests. Test a denied write in a disposable project with your installed version before relying on the approval boundary.

Studio retains the native session ID and uses the agent's advertised resume/load capabilities. Models, settings and capabilities can change after sign-in or an agent update; refresh the provider rather than assuming a cached catalog proves availability. Missing credentials, models and unsupported operations remain visible as errors or unavailable capabilities.

## Verification boundary

The implementation is covered by focused provider and UI tests, responsive headless component checks, isolated CLI handshakes and production builds. A signed-out Copilot 1.0.94 handshake succeeds and correctly rejects session creation until login. Model selection, streaming, cancellation, approval denial and retained-session loading have deterministic ACP fixture coverage. A signed-in Copilot 1.0.95 on a Copilot Free account completed real ACP turns; requests for `claude-haiku-4.5` and `claude-opus-5.5`, by `session/set_model` and by `--model`, were all served by the `auto` model, the only one that plan offered. These checks do not establish a successful authenticated Opus 5.5/Grok 4.7 turn, real tool-denial enforcement or resumed account history. Complete those checks in a disposable project on an eligible plan.

## Sources

- [Copilot ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
- [Copilot models](https://docs.github.com/en/copilot/reference/ai-models/supported-models)
- [Copilot authentication](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)
- [Copilot billing](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing)
- [Copilot permission regression report](https://github.com/github/copilot-cli/issues/4537)
- [Grok CLI reference](https://docs.x.ai/build/cli/reference)
- [Grok 4.7 API](https://docs.x.ai/developers/models/grok-4.7)
- [Official ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
