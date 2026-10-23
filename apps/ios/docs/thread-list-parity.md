# Thread lists on iPhone

Recent chats use local calendar days: Today, Yesterday, Previous 7 days (2–7), Previous 30 days (8–30), Older. Future timestamps count as Today. Empty groups stay hidden. The drawer initially shows eight chats and offers Show all for the retained thirty-chat window.

Project threads use Waiting on you, Working, Idle and Resolved. Pending input and proposed plans need attention; active work takes precedence over a resolved mark. A quiet held queue needs attention even if resolved. Quiet failures and unresolved blockers wait on the user. Unreachable threads appear in Idle with their last-known status explicitly marked Unknown on the row. Resolved history remains expandable.

Date grouping and row ordering use creation, latest user message and latest run request, so streaming output does not repeatedly move a row. Pinning is retained within project state groups. The existing Threads control opens the project's grouped list; choosing a project still opens its coordinator.

Each recent, project and search thread row shows a provider mark and a smaller model vendor mark, plus explicit provider/model text. A cross-vendor pairing such as GitHub Copilot with Opus shows both Copilot and Claude marks. Thread details expose the full names. Unknown brands use the neutral chip glyph and preserve the identifier. Catalog names take precedence over known-id formatting. The optional authoritative shell model identity supplies the current running/fallback model; older servers use the saved selection.

Vector PDFs are bundled copies of the desktop provider marks, converted with rsvg-convert. Monochrome assets follow the foreground in light/dark appearances; colored assets retain their original colors. Sources and trademark provenance are shared with the desktop provider-logo documentation. Icons load locally and require no network request. ACP Registry brands are accepted only from official, credential-free CDN icon identities, never display names.

Verification uses the deterministic `thread-lists` fixture, Swift tests and the `ThreadListParityUITests` simulator class. It checks date boundaries across DST, stable activity timestamps, state precedence, custom identities, cross-vendor models, all five date headings, light/dark project screenshots, expanded resolved history and navigation. Routine checks run on a dedicated headless simulator via `make sim-build` and `make sim-test`; no physical phone is involved.
