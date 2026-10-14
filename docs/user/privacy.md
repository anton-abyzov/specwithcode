# Data and privacy

Open **Settings > Data & privacy** to inspect diagnostic export settings and prepare a voluntary support report.

Chat history, uploaded attachments, server settings, provider activity and diagnostic logs are
stored on the selected environment's host. Drafts, preferences and cached interface data can also
remain on the viewing device, including when that environment is remote. Drafts can include prompts,
attachment details and selected terminal text. Local provider logs and terminal output
can contain conversation content, paths or other sensitive data. Do not share an entire logs
directory without inspecting it.

Starting an agent turn sends the context required for that turn to the selected provider. Connected
services receive the requests you initiate. Those providers and services have their own privacy
policies; SpecWithCode's diagnostic report controls do not change their processing or retention.

Product usage collection is off by default, with no built-in PostHog destination. It is enabled only
through the server's environment configuration; see [Product usage data](telemetry.md). The privacy
page shows the selected server's startup collection settings. Older servers show unknown until
updated. These settings are not proof that an event was delivered. When collection is disabled or
no destination is configured, the analytics service does not read native provider account files or
create a telemetry identifier. Operator setup instructions are under **Technical details**.

Local tracing and explicitly configured OpenTelemetry export are separate from product usage
events. The privacy page shows whether trace, metric or log export is configured on the selected
environment. External exporters may carry diagnostic information to the configured collector.

## Voluntary support report

Choose **Preview diagnostic report** to read a bounded diagnostic summary from the selected
environment. The request uses the existing diagnostics permission; accounts without that permission
cannot prepare a report.

The report includes application and server version numbers, operating system and architecture,
diagnostic export flags, trace counts, and aggregate failure categories. It excludes arbitrary
error text, raw logs, prompts, responses, files, attachments, credentials, account or conversation
identifiers, paths, connection addresses, and process commands. Failure categories describe a
bounded sample, not every failure in the environment.

Review the exact JSON preview, check **I reviewed this report and want to save a copy**, then choose
**Save report**. This saves a JSON file on your device. There is no automatic upload or support
submission; you decide whether and where to share the file. Switching environments or preparing
a new preview resets the review choice. Raw-log sharing and automatic crash reporting are not
implemented by this feature.
