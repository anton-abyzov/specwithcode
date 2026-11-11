# Product usage data

Product usage data is off by default. A SpecWithCode server records and sends no usage events
unless you turn collection on, and no PostHog project is built in. Automatic crash and error
reports are separate and on by default; see [Crash and error reports](#crash-and-error-reports).

Disabled or unconfigured collection also avoids reading native-provider identity files and creating a telemetry
identifier. Local diagnostics and explicitly configured OpenTelemetry export are separate; see
[Data and privacy](privacy.md) for a voluntary support-report workflow.

To turn it on, set `STUDIO_TELEMETRY_ENABLED=true` in the server's environment before starting it,
together with `STUDIO_POSTHOG_HOST` and `STUDIO_POSTHOG_KEY` for the PostHog project that should
receive the events. The server then sends product usage events there, associated with a hashed
account or installation identifier. Events include the provider, model, reasoning effort,
permission mode, turn result, duration, and main-agent token totals when available.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

To turn collection off again, remove `STUDIO_TELEMETRY_ENABLED` or set it to `false` and restart
the server. This stops product events from being recorded or sent.

The desktop app reads `STUDIO_TELEMETRY_ENABLED` from your shell profile (for example `~/.zshrc`)
on macOS and Linux, so export it there and restart the app. It does not read the two PostHog
variables from the profile; they must already be in the environment the app starts in. On
Windows, set all three as user environment variables.

## Crash and error reports

When the app, the server or the mobile app crashes, or a turn fails, SpecWithCode sends a short
crash report automatically. This is on by default so failures can be found and fixed without you
having to file them.

Each report is a small JSON object with these fields:

- `installId`: a random id created once per installation and kept in a file in the app's data
  folder. It is not your account id and is not linked to it.
- `machine`: a coarse label made of the OS, the architecture and the first characters of a hash
  of the install id together with the machine name. The machine name itself is not sent, and the
  label cannot be matched against a list of likely names.
- `surface` (desktop, server or mobile), `kind` (for example uncaught exception, renderer
  gone or turn failed) and `category`, the failure category.
- `appVersion`, `os`, `osVersion` and `arch`.
- `provider` and `model`, only when the failure came from an agent turn.
- `errorName`, `message` and `stack`: the sanitized error. In messages, paths become `<path>`,
  file names `<file>`, server names and URLs `<host>`, a failed command line `<command>`, and
  quoted text other than a plain identifier `<redacted>`. A stack line keeps the function name
  and the code file (not the folder it is in). Your user name, the computer's name, secrets,
  email addresses, ids and IP addresses are replaced before anything leaves the machine. A failed turn sends no `message` or `stack` at all,
  because a provider's error text can quote a prompt or a reply.
- `detail`, a few short values such as an exit code, and `count`, how many identical reports were
  folded into this one.

Reports never include prompts, responses, file contents, account ids, conversation, thread or
project ids, or raw paths. Removing names and secrets from error text works by rules, so it is
best effort: an unusual error message can still carry a name or value the rules do not
recognise. Turn reports off if that is not acceptable for your work. A report is capped at 16 KiB.

Reports go to the SpecWithCode relay on Cloudflare at `relay.spec-weave.com`. The relay checks
each report again and writes it as one log line in Cloudflare Workers Logs. Reports are kept only
as long as Workers Logs keeps them and are then deleted. Nothing else stores them.

Sending is best effort. A report that cannot be delivered is dropped after a short timeout, and
sending never slows down startup or shutdown.

To turn crash reports off, open **Settings** > **Data & privacy** and turn off **Send crash and
error reports automatically**. You can also set `STUDIO_CRASH_REPORTS=false` in the server's
environment and restart it; the switch then shows as off and cannot be turned on. The desktop app
reads `STUDIO_CRASH_REPORTS` from your shell profile like the other variables above, so export it
there and restart the app. On Windows, set it as a user environment variable. When reports are
off, nothing is sent and no report files are written. Team rules with `telemetry.export: false`
turn reports off as well, on the server and in the desktop app, and so does a rules file that
cannot be read.
