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
| `telemetry.export` | `false` turns off OTLP export                                               |

Unknown keys are errors. `reach`, `tools`, `connections`, `updates` and `zones` are validated and
reported as declared, but this version does not enforce them.

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

Without a rules file, none of this appears.

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
- Older builds ignore the file. Device application control handles that.
- Windows reads the default `C:\ProgramData` location, even when ProgramData has moved.
