# Team rules

Team rules let a company set limits for everyone using SpecWithCode on a machine. An administrator
places one JSON file on the machine. Rules only tighten: they never raise anything and never rewrite
your settings, so your own choices come back if the file is removed.

## The file

The app reads the file from one fixed path. No setting, environment variable or home directory can
change it.

| System  | Path                                                        |
| ------- | ----------------------------------------------------------- |
| macOS   | `/Library/Application Support/SpecWithCode/team-rules.json` |
| Windows | `C:\ProgramData\SpecWithCode\team-rules.json`               |
| Linux   | `/etc/specwithcode/team-rules.json`                         |

Make it writable only by an administrator. Every user can read it, so never put a credential in it;
variable names that look like credentials are an error.

```json
{
  "version": 1,
  "owner": "Acme Engineering",
  "contact": "https://it.acme.example/ai",
  "ai": {
    "providers": ["claudeAgent", "codex"],
    "models": ["claude-*", "gpt-*"],
    "pin": { "claudeAgent": { "environment": { "CLAUDE_CODE_USE_BEDROCK": "1" } } }
  },
  "agents": { "ceiling": "auto-accept-edits", "routines": "approval-required" },
  "reach": { "phones": false, "connect": false, "machines": "same-rules", "webhooks": false },
  "tools": { "chrome": false, "computerUse": false, "google": false, "telegram": false },
  "telemetry": { "export": false }
}
```

| Key                 | What it does                                                                |
| ------------------- | --------------------------------------------------------------------------- |
| `owner`, `contact`  | Named on every lock and refusal                                             |
| `agents.ceiling`    | The broadest permission mode for people and agents                          |
| `agents.routines`   | The broadest mode for routines; the tighter of this and the ceiling applies |
| `ai.providers`      | Providers that may start. Others stay listed as disabled                    |
| `ai.models`         | Allowed model names; `*` matches any text                                   |
| `ai.pin`            | Environment, launch arguments and binary path for a provider                |
| `reach.phones`      | `false` refuses phone pairing and phones already paired                     |
| `reach.connect`     | `false` refuses SpecWithCode Connect and stops a running tunnel             |
| `reach.machines`    | `any`, `same-rules` or `none`: which machines this one works with           |
| `reach.webhooks`    | `false` refuses webhooks and webhook routines                               |
| `tools.*`           | `false` turns off `chrome`, `computerUse`, `google` or `telegram`           |
| `telemetry.export`  | `false` turns off OTLP export                                               |
| `connections.allow` | Connection names agents may use; `*` matches any text                       |
| `updates.automatic` | `true` or `false` locks automatic updates on or off                         |
| `updates.feed`      | Where your team delivers updates; turns off the app's public feed           |
| `zones`             | Further limits for repositories matched by Git remote; see below            |

Unknown keys are errors.

## Zones

A zone in the machine file adds limits for the repositories whose Git remote matches.

```json
{
  "version": 1,
  "owner": "Acme Engineering",
  "zones": [
    {
      "remote": "github.com/acme-regulated/*",
      "ai": { "providers": ["claudeAgent"], "models": ["claude-*"] },
      "agents": { "ceiling": "approval-required" },
      "connections": { "allow": ["github"] }
    }
  ]
}
```

Remotes are compared without their scheme, user, port or `.git` suffix, and the host in lower case, so
`git@GitHub.com:acme-regulated/api.git` matches the pattern above. Every matching zone applies, and a
repository with several remotes matches on any of them, so adding a remote can only tighten. A zone
cannot set `ai.pin`.

If the machine file has zones and a folder's remotes cannot be read, agents pause in that folder and
nowhere else. A folder that is not a Git repository matches no zone and keeps the machine's rules.

## Repository rules

A team can commit `.specwithcode/team-rules.json` to a repository:

```json
{
  "version": 1,
  "owner": "Payments team",
  "ai": { "models": ["claude-*"] },
  "agents": { "ceiling": "auto-accept-edits", "routines": "approval-required" },
  "connections": { "allow": ["github"] }
}
```

It needs `version` and `owner`, may name a `contact`, and may set only `ai.providers`, `ai.models`,
`agents.ceiling`, `agents.routines` and `connections.allow`. The app reads it from the remote-tracking ref of the default branch, such as
`origin/main`, and never from the working tree, so an agent editing the file in a checkout changes
nothing. A change applies once it is merged and fetched.

A file that is committed but broken pauses agents in that repository only. The default branch is the remote's `HEAD`, else its `main`, else its `master`; a repository with none of
those has no repository rules. The app shows these rules as **a team
agreement, not a security boundary**: anyone who can push to the default branch can change them.

Repository rules work without a machine file. Then there are no records, and reach, tools, telemetry and
updates stay untouched. Zones live in the machine file.

## How rules combine

Every source only tightens. For one working folder the machine file, each matching zone and the
repository's file combine to the strictest: the lowest ceiling, the providers on every list, and a model
or connection that fits every list. Each refusal names the source that set the limit. Machine
reach, tools, telemetry and updates come only from the machine file, and `same-rules` compares only
the machine file's fingerprint.

## Connections

`connections.allow` decides which project connections can be used, by name; `*` matches any text. A
connection off the list cannot be saved, checked or called, and a native connection off the list cannot
be turned on, and the refusal says who set the list. Anything already saved stays stored, and comes back if
the rule changes.

## Updates

`updates.automatic: false` stops automatic checks and downloads; updating by hand stays.
`updates.automatic: true` keeps automatic checks on and locks the switch. `updates.feed` names the
address your team uses and turns off the app's public feed, including **Check now**, **Install now** and
server self-update. The app never downloads from that address: deliver updates with your own tooling.

## Companion files

`specweave-studio rules companion` prints provider settings that match the rules. Install them
yourself so a provider CLI run outside the app follows the same limits.

| Provider | File                    | macOS                                      | Linux               | Windows                        |
| -------- | ----------------------- | ------------------------------------------ | ------------------- | ------------------------------ |
| Claude   | `managed-settings.json` | `/Library/Application Support/ClaudeCode/` | `/etc/claude-code/` | `C:\Program Files\ClaudeCode\` |
| Codex    | `requirements.toml`     | `/etc/codex/`                              | `/etc/codex/`       | `%ProgramData%\OpenAI\Codex\`  |

`--output <new folder>` writes the two files there instead of printing; nothing is installed and no rule
changes. Anything a provider cannot express is listed as a note. Claude's connection list is a
convenience, not a security control.

## Records

`specweave-studio rules records` prints one JSON object per line: this machine's events and settings
changes, with the person and device behind them. `--since` and `--until` limit the dates, and
`--output <new file>` writes a private file. Person and device are recorded only while a machine file
exists. Records stay on this machine, nothing uploads them, and message text and setting values are never
exported; settings changes name only the paths that changed.

## Commands

```bash
specweave-studio rules check             # exit 0 for valid or absent, non-zero for invalid
specweave-studio rules check --file x.json
specweave-studio rules show              # rules, fingerprint, path and what they cannot do
specweave-studio rules show --json
specweave-studio rules explain --mode full-access
specweave-studio rules explain --provider codex --model gpt-5
specweave-studio rules check --repository .          # the committed repository rules
specweave-studio rules check --repository-file x.json
specweave-studio rules show --repository .           # adds this folder's zones and repository rules
specweave-studio rules companion
specweave-studio rules records --output records.jsonl
```

`--file` validates a candidate and has no effect on enforcement.

## What people see

- **Chat permission menu**: modes above the limit are disabled and read "Above your team's limit".
- **A chat already above the limit**: a notice offers one click to switch down. Until then, its next
  message is refused rather than run at a lower mode without telling anyone.
- **Settings**: controls the rules decide say "Set by Acme Engineering", and General settings gains a
  Team rules section.
- **Models**: unapproved models do not appear in pickers. Fallback at a usage limit stays inside the
  list and stops with a reason when nothing is left.
- **Routines**: a routine above the limit is refused at save and fails at run with a recorded reason.
  Rules are checked again at every run.

- **Machines**: each reachable machine shows its rule fingerprint, and a machine with different rules,
  no rules or a broken file is flagged.
- **Phones, Connect, webhooks and tools**: the rows the rules turn off say "Set by Acme Engineering", and
  older clients get a refusal naming the owner. Disconnecting a Google account or unpairing Telegram
  stays available.

- **Projects**: Project settings and the chat notice name the zone or repository that set a limit.
- **Connections and updates**: a connection off the list says who refused it, and locked update switches
  say "Set by Acme Engineering".

Without a rules file, a matching zone or committed repository rules, none of this appears.

## Reach

Turning off a path keeps its stored state. Phone sessions fail authentication and their sockets close,
but nothing is revoked, so removing the rule brings the phone back and other machines keep it. A Connect
tunnel stops within five seconds and link secrets stay. During a hold, existing tunnels, sessions and
machine links keep running so the file can be repaired, while new pairings, links, webhooks, outgoing
work and agent tools are refused. Work other machines send to this one keeps arriving during a hold, and
its turns stay held until the file is fixed.

`reach.machines: "none"` refuses every credentialed call between machines and every folder copy, project
link, invite and join. `same-rules` allows a machine only when its fingerprint equals this one's, checked
on both sides at each call. A machine with no rules, a hold or an older build counts as different. Probes
without a credential still run, so Machines stays accurate. Fallback machine targets follow the same
rule, and with none left the same-machine fallback runs as usual.

## Work crossing machines

Work sent to another machine carries a ceiling: the stricter of the sender's ceiling and any the thread
already carries. The working machine enforces the stricter of its own rules and the carried ceiling, also
with no rules file of its own, for the thread and its children. Back on the machine that set it, that
machine's live rules decide.

A coordinator with a ceiling refuses to send a thread to a machine too old to hold one. A project move
lowers the mode at the source first, so an older destination starts inside the ceiling but does not keep
it afterwards. A thread that carries a ceiling cannot schedule routines.

## Changing and repairing the file

Changes apply without a restart. A tightening applies to the next turn; a turn already running
finishes under the rules it started with. Turning off telemetry export applies to the OTLP exporter
at the next server start.

If the file is invalid, the machine goes on **safe hold**: no agent turn starts, while the app and
your connection to the machine keep working so the error can be read and fixed. Telemetry export
is treated as off at the next start. Providers stay as the last good rules set them, so a typo revives
nothing those rules blocked. A machine that starts on a hold starts no provider. Fixing the file releases
the hold, and provider checks run again.

## Provider launch

Under a ceiling below Full access, a provider or model list, or a pin, launch arguments, environment,
binary path, ACP command, server URL and API endpoint come only from the rules. A flag or endpoint
could otherwise change the mode or send work outside the list. This removes API keys stored in a
provider's environment variables, so sign the CLI in another way or arrange access with your
administrator.

Sign-in cannot start for a provider off the list or during a hold. ACP sign-in discovery, sign-out and
session management stop in the same cases, and ACP endpoint changes are refused under these rules.

## What it cannot do

- It is not a sandbox. It decides what the app asks providers for.
- A person with administrator rights can edit the file. Only device management can stop that.
- Provider CLIs run outside the app read their own configuration. Inside the app, Claude also loads
  its user, project and local settings, so its allow rules still apply.
- A provider's home directory setting can point it at other credentials or configuration.
- Host and login-shell environment, such as `ANTHROPIC_BASE_URL`, still reaches providers.
- Version checks, account checks and the Chrome bridge can still run a stored binary path, including during a hold, though not for an agent turn.
- Terminals run what the person types.
- `same-rules` compares fingerprints a machine reports about itself. It catches drift, not a hostile
  machine.
- A client reports its own device type, so phone rules cannot catch a client that lies. Phone links are
  always caught.
- Links a person drives from a browser name no rules, so `same-rules` checks the machine they came through.
- iPadOS Safari reports itself as a Mac, so `reach.phones` treats it as a desktop unless it paired through a phone link.
- A machine's own browser sessions opened through a coordinator are checked against `same-rules` when they start, and folder copies check only `none` and a hold.
- Codex's own browser and computer tools are not turned off by `tools.chrome` or `tools.computerUse`.
- A machine with a grant can claim to have set a carried ceiling itself, which drops it there. Grant work only to machines you trust.
- A carried ceiling limits the permission mode. The model list stays with each machine's own rules.
- A restart during a hold restores a stored Connect tunnel. The rules stop it again once the file is fixed.
- Older builds ignore the file. Device application control handles that.
- Windows reads the default `C:\ProgramData` location, even when ProgramData has moved.
- Repository rules are a team agreement, not a security boundary. They bind only people using SpecWithCode on that repository, anyone who can push to the default branch can change them, and they reach a machine only after a fetch.
- Repository rules cannot loosen anything, set a provider's launch, turn off reach or tools, change telemetry or updates, or affect another repository.
- A zone trusts the folder's Git remotes, which the person controls. It catches honest use, not someone renaming a remote.
- Anyone who can run a shell in the repository, agents included, can move the remote-tracking ref or change remotes, so repository rules and zones bind cooperative use.
- A folder that is not a Git repository matches no zone, even if it holds a client's repository.
- Repository rules are read from `origin`, or from the only remote when there is one. With no zones on the machine, a repository whose Git read fails keeps its last good rules, or none if it has never been read.
- The decision model, task routing and importing an agent session judge the machine's rules. The first turn in that folder still meets the folder's.
- `connections.allow` covers project connections and turning on native ones. Provider CLIs load their own configured servers; use `rules companion` for those.
- `updates.feed` does not download or install anything. Your own deployment delivers those updates.
- `rules companion` files bind a provider CLI only where you deploy them, and only for what that provider can express.
- Records are not tamper evident while agents run as the same OS user as the database. Person and device come from the client's session, and records begin when machine rules appear.
