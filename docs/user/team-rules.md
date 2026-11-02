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

| Key                | What it does                                                                |
| ------------------ | --------------------------------------------------------------------------- |
| `owner`, `contact` | Named on every lock and refusal                                             |
| `agents.ceiling`   | The broadest permission mode for people and agents                          |
| `agents.routines`  | The broadest mode for routines; the tighter of this and the ceiling applies |
| `ai.providers`     | Providers that may start. Others stay listed as disabled                    |
| `ai.models`        | Allowed model names; `*` matches any text                                   |
| `ai.pin`           | Environment, launch arguments and binary path for a provider                |
| `reach.phones`     | `false` refuses phone pairing and phones already paired                     |
| `reach.connect`    | `false` refuses SpecWithCode Connect and stops a running tunnel             |
| `reach.machines`   | `any`, `same-rules` or `none`: which machines this one works with           |
| `reach.webhooks`   | `false` refuses webhooks and webhook routines                               |
| `tools.*`          | `false` turns off `chrome`, `computerUse`, `google` or `telegram`           |
| `telemetry.export` | `false` turns off OTLP export                                               |

Unknown keys are errors. `connections`, `updates` and `zones` are validated and reported as declared,
but this version does not enforce them.

## Commands

```bash
specweave-studio rules check             # exit 0 for valid or absent, non-zero for invalid
specweave-studio rules check --file x.json
specweave-studio rules show              # rules, fingerprint, path, enforced and not enforced
specweave-studio rules show --json
specweave-studio rules explain --mode full-access
specweave-studio rules explain --provider codex --model gpt-5
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

Without a rules file, none of this appears.

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
