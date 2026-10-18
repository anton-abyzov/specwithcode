# Connections library

Open **Settings → Connections** and select an execution machine. The matrix compares MCP declarations in Codex and Claude Code configuration. Select a cell for its source, scope, other declarations and access owner. **Refresh configurations** reads the selected machine again.

Open a project's **Environment** to include its registered checkout's configuration. User declarations are shared across projects; project and private-project declarations can override them. Existing **SpecWithCode-managed connections** retain their own per-project tool grants.

## What the states mean

- **Configured**: a supported command or URL is declared. This does not establish sign-in, project trust, native policy, or session access.
- **Disabled**: an explicit disable was found in the inspected configuration.
- **Invalid declaration**: the entry has no supported transport or has an invalid structure.
- **Not found**: no matching declaration was found in the inspected sources. **Unknown** replaces this when a source could not be read or the inventory was truncated.

Offline, denied, loading and failed scans are shown separately from an empty inventory. Partial scans retain an incomplete-results notice. Matching names across clients are a comparison aid; they do not prove identical servers or accounts.

## Sources and boundaries

The execution host reads Codex's `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) and Claude's user `.claude.json` (respecting `CLAUDE_CONFIG_DIR`). It also reads the MCP servers of enabled plugins: Codex plugins listed under `[plugins]` (the newest cached version under `$CODEX_HOME/plugins/cache`, its `.mcp.json` and `.app.json` connectors), and Claude Code plugins enabled in `settings.json` and installed under `~/.claude/plugins`. Outside project context every private-project entry in `.claude.json` is listed with its folder name. In project context it reads the registered root's `.codex/config.toml`, `.mcp.json`, the exact private project entry in Claude's user file, and Claude user/project/local settings for explicit disables.

Rows are grouped as your connections, servers that come with plugins, and servers declared only in private projects. Other AI tools get a read-only column once their user file exists: Claude Desktop, Gemini CLI, Copilot CLI (`~/.copilot/mcp-config.json`), Cursor, OpenCode and Windsurf. **Add to** and **Enable** only edit Codex and Claude Code user declarations; plugin, other-project and other-tool declarations are never copied.

Codex project tables inherit unspecified fields from same-named user entries. Claude private-project declarations override shared project declarations, which override user declarations. Plugin servers run beside same-named user entries and never shadow them. These are configuration observations; native clients remain responsible for actual admission. claude.ai and other account connectors live in the account rather than in files and are not listed. Managed settings, ancestor files and alternate client profiles are outside this inventory.

The protected `connections.nativeRead` RPC requires filesystem read permission on the destination environment. It accepts an optional registered project ID, never a browser-supplied filesystem path. Each file is limited to 2 MiB and 200 declarations, and at most 200 plugins and projects are inspected. Returned metadata excludes command text, arguments, URLs, headers, environment values and credentials. Discovery launches no server, performs no network probe and changes no native configuration.

SpecWithCode grants control SpecWithCode-managed calls only. This release does not import native connections into those grants or enforce native-client access through SpecWithCode toggles.

## Verification

Focused tests exercise filesystem parsing, project isolation, precedence, redaction, bounds, missing and malformed sources, service routing, RPC permission rejection and matrix states. The headless fixture mounts the actual settings library, panel and matrix with synthetic machine/query state; it verifies switching machines and projects, errors, narrow layout and production CSS. It is not proof of a native session or installed-app acceptance.

Use Node 22.20.0. Build the fixture with `node node_modules/vite-plus/bin/vp build --config apps/web/tests/connections-library/vite.config.ts`, then run `node scripts/studio-verify/connections-library.mjs`. Evidence is written to `reports/connections-library/`. Production builds remain required for web and server.
