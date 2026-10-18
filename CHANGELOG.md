# Changelog

## Unreleased

- **Gemini 4 Argon** is in the Gemini CLI model picker once the agent's models load. Gemini CLI 0.63.0 runs Argon but leaves it out of its catalog, so before this it had to be typed as a custom model. Gemini CLI turns now record their token usage (from the agent's `_meta.quota` report); before, every Gemini CLI turn showed no usage. Provider setup explains how to run Argon on Vertex AI so it bills Google Cloud credits, such as startup credits.
- Settings > Connections no longer leaves half the window empty. The MCP connections card was its own full-height page stacked on the rest of Connections, so it took half the window however little it showed; it is now a normal section sized to its content, below Your private machines. Machines are a compact list, one line each with the same status the machine picker and sidebar show ("Connected", "Can't reach. Retrying automatically" with last seen) and a Connect machine button on the right; automatic connection and Add a machine are rows in the same card with one-line help. The MCP machine picker and the workers' access picker use the app's grouped dropdown instead of the browser's native select.
- A chat spends fewer lines on chrome. The folder, run time and plan share one line above the conversation; a thread with no plan yet shows a small "No plan" chip instead of a full-width bar, and the plan takes its own line only when opened. A request another agent sent carries one sender line ("Sent by another agent"); the machine and model it ran on moved to the row under the bubble beside the time and copy button, shown on hover. The thread details card (folder, Open in editor, project scripts, Git) starts closed once a chat has started and opens from the top-right button; a new chat still shows it while you pick its machine and workspace.
- Projects a script or agent creates with a temporary `specweave-studio auth session issue` token, such as release and provider verification runs, are deleted automatically once that token is revoked or expires and none of their threads is still open. Verification runs no longer leave "140 provider verification" projects in the sidebar. Projects added in the app, with `specweave-studio project` or from MCP clients are unaffected.
- Approval cards read more easily: the question stands on its own line, with what happens and the agent's reason below it in smaller text, and "+N more" shows when other approvals are waiting behind it. An option-only question no longer leaves a tall empty composer below the card.
- An answered decision folds into one line in the thread: a check, how many questions were answered, what you chose and "Sent to the agent" with the time. Click it to see each question and its lettered choice. In a narrow panel the choices move to a second line.
- A chat without a project names its own folder. Before the first message its details panel reads "New chat folder" (made when you send) instead of the shared "scratch" folder, with no worktree choice to make; after it, the panel shows the chat's folder by name. The panel no longer offers project scripts or Initialize Git on the shared No project folder, which would have applied to every chat (and a Git checkout there turns No project off). **Turn into project** registers the chat's folder as a project in place, named after the chat; its files stay where they are and the chat stays in Chats.
- A chat whose machine can't be reached can carry on elsewhere. Its banner offers "Continue on M4" when another machine is connected: that starts a new chat there from a summary of this one (the first request and the latest messages) on a ready subscription provider, and opens it. A chat without a project gets a new chat folder on M4, and the banner says its old folder's files stay on M1. The two chats are linked on this device: the old one offers "Open on M4", the new one says "Continued from M1" with Open original. A message typed while the machine is away stays in the composer, marked "Waiting for M1" beside the send button and in the placeholder, instead of only flashing "Not connected: message not sent".
- A machine's status reads the same everywhere and says when it was last connected. A chat whose machine is unreachable shows "Can't reach M1" with the reason and "last seen 2h ago", and a Retry that also works while the app is still retrying on its own (before, it read "M1 is reconnecting" with no reason and no button). The sidebar marks a chat on another machine with a small laptop, and one whose machine can't be reached with a no-signal icon; the tooltip says which machine. Settings > Connections reads "Can't reach: <reason> · last seen 2h ago" instead of "Reconnecting: <reason>". The last-seen time is kept on this device.
- The machine picker in a chat says when a machine can't be reached. A machine whose connection attempts keep failing used to read "Connecting…" indefinitely, as if it were about to connect; it now reads "Can't reach. Retrying automatically" with the last failure (for example "could not establish a WebSocket connection"), and its row retries the connection when clicked instead of sitting disabled. "Connecting…" is kept for a first attempt only. A failed sign-in reads "Connection failed" with its reason, and a closed picker whose chosen machine is unreachable shows "Can't reach" next to its name.
- A new chat shows its reply. The chat view could look the chat up before the first message created it, get "not found" and stop listening, so the reply only appeared after reopening the chat. It now loads the chat as soon as the sidebar lists it. A chat without a project names its working folder "Chat folder" instead of "Worktree" in the thread details.
- The usage chip's "By machine" list is a clean grid. Each machine has one header row with its status ("Online", or "Offline · 4h ago"), and each provider sits under it on one line: icon, name, bar, what is left, and the reset time (shown once it runs low) or the shared-account link in a fixed right column. Columns line up across machines; nothing wraps at any width, and a narrow panel or phone drops the bars first. The provider section below no longer pushes its reset times onto a separate line on phones.
- Reports and documents open on one shared page in every project. The end of a report now scrolls up clear of the window edge (30% of the window below the last line); before, the page stretched to the window's height, so its bottom margin never reached the scroll area and the last line sat on the edge. Prose runs on a shorter line (about 75 characters), and headings sit 2rem below what came before and 0.5rem above what follows, the same for report sections and Markdown headings; a document's opening heading is set as its title. HTML reports opened full window get the same margins and end room at the width they were written for, and scroll as one page.
- Claude threads ask for the 1-hour prompt cache on the main conversation, so a follow-up after a few minutes reads the thread from cache instead of rewriting it. A Claude subscription already got it; an API key, Bedrock or Vertex got 5 minutes, which recorded sessions put at 17% more input cost. Subagents keep the cheaper 5-minute cache. Set CLAUDE_CODE_PROMPT_CACHE_TTL or FORCE_PROMPT_CACHING_5M in the provider environment to choose otherwise; idle compaction then stays off, since a 5-minute cache is gone long before it runs. Usage prices 1-hour cache writes at their real rate (2x input, not 1.25x); Claude cost on the Usage page was about 10% low on input before. Saved usage re-reads live Claude transcripts once.
- **Status page** (account menu > Status, or "Open status" in the command palette): one place to see whether the app, your machines and the providers it depends on are healthy. It shows an overall banner, incidents, and groups for SpecWithCode (local service, MCP and coordinators, updates), Machines (paired machines, Tailscale) and Dependencies (Claude, Codex, Copilot, Gemini, Grok, GitHub). Each service has a 90-day day bar with hover details, an uptime figure and expandable components that list the features that depend on it. Provider levels combine their public status pages with what the app saw itself: sign-in, usage limits and failed turns. Checks run in the background every 5 minutes and never on startup paths; offline checks show as Unknown. History stays on this Mac. A service that stopped without shutting down, such as a crash, is recorded as an incident when it restarts.
- **When a thread finishes** (Project settings > Source Control): Leave branch, Open PR, or Open PR and auto-merge. A thread in its own worktree that finishes with nothing queued gets a pull request into the repository's actual default branch. With auto-merge it merges when ready, or hands the merge to GitHub auto-merge so required checks and branch protection decide. Nothing is force-pushed. The thread shows the outcome ("Merged #123 into develop") and the pull request is linked to it. New projects start on auto-merge; existing projects open PRs.
- A held queue no longer waits forever. A queue is held after Stop, a restart or a provider failure; a message you or another thread sends that runs now releases it, so the held messages run after it in order (wakes, scheduled runs and /compact leave the hold to you). A held thread shows "N queued messages held" with Resume and Discard above the composer, reads "Queue held" in project lists and is listed under "Needs you" in Overview. Agents sending with `studio_thread_send` are told when a message joined a held queue and was not delivered, thread reads and task status count held messages, and `studio_queue_resume` resumes a queue. Held messages no longer count as running work for updates: the updater stops waiting on them and they stay held across the update.
- Threads cut off by a restart or update continue on their own with their queues intact. Messages an update had to cancel are queued again in order, and a held queue starts after the continuation. The thread shows "Resumed after update" (or "Resumed after restart"). Turn it off with Continue threads after restarts. The update warning says which work continues.

- The app calls itself SpecWithCode everywhere you read it. Settings, dialogs, errors, notifications, CLI help, the mobile app's permission prompts, the docs and the MCP tool descriptions and prompts agents read no longer say "Studio" or "SpecWeave Studio"; Studio Connect is now SpecWithCode Connect. Bundle IDs, the `~/.specweave-studio` data home, the `specweave-studio` command and the updater are unchanged, so updates, sign-ins and saved connections carry over.
- `SPECWITHCODE_DISABLE_AUTO_UPDATE=true` turns off automatic updates; the older `STUDIO_DISABLE_AUTO_UPDATE` still works. The README and install docs drop the stale Open Anyway step (releases are notarized since 1.0.32), use the `specwithcode` command and name `~/.specwithcode` as the default data home for new installs.
- New app icon and mark: a white spec page with a folded corner and a `>_` prompt on an indigo tile replaces the woven "S" in the app icon (macOS, Windows, Linux, iOS and Android), favicons, the marketing site, the in-app wordmark, Android splash and notification icons, and the DMG window background. All masters are vector.
- Discover existing Codex and Claude Code MCP declarations in a shared per-machine tool matrix. Project Environment shows project overrides, explicit disables and source details alongside existing SpecWithCode grants. Discovery is read-only; native authentication and runtime access are not inferred from configuration.
- The composer access selector now synchronizes native ACP Allow All permissions. The duplicate toggle is removed, saved model options cannot override access mode, and unconfirmed permission changes block execution.
- Agents write plainer replies in both Concise and Detailed: a short set of writing rules adapted from Lauren Tan's MIT-licensed unslop skill asks them to take a position, give specifics, cut chatbot phrasing and em dashes, and keep whole sentences (about 150 tokens per turn). Generated commit messages, pull request titles and bodies, and thread titles now drop agent credits (agent co-author trailers, session trailers and links, and "Generated with" footers), and replace em dashes and curly quotes, with no extra model call. Remove agent credits on merge now also catches the current footer format and session trailers.
- A project keeps one identity, name and coordinator window across machine handoffs, with threads from its explicitly linked machines and readable earlier coordinator history. Requests retain their recorded machine and model.
- Coordinator transfers fence the source before starting the destination and retain recovery after interrupted responses. Offline hosts and native session continuity limits are visible. Existing independent projects are not automatically merged.
- Project names such as EasyChamp remain consistent in the sidebar, coordinator, settings and handoff review. Renames target the active owner, including when settings are scoped to an older machine.

## 1.0.8 — Coordinator recovery and project navigation

- Project entry, worker links, new-chat shortcuts and checkout changes keep the coordinator in the main pane and open workers beside it. Coordinator and worker model choices remain independent.
- Project usage reports the selected machine and provider profile. Automatic fallback rejects native spend/workspace denials, and a reset estimate accounts for every exhausted usage window. Unknown recovery times remain unknown.
- Native Codex route checks allow up to 60 seconds on busy machines. Verification failures give retry guidance instead of incorrectly blaming custom endpoints; unverified and custom routes remain blocked.
- An unavailable coordinator model still offers **Check again**, another model and provider setup on the correct machine. Rechecking does not resend a message. Unsent text and attachments survive settings navigation within the same window.
- Loading a thread retains only that thread's own cached transcript. A different thread's conversation is never used as its loading placeholder.
- Automatic project-model initialization preserves a model chosen while initialization is still running.
- A failed service update remains visible until its receipt verifies installation and preservation. Rewritten timestamps or missing receipts cannot clear the error.
- Model pickers open provider setup on the selected machine, including when a saved provider is unavailable. Copilot, Grok and Gemini have named setup cards; provider settings distinguish installation, sign-in and model discovery. Usage reporting links to chat setup and explains that quota telemetry does not connect an agent.
- Gemini installation requires an explicit setup action. Repairing a managed agent no longer mistakes a different executable on PATH for its missing managed executable. Additional-folder projects still require Codex or Claude.

Use **Settings → Agents → Response style → Concise** for short agent replies. This existing setting controls generated answers; timeline detail controls their display. Native account limits and required sign-in still apply.

## 1.0.7 — Google sign-in and assistant connection diagnostics

Changes since 1.0.6:

- Official builds now include the Google OAuth client when built from an isolated release checkout. The release check requires the compiled client with runtime overrides absent and verifies the own-client override and removal flow.
- Google tool status explains missing client configuration, sign-in, project access and service permissions. Optional connection checks verify allowed Gmail, Calendar and Drive APIs without returning personal content.
- Personal assistants discover native Google tools separately from external project connections and use direct reads for simple requests. They distinguish a worker's AI usage-limit failure from a Google API failure.
- Provider admission rechecks denied native quota and preserves usage-limit/reset metadata for the existing recovery controls. It respects the configured recovery policy; it does not silently change account choices or repair historical failed workers.

Google account consent and per-project permissions are still required. No database migration was added since 1.0.6.

## 1.0.6 — Update now, coordinator stays on its fallback at a usage limit, steadier turns under load

Changes since 1.0.5:

- Update now installs a service update without waiting for running work (#151). The update toast and Settings offer Update now with a confirmation that lists what will stop. Studio refuses new messages while it updates, interrupts running turns (they end as interrupted and can be resumed), cancels queued messages, closes open questions and terminals, then installs and relaunches. Cancel update withdraws the request before the install starts. If a hung provider or a stray process keeps the service from going quiet, the updater stops those processes under the held service and installs. The request is tied to the version you saw and lapses after 10 minutes, and the desktop shows a splash instead of taking the service port while the update runs.
- The desktop app starts faster: a login-shell probe that ignored SIGTERM no longer holds startup until it times out (#151).
- A provider failure now says why the turn failed, and a turn start that failed for a passing reason is retried (#149).
- A failed install of the current version stays visible after Check for updates, and clears once a verified install of that version succeeds (#150).
- A release asset replaced on GitHub is downloaded again instead of reusing the cached copy (#133).
- A coordinator whose saved model is at its usage limit now stays on the fallback instead of switching back every message (#143). It returns to the saved model once that has room, picks the cheapest fallback first, and never auto-picks a per-token instance.
- A coordinator turn no longer fails with "Provider turn failed" on a busy Mac (#146). The native provider status check now waits up to 60 seconds instead of 15.
- A project opened from the sidebar before git reports its repository no longer sticks on "Project unavailable" (#145).
- Leftover names from the original workbench are gone from fixtures, tests, docs and fleet scripts (#141).
- The updater retries its port check on a busy Mac (#140) and runs its helpers outside darwin background priority (#144).

No database migration was added since 1.0.5.

## 1.0.5 — call the coordinator by voice

Changes since 1.0.4:

- Voice calls with a project's coordinator (#139). A phone button beside Attach in the coordinator composer starts a call: you speak, the coordinator's answer is read back, and you can talk over it to interrupt. Four dots show listening, transcribing, thinking and speaking; Mute, Stop and Hang up are on the call bar.
- Speech stays on the Mac. A small bundled helper transcribes with Apple's on-device speech recognition (SpeechAnalyzer on macOS 26, the on-device recognizer before that) and reads replies with the best installed system voice. No audio is uploaded.
- Permission is asked in three places: a one-time "Allow voice calls?" prompt in the app (Settings › Voice calls with the coordinator turns it off again), the macOS microphone prompt on the first call, and a per-window gate that grants the microphone only while that window has a call running. Signed builds now always carry the audio-input entitlement.

No database migration was added since 1.0.4.

## 1.0.4 — no more stuck "background tasks finished" runs, Claude in Chrome in threads

Changes since 1.0.3:

- A run Studio starts when background work finishes no longer waits forever (#137). When Claude had already handled those notifications inside a running turn, it never opens a wake turn, and the run used to sit in Working with no output until a restart failed it as "Provider turn failed" (seen in the EasyChamp club finance thread: 3 hours, then the 1.0.2 update stopped it). The run now waits 30 s for Claude's wake turn and then settles as completed; a wake turn that does start, streams or hits a rate limit keeps it open as before. An interrupt during that wait still ends as interrupted.
- Claude threads load Claude in Chrome (#137). Headless Claude Code only loads the Chrome tools with `--chrome`, so threads never had them. Studio now follows your Claude Code setting (`claudeInChromeDefaultEnabled`); `--no-chrome` in the Claude launch args turns it off.

No database migration was added since 1.0.3.

## 1.0.3 — Restart to update stops running work, Opus 5.5 with Thinking by default

Changes since 1.0.2:

- Restart to update interrupts running work and shows progress (#134). It cancels queued messages, interrupts every running turn (keeping pull request watches and other delegated work), closes idle agent processes and waits for the outbox, then follows the update through Stopping, Starting, Waiting, Installing, Restarting and Failed (Retry) in one toast. After 20 s of waiting it names what still runs, with Stop them and update. A Claude interrupt waits at most 10 s for the CLI before the turn ends as interrupted.
- Claude subagents run the thread's model instead of Sonnet (#134).
- Projects with no default model get Opus 5.5 on this host's Claude subscription with Thinking on (#134). The pass runs once at startup, never replaces a choice, and new projects get the same default unless Settings names one. An unset Thinking option now reads On.
- Saved coordinators that name no options default to Medium effort with Thinking on (#134).

No database migration was added since 1.0.2. On first start the server writes the new project and coordinator defaults through revision-checked project updates.

## 1.0.2 — coordinator workers on other fleet machines ("use my M1")

Changes since 1.0.1:

- A project coordinator can run its workers on another machine in the private fleet (#120). `studio_thread_launch` takes a `machine` (id, label, environment id or thread link) and starts the worker in the matching project there; `studio_thread_read`, `wait`, `send`, `interrupt` and `list` accept a machine or a two-segment thread link. `studio_machine_list` shows the machines, their grant, providers and matching project. A project's `workerMachine` setting sends its workers to that machine unless told `machine:"local"`. When a remote worker finishes, the coordinator is woken and people see a short notice. Grants are scoped to `orchestration:read` and `orchestration:operate`, renew themselves 7 days before expiry, and Stop revokes them.
- Worker machine controls and remote worker cards (#121). Settings > Connections has a Workers row per private machine: pick the most access a worker gets, optionally paste a pairing code, then Allow workers or Stop workers. Project settings > Worker machine picks where that project's workers run. The coordinator view and Threads pane show remote worker cards with a machine chip, status and "Open on <machine>". The coordinator effort picker marks Medium as Recommended.

No database migration was added since 1.0.1: grants live in the server secrets store and followed workers in `userdata/remote-workers.json`.

## 1.0.1 — long reports as cards, Enter sends everywhere, concise replies by default

Changes since 1.0.0:

- Long reports show as cards (#127). A delegated worker's long final report shows as a compact card with its title, word count, increment chip and opening lines; "Open report" opens it in a reader. When a worker finishes, its report is saved as markdown in `.specweave/increments/<id>/reports/` and the card says "Saved". Every folded block in chat now expands and collapses the same way: collapsed it fades out above "Show full …", expanded a rule marks its edge and a pinned "Show less" stays on screen. An open "Worked for …" turn ends in a "Collapse · Worked for …" row.
- Enter sends in every composer (#129). The coordinator, thread and new chat composers sent nothing on Enter in a desktop window narrower than 640 px. Now Enter sends and Shift+Enter inserts a new line at any width; only a touch device's on-screen keyboard keeps Return as a new line. Enter during IME composition never sends, and the coordinator's Enter follows the same rules as its Send button.
- Concise replies by default (#130). Every agent on every provider gets a response style that is Concise by default: lead with the result, no narration, full detail on request. Worker reports to a coordinator are a short Outcome / Evidence / Blockers result; errors and security warnings are quoted exactly. Settings > Agents > Response style switches Concise / Detailed globally, with a per-project override.

No database migration was added since 1.0.0. Coordinator workers on other fleet machines (#120, #121) are not in this release; they shipped in 1.0.2.

## 1.0.0 — stable release: the app is named SpecWithCode, new app icon

Changes since 0.2.12:

- The installed app is now `SpecWithCode.app`, and "(Alpha)" is gone from the app's name in Finder, the Dock, the menu bar and Spotlight. An install from 0.2.x updates in place as `SpecWeave Studio (Alpha).app`, then on its first launch renames itself to `SpecWithCode.app` and reopens, so you end up with one app named SpecWithCode in Applications. The bundle id, code signature, user data folder and Keychain item are unchanged, so settings, connections, encrypted secrets and macOS permissions (notifications, screen recording) carry over. The rename is skipped when the app cannot write to its folder or when a `SpecWithCode.app` is already there; in the second case, the SpecWithCode app moves the older SpecWeave Studio (Alpha) copy to the Trash. A Dock icon pinned to the old app has to be pinned again.
- 1.0.0 is published as GitHub's Latest release. Release assets are named `SpecWithCode-<version>-<arch>.<ext>`, and `SpecWithCode-arm64.dmg` is the same installer without the version, so `releases/latest/download/SpecWithCode-arm64.dmg` always fetches the newest one. Plain versions get `--latest` and suffixed ones `--prerelease` (`scripts/studio-projects/release-flags.mjs`).
- The service installer and update agent accept 1.x releases after the 0.1.x and 0.2.x alpha line; 0.3.x, 2.x and suffixed versions are still refused, and downgrades still need an explicit rollback.
- A downloaded update waits in `pending-update/staged.noindex`, and desktop rollback copies are zips under `~/.specweave-studio/backups/desktop.noindex` (`scripts/studio-fleet/desktop_backup.py`, which also migrates loose `.app` copies left by earlier release sessions), so Spotlight no longer lists several SpecWithCode apps.
- New app icon and mark (#124, #125): a woven "S" in blue-to-teal ribbons replaces the earlier mark in the app icon (macOS, Windows, Linux, iOS and Android), favicons, the marketing site, the in-app wordmark, Studio tool rows in the timeline, Android splash and notification icons, and the DMG window background.

No database migration was added since 0.2.12. Coordinator workers on other fleet machines (#120, #121) are not in this release; they shipped in 1.0.2.

## 0.2.12 — project archive, timeline detail levels, working coordinator thread links, saved coordinator models

Changes since 0.2.11:

- Projects can be archived (#115). Every project row in the sidebar has an actions menu with "Archive project" or "Restore project"; a project archived on every machine that has it moves under an "Archived (N)" toggle at the end of Projects, muted and marked "Archived", unless it is the open project or has threads waiting on you. Overview, its new-session chooser and the palette's "New thread in" list leave out archived projects. Each machine's Scratch folder no longer shows as a "No project" row under Projects; its chats stay under Chats. `specwithcode project archive|unarchive <id|path>` sets the same flag, live or offline. An archived project keeps its threads, memory, plans and folder, but its threads take no new messages, cannot delegate and are not resumed after a usage limit resets until it is restored.
- The thread's right panel no longer opens by itself (#113). Arriving at a thread from the sidebar, the Threads list, coordinator chips, "View thread" cards, a URL, a reload, Back/Forward or a restart shows it closed; it opens only when you open a surface or press the panel toggle, and one toggle brings back the tab you had selected. A browser tab whose preview session ended no longer leaves the panel open on an empty launcher. Saved panels from earlier versions load closed.
- Coordinator links to workers open them (#116). Links to delegated workers, whose ids contain `%3A`, rendered as empty links that did nothing. Every thread link in coordinator chat is now a chip with a thread icon, a status dot and the live title; a worker in this project opens in the right panel, another project's thread opens in its own project or full page, and a deleted or unknown thread shows a muted dashed chip ("Thread was deleted", "Thread not found on this machine"). Coordinator tools return a ready-made link the coordinator copies.
- Timeline detail has three levels, Concise, Normal (default) and Verbose (#117). Concise hides thinking and the in-between messages of a running turn and summarizes each finished turn ("Worked for 48s · Ran 2 commands and changed 1 file"); in the coordinator only each turn's last reply shows. Verbose opens every fold, tool group and thought, and under each coordinator turn lists what the coordinator did ("Started 1 worker and checked threads") with one line per step. Change it from the list icon in the thread and project headers, Settings > Appearance > Timeline detail, the command palette, or ⌘⌥O / Ctrl+Alt+O (rebindable as `timeline.cycleDetail`). It changes only what is shown.
- A worker started by the coordinator is counted once in Verbose (#118). It was recorded as both the tool call and the worker, so one worker read "Started 2 workers"; a follow-up status check now reads "checked threads" instead of "Used 1 other tool".
- Projects created before workspace settings no longer ask "Choose model for the coordinator" (#114). At startup every active project that names a model of its own (its coordinator thread's model, then its default worker model, then its Settings > Defaults model) gets it saved; a project that names none shows the live host default and saves it on its first coordinator launch. A saved model is never changed. While providers are still being checked after a restart the project view shows "Loading models" instead of the model picker. The service updater now accepts a project row that changed only because that project gained new events during the update, so the first restart on this release, which saves those models as ordinary project events, no longer rolls back with "Existing projects, history or auth rows changed".

No database migration was added since 0.2.11.

## 0.2.11 — project greeting and quick starts, public release feed, stricter update checks

Changes since 0.2.10:

- An empty project opens with a short greeting (in the desktop app, "Hi <name>," taken from this Mac's name, such as "Alex's MacBook Pro", when the project lives on this Mac; "Hi there," otherwise) and three ways to begin under it: Set up from recent work, Connect tools and Make a plan (#110, #111). The two prompt chips fill the composer and focus it, keep a draft already typed, and are disabled while a message is sending; Connect tools opens the project's Connections. The host's project-specific ideas now live only in the Threads pane's "Suggested first threads" list (up to six), and the large cards beside the welcome are gone.
- Releases are published to the public repository `anton-abyzov/specwithcode` (#109). The desktop update feed and release history, the CLI release index, install scripts, the model manifest and issue links now point there, so 0.2.11 and later find their updates without a GitHub login. Fleet scripts read worker hosts and logins from an inventory file (`$STUDIO_FLEET_HOSTS`, default `~/.local/share/specweave/fleet/hosts.json`); the fleet update agent keeps its configured repository.
- The service updater checks the type of every protected cell when a release migrates the database. Before, a pairing credential, a provider or schedule cell, or an earlier event stored as binary data could be rewritten as the same bytes in hex text and the update still counted as preserving everything, because the row fingerprint writes binary data as hex. Such an update now fails and rolls back to the backup. A release may also create the sign-in sessions table on a database that never had one, as long as it holds no session; before, the updater refused that update before it started. A migration may not create a sign-in, pairing, provider or schedule table that already holds rows, change the columns (add, rename, retype), foreign keys or definition of a protected table even when it is empty, or add a trigger that names any of those tables. (#108)

No database migration was added since 0.2.10.

## 0.2.10 — coordinator-only project window, updates no longer blocked by Studio's browser, desktop downloads fixed

Changes since 0.2.9:

- Projects: the main window is only the coordinator (#105). Thread links in a project, including subagent cards, forks, lineage, citations, thread chips, Overview rows, notifications and sidebar rows, open in the project's right panel, and the open thread is in the URL (`?thread=`); a thread on another machine still opens as a full page. The coordinator never opens in the right panel or appears in its Threads list. Thread cards in the coordinator chat show a status dot and, depending on the thread, "View thread", "Create PR" (unshipped work, no open PR) or "View PR"; thread names in coordinator messages are clickable chips with a status dot. When the coordinator waits for an approval, an answer or a plan decision, its chat shows a notice with a button ("Review the request", "Answer the coordinator", "Review the plan") that opens its full page.
- Sidebar: regular chats have their own "Chats" section, separate from "Projects", with Today / Previous 7 days as subheadings. Threads an agent started inside a project stay in that project and are hidden from Chats (filter "Agent threads: Show" brings them back).
- Long final reports from subagents and project workers start folded behind "Show full report", and agents are told to lead with a short outcome and put long tables in a file. The subagent bar is icon-based so it fits narrow panes.
- The strip above the composer for background work shows a kind icon and the command itself (`gh run list …` instead of "Running: ID=$(gh run list …"), the full command on hover, and a stop icon; the mobile pill matches and gains a stop button.
- In-app browser: Local servers are named by page title ("Temporal", "SpecWithCode") with `localhost:port · process` below, and this window's own server is hidden. Links and pages can open in a chosen external browser profile (Chrome, Edge, Brave and others with profiles, e.g. the profile signed in to Google Ads): Settings > Integrations > Browser > "Open links in", and "Open in" in the browser's menu. See docs/studio/browser.md.
- A message to a project coordinator shows progress right away and starts a worker sooner (#101). The coordinator pane shows a live line with what the coordinator is doing ("Checking the project's threads", "Starting a worker", "Waiting for an answer") and how long it has taken, in place of a static "Queued for the coordinator." When a project has no saved worker model, a coordinator's worker now starts on the host's default model, the one a coordinator nobody configured starts on, instead of being refused with "Choose a project worker model or pass an explicit target" and retried; that fallback skips a provider that is out of usage or billed per token. On the installed 0.2.8 build a first project request took 75 seconds to start its worker; on this build a comparable request started its worker in about 16 seconds. The coordinator is also told to hand a new request to a worker at once rather than research it first.
- Subagents a worker starts with its own Task tool are listed under Working while they run, instead of Idle beside a detail view that said "Working" (#101). The subagent's own bar shows a live dot and what it is doing now, such as "Working 15s · Running a command". The Threads pane sorts rows by when each thread last took on work, so busy rows no longer swap places every time one of them streams an update.
- The desktop app downloads updates again. Once a downloaded update had been staged but not installed (for example, because a newer release came out first), every later download reached 100% and then failed with "Electron updater failed to download the update on channel latest." Electron's file API treats an app's `app.asar` archive as a folder, so the updater could not delete the copy it had staged earlier and left it half deleted, and each new download stopped there. The updater now deletes staged copies with the system `rm`, and a failed download shows the underlying reason after that message (#104).
- The service updater no longer waits for a quiet moment forever while Studio's own headless browser is running. The browser that serves agent and preview tabs used to stay up after its last tab closed, and the updater treated it as unknown work beneath the service, so 0.2.9 never installed on M4 (#106). The server now closes that browser once it has been idle for about 5 minutes (checked every minute) and starts it again for the next tab; a close that hangs holds back agent tabs for at most 30 seconds, and a saved profile reopens only after its old browser has exited. The updater recognises the browser by its executable inside the service's own `tools/chrome-headless-shell` directory (as the kernel records it, not the name a process gives itself), its parent (the service itself), and its profile (the service's own `server-browser` profiles or Playwright's temporary one); right before the restart it stops it with SIGTERM, then SIGKILL on the same verified processes after 15 seconds, and refuses the update if anything else is beneath the service. A helper the browser starts while shutting down is waited for too, and an exited process the service has not reaped yet no longer aborts the stop. The receipt records what was stopped under `serverBrowserStop`, including each signal sent, also when the update fails.
- On worker hosts (M1, M3) an update no longer rolls back because the desktop app's own session reconnected during the restart (#106). The updater accepted only the relay's web session there ("Heartbeat is not the supported existing web-browser session", "Heartbeat exceeds the supported existing-session count"). It now also accepts up to four desktop-app sessions (access token, desktop surface) that already existed before the update and changed only their last-connected time inside the restart window. New sessions, changed tokens, scopes or any other column, revoked or expired sessions, and a second web session on a worker are still refused. The receipt names each desktop session that reconnected (`authHeartbeatSessions`: kind, method, surface and a hash of its id); a reconnect of only the web session is recorded as a count.
- Two quick color changes in the project icon picker always save the last one (#106). Changing the color and then back to the saved color before the first save landed kept the middle color, and recoloring right after picking a new icon could bring the old icon back; each pick now builds on the previous pick, and an earlier save reporting back no longer moves the controls. After a failed save the controls return to the saved icon, so the same pick can be retried.
- Preview no longer breaks one-shot sign-in callbacks (#103). Its port scanner, which checks every listening port every 3 seconds, used up the single request that a sign-in such as Antigravity with Google waits for on a loopback port, so that sign-in failed within seconds while any Studio window had Preview open. The scanner now skips Antigravity's own listeners and loopback listeners on ephemeral ports (49152-65535 on macOS and Windows, the system range on Linux but never below 32768) unless a project terminal owns them and they have been up for 60 seconds. Dev servers on normal ports and anything bound to all addresses are found as before. Preview addresses you configure yourself are still checked, and sign-in callbacks on fixed ports (such as `gcloud auth login` on 8085) or bound to all addresses are not protected yet.

No database migration was added since 0.2.9.

## 0.2.9 — compact project icon picker, saved desktop login kept on incomplete replies

Changes since 0.2.8:

- Project icon: the icon now sits inside the Name field ("Name and icon") and opens a compact picker (search, 210 icons, emoji, letters, image, 18 colors, Reset) that saves each pick immediately. Length-limited text fields in settings, project setup and the library show "used / max", e.g. 0 / 8,000 (secret fields such as API keys show no count); the chat composer shows its count only once a message reaches 80% of the limit (#97).
- The desktop app no longer replaces its saved login when the service answers the login check with a reply that lacks a required field or has a wrongly typed one, such as `{}` or `{"error":"service still starting"}` from a service that is still starting (#91, #100). It keeps the saved login and tries again on the next connection. It signs in afresh only when the service says the login is no longer valid or expires soon, or sends a complete login reply that uses values from a newer Studio version. In 0.2.8 any reply with a missing or wrongly typed field counted as "newer version" and could replace the saved login.

No database migration was added since 0.2.8.

## 0.2.8 — steadier desktop sign-in, named CLI versions, safer update rollbacks

Fixes since 0.2.7:

- The desktop app no longer gets stuck with an unusable saved login after the service restarts (#91). If it cannot check the saved login because the service is unreachable, slow, answers with an error or sends a reply that is not readable JSON, it keeps the login and tries again on the next connection instead of holding on to an unchecked one or creating a new session. It signs in afresh only when the service says the login is no longer valid or expires soon, or sends well-formed JSON this app cannot read, as a service on a different version may. A failed check now shows up as an ordinary, retryable connection error in the window instead of breaking the connection setup.
- `specwithcode --version` prints `specwithcode`, and `specweave-studio --version` prints `specweave-studio`; help output uses the same name. Both launchers in `~/.local/bin` keep identical contents and pass the name they were run as; the npm package gives `specwithcode` its own bin file, so npm, pnpm and Windows shims name it too.
- A service update replaces `~/.local/bin/specwithcode` only if what it actually replaces is Studio's own launcher. Before, a file or link that appeared between the check and the write could be overwritten; now the existing entry is checked at the moment it is replaced and put back untouched when it belongs to something else; if the name is taken again during that put-back, the other entry is kept beside it as `.specwithcode.studio-old-<token>` rather than lost. The same applies when a rollback undoes the launcher. A failed write of the `specwithcode` launcher no longer stops or rolls back the update; the receipt records `cliAlias: write-failed-left-as-is`.
- A `specwithcode` launcher written by an earlier Studio release, which may point at a release that has since been deleted, is now recognised as Studio's own and updated, instead of being left alone as if another tool owned it.
- When an update rolls back after the new version has already started, the updater runs all of its checks before it points the service back at the old version. If a check fails, the new version stays configured and running with its database, and the receipt says so (`pointers`, `rollback`, `rollbackError`); the `specwithcode` launcher follows the same release. If restoring the old database or the old pointers fails after the service was stopped, the updater starts the new version again rather than leave a mix; when even that cannot be written, the receipt says `mixed-see-backup`. Before, the old version could be configured while the new one kept running on a possibly migrated database, so the next restart would start the old version on it.
- The updater stops starting new readiness checks on the restarted service after 5 minutes, and never past 8 minutes from the start of the update (a check already under way, which can take about a minute, is allowed to finish), instead of a number of attempts that could add up to more than the update agent's 15-minute limit and leave no time for a rollback. The in-progress and failure receipts record both limits, and the error says how long the service was given.
- The usage-limit recovery card shows the whole reset time on phones. At 320 and 375 px "Resets in 4 days (Thu 3:11 AM)" used to be cut off and needed a tap; it now moves under the title and wraps when needed.

No database migration was added since 0.2.7.

## 0.2.7 — specwithcode command, recovery card layout, steadier updates

Fixes since 0.2.6:

- The release runtime bundle registers both `specweave-studio` and `specwithcode` as commands, and bundle verification rejects a bundle that is missing either. Service updates create `~/.local/bin/specwithcode` with the same wrapper as `~/.local/bin/specweave-studio`. Fleet installs run with `--install-cli` create both launchers or neither, and refuse to start when something already exists at `~/.local/bin/specwithcode`, as they already did for `specweave-studio`. An update replaces a `specwithcode` launcher only when it holds Studio's own wrapper; a link or another tool's file there is left alone, and a rollback undoes the launcher only while it still holds what the update wrote. Install, service and update identities are unchanged.
- The usage-limit recovery card keeps "Usage limit reached" and the reset time readable from phone to wide desktop widths (checked at 320 to 1920 px). Its buttons used to sit in a column beside the title and squeezed it to a few pixels; they now share the line only when there is room and otherwise wrap below, with the status line under them.
- The service updater's process inventory waits up to 30 seconds for `ps` and retries once after a timeout, instead of failing the install after 5 seconds on a heavily loaded Mac. Before the service restarts, a second timeout stops the update and is recorded in its receipt. While the restarted service is coming up, a timed-out inventory counts as "not ready yet" and is tried again; during a rollback it makes the updater restore only Studio's file pointers and leave the running process alone. The updater agent now allows the pre-update snapshot 4 minutes instead of 2.

No database migration was added since 0.2.6.

## 0.2.6 — SpecWithCode name, project skills, device sign-in

The app now shows the name SpecWithCode in its windows, menus and copy, and the command-line tool can also be run as `specwithcode`. The installed app keeps its existing identity, so settings, sign-ins and permissions carry over.

What changes on screen:

- Images and files attached on the project page open in a preview when clicked. A message takes up to 20 images, up to 10 MiB each and 22 MiB in total, and files of any type up to 50 MiB.
- The project page has a one-row header. New projects suggest starter tasks based on the files you work on most.
- The project chooser in settings is searchable and paged, and projects can carry an icon that you edit from the project page.
- Each project has a Skills view in settings that lists the skills its agents can use, with a Rescan button that asks the providers for a fresh scan. The same list is available from the command line with `specwithcode skills`.
- The sidebar footer icons are replaced by one account menu. A new device can ask to sign in, and you approve it from a signed-in device by typing the code it shows.
- The review diff works for registered project roots and for projects in subfolders of linked worktrees.
- The Changes card catches up with edits made outside Studio when a thread is reopened or the page reloads.
- Running Claude workflows appear in the background-work summary with their current phase.
- The desktop app reuses its stored service session across launches and while the service starts, instead of creating a new session on every launch.
- Banners in a thread no longer slide under the workspace card, and the thread panel toggles stay reachable beside the right panel.

Under the hood, this release brings in the branch integration: the final project integration tests, complete native tool output in transcripts, project agent instructions and workflow mode for Claude workflows (the live Claude process is kept when only instructions or workflow mode change during background work), the tutorial recorder walkthrough, a host-independent check for installed workspace settings, and an opt-in `managed-agents status|run --beta` command that runs text workflows through the Anthropic API (it needs `ANTHROPIC_API_KEY`). Service updates now check that the whole database stays continuous across an update, not only the protected rows: logs may only grow, counters may only move forward, and every other table must match.

Also in 0.2.6 (added to this entry after release):

- Project pages work when Studio is opened on a plain HTTP address, such as a LAN or Tailnet IP. They called `crypto.randomUUID`, which browsers offer only on HTTPS and localhost, so actions on the connections, environment, plan, routines and workspace pages and coordinator attachments failed there.
- The visible app name no longer ends in "(Alpha)" in windows, menus and the page title. The installed app's identity is unchanged.

No database migration was added since 0.2.5.

## 0.2.5 — safer updates, native alerts and thread cards

Updates now prove that every existing auth session, credential value and SQLite type survives project migrations. Browser reconnects require a bounded heartbeat proof, and waiting-thread events can append only when every earlier history row remains unchanged. Offline receipt verification checks the actual database when history grew.

The Mac app sends native alerts when a thread needs attention and carries notification clicks to an available window. Project coordinator chats show new threads as compact cards and existing threads as status links. Restart-to-update messages and retry timing are clearer. Mods run in a worker, with read-only SpecWeave progress access and examples for trace checks, standups and close queues. Projects without Google access no longer receive an account email.

No database migration was added since 0.2.4. Existing native account folders remain on their host; their preservation requires separate verification from the Studio database.

## 0.2.4 — update receipts, settings search, banners, starter cards

When the Studio service updater fails before an install is prepared, for example because a prestate check, staging or the version gate failed, it now always leaves a receipt with the cause. `update.py` writes a `phase: preflight` receipt with the error. The update agent keeps the helper's output in a private `.log` beside the receipt and, if the helper wrote nothing, writes a fallback receipt with the last 4 KB of that output, redacted. "See the update receipt" now always names a file that exists.

Searching settings for "version" finds About > Version on the web too. A thread error banner no longer covers the first message of a short thread: the timeline reserves the banner's height. A project's starter tasks refresh as soon as its goal or memory is saved, without a reload.

No database migration was added since 0.2.3, so the update from 0.2.3 is in place.

## 0.2.3 — updater agent refresh, release cleanup, failed coordinator turns

The desktop app now refreshes the Studio service's update agent on launch. In 0.2.2 it picked the copy packed inside app.asar, which `/usr/bin/python3` cannot open, so the agent kept its older code and the 0.2.2 usage-limit fix never took effect. The agent now ships only outside app.asar, and a failed refresh is recorded in the desktop trace.

After a verified update, the service updater deletes old unpacked releases (about 340 MB each). It keeps the new release, the previous one and any release another installation uses. Each agent pass also removes downloads and helpers left by a failed or manual install.

When the coordinator cannot start a turn, for example because a usage limit was reached, the project pane says so inline with the host's reason and links to the coordinator thread. A send now reads "Queued for the coordinator." Starter tasks stay marked as sent after a reload, and they are offered again when their turn failed. The project orchestration guide now says the goal lives in project settings.

No database migration was added since 0.2.2, so the update from 0.2.2 is in place.

## 0.2.2 — projects panel and per-machine limits

A project now opens with desktop-style panel tabs, a Library and a thread header. While a project has no threads, Studio suggests first tasks beside the coordinator and in the Threads pane; choosing one sends it to the coordinator once. Limits are shown per machine, and project usage reports the folder's real usage. The Overview's Needs you cards fit their column, and the goal strip is gone.

The Studio service now installs a release while a thread waits on a usage limit: the limit check no longer resets the updater's quiet period. Remaining upstream keys, links, artwork, sample data and unpublished CLI hints left by the rename are removed, the legal pages name Anton Abyzov as operator, and mobile app claims are dropped.

No database migration was added since 0.2.1, so the update from 0.2.1 is in place.

## 0.2.1 — one workspace

The window is now a three-pane shell: projects on the left, the project coordinator in the middle, and its threads on the right. Sidebar sessions are grouped under their project, the Overview has a styled project chooser, and a project can open in its own window. A project shows its goal, default model and default machine; models are chosen in place, images can be attached, and a usage chip shows subscription limits without leaving the conversation. A personal assistant is offered as its own kind of project.

Projects reach further. A project coordinator can be addressed from Telegram, project agents can read a Google account without write access, agents can share the saved logins of a chosen browser profile, and sandboxed workbench mods run with hash-pinned approval. A CLI Proxy hub running on this machine is detected and listed under usage providers; its key stays off other hosts and plain http.

Limits no longer stop a thread. A limited thread can continue on a fallback provider, or on Claude API credits for the same model and session when that is turned on; the API-credit rule now fires, checks and returns correctly. Claude resets are read from the Mac Keychain and the hub, Claude sessions compact at 400K tokens by default, and the context meter is shown by default. When a reset is close Studio can wait for it and resume on its own, the limit banner counts down, and a thread can continue on another device from a written handoff. A custom model is sent to Copilot over ACP.

The Mac app is packaged as an unsigned arm64 DMG, attaches to a running Studio service instead of starting a second server, keeps the Mac awake while a session is working, and updates itself and the Studio service in the background by default. Private fleet machines reconnect automatically.

Fixed since 0.2.0: `specweave-studio project remove --force` no longer always refuses; Antigravity can create files in new folders when the project path goes through a symlink; the pending-work read uses its partial index again, so sidebar refreshes stay fast with a large history; Studio's own tools show their names for agents that report them under the `studio-code` prefix; `service status` names the `specweave-studio` package; Settings search finds "Refresh upstreams at startup" by its old name; the terminal opens again after the PTY callback rename; the update banner no longer offers the commit that is already installed; imported Codex threads carry the prompt instead of setup text.

No database migration was added since 0.2.0, so the update from 0.2.0 is in place.

## 0.2.0 — project workspaces

Personal projects use private managed folders without Git scaffolding. A project can combine its execution folder, additional approved folders, and multiple repository URLs with explicit checkout matching/preparation. Project-scoped local MCP connections have explicit tool grants, revision checks, durable call receipts and revocation; credentials remain on the execution device.

Provider-neutral project workspaces add a retained coordinator, linked worker pane, project settings and revisioned memory. Coordinator and worker models are independent; ordinary worker replies and uploads route through the coordinator. Native context snapshots retain provider affinity and send changed project memory without replaying unchanged full snapshots. Usage distinguishes measured tokens, cache coverage and API-equivalent estimates.

Built-in plans connect specs, acceptance criteria, assignments and command evidence without requiring SpecWeave. Optional SpecWeave bindings read the existing ledger without replacing its authority. Verification retries retrieve the original receipt; a new execution requires a new attempt. Project routines, pause/archive, quota recovery and permanent deletion share lifecycle guards. Deletion removes every project conversation, including the coordinator, preserves repository files and remote branches, and refuses active work.

The release retains the 0.1.1 provider, credit-consent, machine-routing and worktree safeguards and fixes local Git remotes whose paths contain spaces. Source, artifact, native-provider, installation and manual UI acceptance receipts remain separate; this changelog describes the changes rather than certifying those gates.

## 0.1.3 — private alpha

An unused native Claude five-hour session can report zero usage without a reset time. That valid response now permits a deliberate retry after an expired empty quota failure, while capacity remains unknown. Malformed, incomplete, stale or exhausted usage remains blocked; current failures and billing restrictions are preserved. Includes Copilot/Grok setup and the reviewed guarded update workflow from the preceding private candidates.

## 0.1.2 — private alpha

A stale Claude exhaustion record with no quota windows no longer blocks a deliberate retry when current native usage reports complete, fresh five-hour and seven-day windows below their limits. Capacity remains unknown until a real request succeeds; incomplete, stale or exhausted usage still blocks retry. Includes the reviewed bounded browser reconnect proof for guarded updates.

## 0.1.1 — private alpha

Prepared for the owned private fleet. This release retains the deployed machine-routing fixes, adds current native Claude/Codex model discovery, corrects Claude subscription authentication and stale quota handling, and binds paid-credit continuation to one deliberate human submission. Worktree safeguards protect active and dirty checkouts, while background synchronization only fetches refs. Managed release artifacts carry aligned versions, checked provenance and bounded restart-heartbeat preservation. Account verification remains separate from release verification.

### Claude API credits on a usage limit, 10 October 2026

A third project row runs before any fallback, off by default and confirmed when turned on: **Use
API credits first** continues a limited Claude subscription turn on a Claude instance that signs in
with an API key, on the same model and in the same Claude session, so the turn is billed to that
key's API organization. It moves only against a fresh usage read at the limit, never under
`STUDIO_SIMULATE_USAGE_LIMIT`, and an idle thread goes back to the subscription once its usage read
shows the limit gone. The any-ready fallback no longer picks a Claude API-key instance by itself.
See [Usage and limits](docs/user/usage.md#when-a-provider-runs-out).

Corrected the same day: the row did not recognise an instance set up with `ANTHROPIC_API_KEY`, so
it never fired. It now reads the key from the instance's own environment, uses only an instance
with a direct Anthropic key that lists the thread's model, checks the limit past the usage cache
and only for a current stop, and brings a moved thread back when the limit resets or the row is
turned off.

### Provider limit handoff, 9 October 2026

A turn that stops on a usage limit can continue on another signed-in provider: the limit banner
offers **Continue with Codex** (or the project's fallback) next to the resume actions, and the
handoff carries the stopped turn's context into the same worktree. A per-project rule, **When a
provider runs out**, chooses between offering the fallback, waiting for the reset or switching
automatically; with automatic switching, an idle thread also moves to the fallback before its next
turn once its provider reaches the configured share (90% by default), once per usage window and
only to a provider below it. Claude and Codex turns carry `SPECWEAVE_STUDIO_THREAD_ID`, so
SpecWeave's auto-handoff hooks only checkpoint inside Studio. A cross-provider handoff starts with the SpecWeave checkpoint note the hooks
saved for the thread's worktree, when one exists and fits. A thread stopped on its first message
resends it on the fallback instead of continuing nothing. Switching between two Claude instances
with different config homes copies the native session transcript across and resumes it, instead of
summarizing; see [Context in portable handoffs](docs/user/portable-handoffs.md#two-claude-accounts). `STUDIO_SIMULATE_USAGE_LIMIT` stops
turns on listed provider instances with a simulated limit for testing. Two project rows run before
any fallback, both off by default and confirmed when turned on: **Redeem a banked reset first**
claims one of the account's reset grants (only against a fresh usage read at the limit, once per
limit window, never under `STUDIO_SIMULATE_USAGE_LIMIT`) and continues on the same provider, and
**Spend Codex credits first** continues a limited Codex turn on paid credits under the same
one-request permission as a manual credit send. The composer follows an automatic switch. See
[Usage and limits](docs/user/usage.md#when-a-provider-runs-out).

### 0889 Copilot and Grok setup, 9 October 2026

Featured GitHub Copilot and Grok Build entries resolve the official ACP registry on the selected environment and reuse Studio's explicit install and sign-in wizard. Native Grok remains available for an existing CLI. Copilot's legacy terminal-login metadata is recognized, while models and reasoning options stay provider-discovered. Managed Grok installation isolates its installer home, and managed Copilot/Grok launches disable automatic self-updates. Existing instances expose an explicit install/update repair action; catalog refresh never silently installs a newer agent.

See [Copilot and Grok setup](docs/studio/copilot-and-grok.md). Source verification and credential-free CLI handshakes are distinct from authenticated model, billing and denied-write acceptance; this entry does not claim deployment to an existing service.

### 0890 workspace safety, 9 October 2026

Background synchronization fetches refs without changing checkouts. Explicit Pull stays fast-forward-only. Worktree removal rejects authoritative owners, local changes and valuable ignored data even when a client asks to force it. Merged cleanup recognizes verified squash/rebase integration while preserving branch refs and additional work. Settings and [workspace guidance](docs/studio/workspaces-and-consolidation.md) explain current-checkout mode and storage limits.

### 0886 private follow-up, 8 October 2026

Readable tool panels preserve command/output spacing and add Copy, Wrap and Expand. Codex usage recovery checks fresh native permission before a reported reset when explicitly armed, with account affinity, bounded polling and guarded single dispatch. Authenticated private-machine discovery exposes configured workers and saves separate browser-profile pairings; private wrappers accurately show manual provider maintenance.

Current runtime source `5d25f9abb2e50e458fdf2bdc53412664974b4eb2`, archive SHA-256 `be544682c7b8cad344e6a917d8aacbcafa75b0110ab761b451aad242ae6f4273`, verifies 6,608 files / 35 packages on all three Macs. Codex 0.162.0 / Claude Code 2.1.295 activation is verified independently. Three sequential real Codex marker-read chats pass with normal approvals, six exact running-executable observations and protected original state; the existing limited user chat was not resumed. The delivery gate passes 977 checks, the complete timeline suite 83 tests and scoped server line coverage 92.59%. Current Claude execution, full-product verification and a persistent coordinator are unproved; manual acceptance of this new UI remains pending. See [Updates](docs/studio/updates.md).

### Earlier private delivery — historical snapshot

Studio is an independent MIT native coding workbench with its own identity, CLI, private state home and responsive web interface. SpecWeave retains project/task ownership and portable handoff. Required upstream attribution and third-party notices remain in the artifact.

The local alpha delivers explicit host/account drafts, fresh capacity observations with shared-pool deduplication, native plans and approvals, queues, steering, durable sessions and Git checkpoints. Official provider execution bypasses optional inference proxies. Private per-host pairing, scoped authorization and guarded three-Mac installation preserve existing histories, authentication and original services.

Repairs verified in this delivery:

- Ordinary startup opens Overview without an unsolicited project/draft or unused administrator link; deliberate project startup remains supported.
- Explicit machine selection stays pinned even when optional resource balancing is saved.
- Passive branch hydration preserves atomic worktree/empty-thread guards and cannot stop a newly prepared native session.
- HTTPS session issuance, refresh, migration and expiration use Secure cookies; arbitrary forwarded headers cannot downgrade transport.
- Production builds keep CSS hints, real imports and lazy routes while omitting optional JavaScript preloads that caused private HTTP/2 bootstrap failures.
- Fresh installation rejects aliased destination ancestors before writing. Owned updates preserve canonical completed effects and reject active or unknown state.

Historical immutable runtime: source `8050ce9a2d466efdc7a919ed83be7db11d4c2088`, archive SHA-256 `5f47d9a736bf19fe33d43c08ca171157c6c010e8955d356f8ff2cfd8bfbaed2d`. All three guarded installations verified 6,607 entries. That all-host default-shared acceptance passed: one completed supervised Codex read on each worker and an actionable M4 native-zero limit denial. Strict private HTTPS/defaultHTTP2/WSS, responsive views, exact owned cleanup and protected state passed for that artifact. Worker shared runtime status advances are canonically proven; the retained af8bae evidence remains historical.

The shared-native admission repair refreshes stale targeted health/auth/route metadata at explicit launch and preserves newer quota denials. Actual quota windows, used/remaining values, credits, reset age and native permission stay distinct. Reset-first policy is configured on all three hosts; native conversations retain account/cache affinity. Independent pinned-prefix provider wrappers report manual maintenance instead of an unsupported generic update command.

All four auxiliary metadata operations now require the same native admission before generation or source-link retrieval. Denial preserves the seed title and temporary branch and cannot choose another profile. Temporary Git branch flattening and collision checks preserve the complete canonical or legacy namespace, including hyphenated tokens; unrelated and malformed refs retain their prior behavior.

Resolve replaces Settle in user-facing controls. PR completion checks current reused-branch readiness and exact per-thread event versions, preserving newer user actions. New web Git drafts inherit worktree defaults; asynchronous host changes cannot replay another host's workspace or erase a newer same-host selection. Focus-aware shortcuts prevent held/in-flight Resolve toggles. Calendar three-day Snooze replaces inactivity-based completion. The bounded reactor keeps per-thread event order while allowing other eligible threads to progress.

Anton accepted the delivered local UI/auth on 8 October with “complete the job!”. The operator guide and illustrated getting-started tutorial explain the installed services, projects, machine/provider selection, portable work and browser/MCP boundaries. Supported guarded private-access resume reanchors restarted tunnel PIDs without restarting healthy tunnels or rewriting Serve mappings.

This entry describes a tested local installation. Physical phone/off-LAN proof, additional native sign-ins and matched performance benchmarking remain separate. Public packaging requires generic inventory and sanitized deployment evidence.
