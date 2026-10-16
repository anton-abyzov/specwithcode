# Claude

SpecWithCode uses Claude Code's login and configuration. Start with the default provider
for one account; [provider setup](./install.md#providers) covers installation and
shared provider settings.

## Separate accounts or configurations

Use a separate Claude config directory for each account. This also works for named
presets that need different Claude settings or a router connection.

Keep your existing account in the default directory. On the environment's machine,
create the second login:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add another Claude instance in **Settings > Providers**:

| Instance        | Binary path | CLAUDE_CONFIG_DIR path |
| --------------- | ----------- | ---------------------- |
| Claude Work     | `claude`    | Leave empty            |
| Claude Personal | `claude`    | `~/.claude_personal`   |

An empty config-directory setting uses Claude Code's normal configuration. The
custom setting changes `CLAUDE_CONFIG_DIR`, leaving `HOME` and the system keychain
location intact. Use the same variable for the login command. Setting `HOME`
instead can put credentials where this provider will not find them.

Check the account reported in provider settings after signing in. Existing
threads can switch only between Claude instances with the same config directory.
Separate account directories stay isolated, including their local conversation
state. Claude does not have Codex's shared-home and shadow-home arrangement.

For presets that differ only in API keys or endpoints, use the instance's
**Environment variables**. Variable assignments do not belong in **Launch arguments**.

Claude Code's verbose mode can stay enabled when you use Claude for text generation, including
thread titles, branch names, commit messages, and pull request descriptions. On a remote connection,
SpecWithCode uses the Claude configuration on the connected server.

## Compact long conversations

SpecWithCode asks Claude to compact at 400,000 tokens unless you change it. Compacting
replaces the conversation with a short summary. Until it runs, every turn resends
the whole conversation; most of it is read from the prompt cache, which is cheaper,
but it still counts toward your usage. On a 1M-context model Claude Code's own
default waits until about 967,000 tokens, so late turns each carry close to a
million tokens. At 400,000 they stay well under half that.

Claude compacts at the smaller of this setting and the model's context window, so
400,000 changes nothing on 200K-context models. That makes it a per-model default
in practice: it only applies to the 1M-context models where the cost builds up.

To change it, set **Auto-compact after** in the Claude provider settings:

- leave it empty for SpecWithCode's default, 400,000;
- enter an integer from `100000` to `1000000`, for example `600000`, to keep more
  of a long session verbatim before it is summarized;
- enter `auto` to leave the window to Claude Code's own settings, including
  anything you saved with `/autocompact` in the terminal.

SpecWithCode passes a number as a session setting, so inside SpecWithCode it takes precedence
over `/autocompact`. Each Claude provider instance keeps its own value, so you can
keep a second instance for long research sessions with a larger window.

SpecWithCode leaves Codex's compaction to Codex. Codex decides when to compact from the
model's own window; to cap it, set `model_auto_compact_token_limit` in
`~/.codex/config.toml`, and SpecWithCode's Codex sessions follow it.

You can also send `/compact` in an existing conversation. Web and desktop offer
**Compact context** from the context meter and may suggest it when you return to
a large older thread. See [commands and skills](./composer.md#commands-and-skills)
for using composer commands.

## Usage limits

If your Claude subscription runs out of usage mid-turn, the thread shows which
limit was reached and the remaining wait when Claude provides a reset time.
Claude Code holds the turn until that window reopens, so it can keep showing as
working. Wait for the reset, or stop the turn and continue later. The warning's
timestamp shows when the displayed wait started.

## Skills

Claude skills come from the config directory's `skills` folder and the project's
`.claude/skills` folder. If both define the same name, the config-directory copy
wins. Skills disabled in Claude's settings do not appear in the composer.

Use `$` in the composer to select a skill. Skills marked `disable-model-invocation`
can still be started by you. Invoke those one per message: Claude directly runs
only the last named skill and may try to start earlier ones through its Skill
tool, which refuses skills reserved for manual invocation.

## OpenRouter

Create a Claude instance with its own config directory, such as
`~/.claude_openrouter`, and keep **Binary path** set to `claude`. In that instance's
**Environment variables**, use:

| Variable               | Value                                     |
| ---------------------- | ----------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`               |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key, marked Sensitive |
| `ANTHROPIC_API_KEY`    | An explicitly empty value                 |

If that Claude config directory has a cached Anthropic login, run `/logout` in a
Claude Code session using that directory before starting the router setup. Cached
login credentials can conflict with the router token.

Select the model you want in SpecWithCode. For an OpenRouter model outside the built-in
list, open that Claude instance in **Settings > Providers** and add its full model
ID with **Add custom model**. Then select it in the chat model picker.
`ANTHROPIC_DEFAULT_*_MODEL` variables map Claude Code aliases such as `sonnet`; they
do not replace the explicit model ID selected in SpecWithCode. Custom models may have
fewer effort, thinking, or context controls than built-in models.

Verify the model used in OpenRouter's activity dashboard. For current compatibility
requirements, use the
[OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).

## Other routers

A local router uses an ordinary Claude provider instance. Give it a separate
config directory and put the router's endpoint and credential variables in that
instance's **Environment variables**. The router must run where the environment
can reach it. Follow the [Claude Code Router instructions](https://github.com/musistudio/claude-code-router)
for its installation and routing configuration.
