# Product usage data

Product usage data is off by default. A SpecWithCode server records and sends nothing unless
you turn collection on, and no PostHog project is built in.

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
