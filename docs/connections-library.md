# Connections library

Open **Settings → Connections** and select an execution machine. Each AI tool keeps its own MCP list, so the matrix compares one row per server across Codex, Claude Code and every other tool whose configuration exists on the machine. **Refresh configurations** reads the selected machine again.

## Finding a server

- **Search** matches server names, plugin names and folder names.
- **Tools** chips show how many servers each tool has enabled. Picking one narrows the table to that tool; picking more compares them; **All** shows every tool. Rows with no declaration in the shown tools drop out.
- **Status**: Enabled, Disabled, Missing somewhere (declared in one shown tool and absent from another) and, when present, Invalid. **Clear filters** resets all three.
- Rows are sorted enabled-first within each group (your connections, from plugins, only in one folder). Group headers collapse.
- **Compact** (default) shows one line per cell: empty cells are a faint ring, and notes sit behind an info mark. **Detailed** shows each declaration's scope and transport and the notes inline.

Select a status for that tool's source, transport, other declarations, access owner and actions; select a server name for the row's details, including the computer-use permission note. **Copy location** copies the file and key (for example `~/.codex/config.toml [mcp_servers.posthog]`), never the command, URL or secrets, which the machine does not send to the browser.

Open a project's **Environment** to include its registered checkout's configuration. User declarations are shared across projects; project and private-project declarations can override them. Existing **SpecWithCode-managed connections** retain their own per-project tool grants.

## What the states mean

- **Enabled**: a supported command or URL is declared and turned on. This does not establish sign-in, project trust, native policy, or session access.
- **Disabled**: an explicit disable was found in the inspected configuration.
- **Invalid declaration**: the entry has no supported transport or has an invalid structure.
- **Not found**: no matching declaration was found in the inspected sources. **Unknown** replaces this when a source could not be read or the inventory was truncated.

Offline, denied, loading and failed scans are shown separately from an empty inventory. Partial scans retain an incomplete-results notice. Matching names across clients are a comparison aid; they do not prove identical servers or accounts.

## Sources and boundaries

The execution host reads Codex's `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) and Claude's user `.claude.json` (respecting `CLAUDE_CONFIG_DIR`). It also reads the MCP servers of enabled plugins: Codex plugins listed under `[plugins]` (the newest cached version under `$CODEX_HOME/plugins/cache`, its `.mcp.json` and `.app.json` connectors), and Claude Code plugins enabled in `settings.json` and installed under `~/.claude/plugins`. Outside project context every Claude Code local-scope entry (`projects.<folder>.mcpServers` in `.claude.json`) is listed with the folder's base name only; Claude Code loads such an entry only when it runs in that folder. In project context it reads the registered root's `.codex/config.toml`, `.mcp.json`, the exact folder entry in Claude's user file, and Claude user/project/local settings for explicit disables.

Rows are grouped as your connections, servers that come with plugins, and servers Claude Code loads only in one folder ("Only in one folder (Claude Code)", each row reading "Claude Code, only in <folder>"). Folder entries carry the folder's base name, the server name and the transport, never headers, environment values, arguments or full paths. Reading another machine's inventory needs `filesystem:read` on that machine; agents' connection tools list only SpecWithCode project connections and never these entries. Other AI tools get a column once their user file exists: Claude Desktop, Gemini CLI, Copilot CLI (`~/.copilot/mcp-config.json`), Cursor, OpenCode and Windsurf.

## Managing servers

The library edits user files only, on the selected machine; plugin bundles, project files and private-project entries are never written.

- **Add server** writes a command or URL server to each ticked tool in that tool's format (Codex TOML, `mcpServers`, OpenCode `mcp`, Gemini `httpUrl`, Windsurf `serverUrl`, Copilot `tools: ["*"]`). A taken name is refused. Claude Desktop takes command servers only.
- **Turn off / Turn on**: Codex gets `enabled = false` and OpenCode `enabled: false`. Tools without an off switch have the entry moved to SpecWithCode's state folder (`<state>/connections/parked.json`, owner-only) and listed as Disabled; Turn on writes it back unchanged.
- **Remove** deletes one tool's entry (a Codex table with its sub-tables). **Add to all tools** copies a portable entry to every installed tool that lacks the name and can run it.
- **Plugins** lists installed Codex and Claude Code plugins; the toggle flips `[plugins."<key>"] enabled` or `enabledPlugins` in Claude's user `settings.json`.

Every action is previewed first: the machine names each file and shows the entry with environment, header, URL-query and secret-shaped values masked, and writes nothing. Saving keeps a backup of every file under `<state>/connections/backups/` (the newest 20) and returns a change id; **Undo** restores all of a change's files only if each still reads what the change wrote. A file changed between the read and the write is never overwritten. Tools read their configuration at start, so a running tool picks a change up when it restarts. `connections.nativeApply` requires filesystem write and terminal operate permission.

Codex project tables inherit unspecified fields from same-named user entries. Claude private-project declarations override shared project declarations, which override user declarations. Plugin servers run beside same-named user entries and never shadow them. These are configuration observations; native clients remain responsible for actual admission. claude.ai and other account connectors live in the account rather than in files and are not listed. Managed settings, ancestor files and alternate client profiles are outside this inventory.

The protected `connections.nativeRead` RPC requires filesystem read permission on the destination environment. It accepts an optional registered project ID, never a browser-supplied filesystem path. Each file is limited to 2 MiB and 200 declarations, and at most 200 plugins and projects are inspected. Returned metadata excludes command text, arguments, URLs, headers, environment values and credentials. Discovery launches no server, performs no network probe and changes no native configuration; only an explicit apply writes.

SpecWithCode grants control SpecWithCode-managed calls only. This release does not import native connections into those grants or enforce native-client access through SpecWithCode toggles.

## Verification

Focused tests exercise filesystem parsing, project isolation, precedence, redaction, bounds, missing and malformed sources, service routing, RPC permission rejection and matrix states. The headless fixture mounts the actual settings library, panel and matrix with synthetic machine/query state; it verifies switching machines and projects, errors, narrow layout and production CSS. It is not proof of a native session or installed-app acceptance.

Use Node 22.20.0. Build the fixture with `node node_modules/vite-plus/bin/vp build --config apps/web/tests/connections-library/vite.config.ts`, then run `node scripts/studio-verify/connections-library.mjs`. Evidence is written to `reports/connections-library/`. Production builds remain required for web and server.
