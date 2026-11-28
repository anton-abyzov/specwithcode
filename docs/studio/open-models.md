# Open models with your own key or a local runtime

An open-model route runs Claude Code against a model that is not Anthropic's. Claude Code talks to the vendor's own Anthropic-compatible endpoint with your API key, or to a model runtime you run yourself. The thread keeps Claude Code's tools, skills, approvals and settings; only the endpoint and the model change.

SpecWithCode never sells, pools or resells model access. Your key goes from this machine straight to the vendor, and the vendor bills it.

## Presets

The app ships six presets. Their endpoints, key variables and model ids come from each vendor's Claude Code guide, checked November 28, 2026.

| Vendor     | Base URL                             | Key or local  | Where to get a key                                              | Models                                              | Billing in the app |
| ---------- | ------------------------------------ | ------------- | --------------------------------------------------------------- | --------------------------------------------------- | ------------------ |
| DeepSeek   | `https://api.deepseek.com/anthropic` | Your API key  | [platform.deepseek.com](https://platform.deepseek.com/api_keys) | `deepseek-flash`                                    | Your key           |
| Kimi       | `https://api.moonshot.ai/anthropic`  | Your API key  | [platform.kimi.ai](https://platform.kimi.ai/console/api-keys)   | `kimi-k3`                                           | Your key           |
| Z.ai GLM   | `https://api.z.ai/api/anthropic`     | Your API key  | [z.ai](https://z.ai/manage-apikey/apikey-list)                  | `glm-5.4`, with `glm-5.3-flash` for background work | Your key           |
| OpenRouter | `https://openrouter.ai/api`          | Your API key  | [openrouter.ai](https://openrouter.ai/settings/keys)            | One model id you enter                              | Your key           |
| Ollama     | `http://localhost:11434`             | Local, no key | Not needed                                                      | Found on the runtime                                | Local              |
| LM Studio  | `http://localhost:1234`              | Local, no key | Not needed                                                      | Found on the runtime                                | Local              |

Vendor guides: [DeepSeek](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code) · [Kimi](https://platform.kimi.ai/docs/guide/claude-code-kimi) · [Z.ai](https://docs.z.ai/devpack/tool/claude) · [OpenRouter](https://openrouter.ai/docs/guides/guides/claude-code-integration) · [Ollama](https://docs.ollama.com/integrations/claude-code) · [LM Studio](https://lmstudio.ai/docs/integrations/claude-code)

**Your key** means the vendor bills your key at its own list price. **Local** means the model runs on your own runtime, usually on this machine. The model picker shows each route with the vendor's mark and one of these two labels.

Mistral is not listed because it has no Anthropic-compatible endpoint. Coding-plan subscriptions, such as a vendor's monthly coding plan, are not supported here; the presets use each vendor's pay-per-token API.

For which models actually finish agent tasks, see the [AnyModel bench](https://anymodel.dev/?utm_source=specwithcode&utm_medium=docs).

## Add one

1. Open **Settings > Providers > Add provider** on the machine where the threads will run.
2. Choose **Add an open model**, then pick a preset.
3. For DeepSeek, Kimi, Z.ai or OpenRouter, paste your API key. For OpenRouter, also enter the model id you want.
4. For Ollama or LM Studio, start the runtime first. Change the address if it does not listen on the default port. The app lists the models it finds there; if it finds none, the instance shows "No models found at" and the address.

The new instance is an ordinary Claude provider instance with the preset's environment rows. It uses your default Claude home, so your skills and settings apply. The preset sets its own token and blanks `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`, so a claude.ai sign-in or an Anthropic key on this machine is not sent to the vendor.

An instance you built by hand with your own base URL, as in [Claude provider: OpenRouter](../user/providers-claude.md#openrouter), keeps working as before. The rules on this page apply only to instances made from a preset.

## Where the key lives

The key is stored in the app's secret store on this machine, outside `settings.json`, in a file only your user account can read. It is never synced to other machines and never sent to the app's clients; Settings shows it redacted.

The preset sets `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, which keeps the key out of the environment of Bash commands, hooks and stdio MCP servers that Claude Code starts. A tool call cannot print it into the thread.

## How tracks treat it

Nothing in the app picks an open-model route on its own. Provider fallback, Auto task routing, the any-ready worker pick, the coordinator and worker defaults, learned preferences and same-model alternates, including a review's reviewer order, all skip it. It runs only on a thread you switch to it, or on a track where you put it.

To use one for everyday work, add it to the **Daily** track by hand in **Settings > Models** or in Project settings. You can add it to the **Complex** track the same way. The **Review** track does not take it: reviews never spend a key.

## Switch a thread to it and back

Pick the route in a thread's model picker, as with any model. The thread keeps its permission mode. An approval card still open on the running turn is interrupted, as with any switch.

History carries over. On the same endpoint the thread resumes its native session. When the endpoint changes, from Anthropic to a vendor or back, the app carries the conversation over with its history handoff instead, because one endpoint cannot replay another's native session.

## Sources

- Vendor Claude Code guides, linked under [Presets](#presets)
- [Claude provider guide](../user/providers-claude.md)
