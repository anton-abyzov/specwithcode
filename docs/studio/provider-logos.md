# Provider logos

SpecWithCode draws every provider mark through one component, `ProviderLogo`
(`apps/web/src/components/ProviderLogo.tsx`). `ProviderInstanceIcon`, the model
picker, thread headers, settings, usage views, the ACP Registry cards and the
Skills page all resolve a provider to a brand with `providerBrandFor` and render
it from `ProviderLogoMarks.tsx`, so a provider looks the same everywhere.

- Built-in drivers map by driver kind (`codex` is OpenAI, `muse` is Meta).
- ACP Registry agents map by their registry id or official CDN icon URL, never
  by a user-editable display name. A local command whose agent id was cleared
  keeps the generic ACP mark, except a local Copilot or DeepSeek Harness
  (`dsh`) command, which is named by its executable. Unknown registry agents still load their icon
  from the registry CDN.
- Multicolour marks keep their brand colours; monochrome marks follow the
  surrounding text colour, so they read in light and dark themes.

The marks were checked in October 2026. Each is a trademark of its owner and is
used only to identify that provider.

| Brand                                      | Source                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| Claude                                     | Claude spark, #D97757 (lobehub `claude-color`, same as ACP `claude-acp`)           |
| OpenAI                                     | Refined 2025 blossom (lobehub `openai`); also used for Codex                       |
| Grok                                       | xAI Grok mark, 2025 (lobehub `grok`)                                               |
| Gemini                                     | Mid-2025 four-colour spark (lobehub `gemini-color`)                                |
| Copilot                                    | GitHub's ACP Registry icon (Primer `copilot-16`), in `@specweave-studio/contracts` |
| Cursor                                     | 2025 cube (simple-icons `cursor`, same as Cursor's ACP icon)                       |
| OpenCode                                   | `packages/identity/mark.svg` in the OpenCode repository                            |
| Antigravity                                | Google Antigravity colour mark (lobehub `antigravity-color`)                       |
| Pi                                         | 4x4 pixel mark from `pi-coding-agent` 1.3.0                                        |
| Meta                                       | Meta infinity mark for Muse Code, which has no mark of its own                     |
| Ollama                                     | Llama head (lobehub `ollama`, same as simple-icons)                                |
| Qwen                                       | Qwen mark (lobehub `qwen-color`, same shape as Qwen Code's ACP icon)               |
| Kimi                                       | "K only" mark from MoonshotAI/Branding-Guide                                       |
| Mistral                                    | Mistral pixel M (lobehub `mistral-color`)                                          |
| Kiro                                       | Kiro tile (lobehub `kiro-color`, tile colour from Kiro's own icon)                 |
| goose, Cline, Auggie, Factory Droid, Junie | Vendor-submitted ACP Registry icons                                                |
| Amp                                        | Amp mark (lobehub `amp`, same as the Amp ACP adapter)                              |
| DeepSeek                                   | DeepSeek whale, #4D6BFE (lobehub `deepseek-color`)                                 |

To add a provider, add its SVG as a component in `ProviderLogoMarks.tsx`
(prefix gradient ids with `useId()`), add the brand to `ProviderLogo.tsx` and
map its driver kind or registry id. The headless fixture in
`apps/web/tests/skills-and-logos` renders every mark in light and dark.
