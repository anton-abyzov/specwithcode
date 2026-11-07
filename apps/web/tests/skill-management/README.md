# Skill management component fixture

Build from the repository root with `node node_modules/vite-plus/bin/vp build --config apps/web/tests/skill-management/vite.config.ts`. Serve `.artifacts/skill-management/site` on an owned loopback port. Use the native preview with `open: false`; screenshots must remain headless.

The fixture renders the production detail panel, Markdown, copy comparison, availability and grouped agent controls with fictional inventory and mock RPC responses. It never reads live files or invokes a registry or fleet machine.

Capture `?theme=light` and `?theme=dark` at 1440×900 and 390×900. Add `&view=compare` to open comparison. Check no horizontal page overflow, inline code/link semantics, two path groups retaining four agents, Instructions headings, and the preview/confirm/cancel boundary. The initial implementation captured the prior production detail component before editing it; retained screenshots belong in the external increment evidence directory, not this public repository.

This fixture does not establish installed acceptance, real provider discovery, authenticated registry publication or machine-to-machine installation.
