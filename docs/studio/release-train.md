# Release train

Decision, November 13, 2026. SpecWithCode ships to its users once a day at most, through a stable
train fed by an Insiders channel. Every build still ships right away, to Insiders. This page is the
decision and the runbook. The mechanics of a single release run are in [releasing](./releasing.md).

## Why

On November 12 and 13, 2026, versions 1.0.262 to 1.0.276 were published in about 20 hours. That is
15 releases, and the last one held a single fix. Every one became GitHub's Latest release, so every
desktop app, service update agent and the download page took each one. Nothing ran anywhere before
it reached users, several machines and agent sessions asked for releases independently, and 1.0,
announced as the stable line, was not stable.

## What established products do

| Product        | Stable cadence                                                                                                                                         | Fast channel                                                                                                                            | Soak, rollout and hotfix rules                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chrome         | Every 2 weeks since Chrome 153 (September 2026), Extended Stable every 8 ([Chrome blog](https://developer.chrome.com/blog/chrome-two-week-release))    | Canary daily, Dev, Beta                                                                                                                 | Branch, then about 3 weeks of stabilization; Early Stable to a small share first; weekly "stable refresh" for security and urgent regressions ([release cycle](https://chromium.googlesource.com/chromium/src/+/main/docs/process/release_cycle.md)) |
| VS Code        | Weekly since 1.111 (March 2026), monthly before ([Thurrott](https://www.thurrott.com/dev/333528/visual-studio-code-moves-to-a-weekly-update-schedule)) | Insiders, nightly                                                                                                                       | Recovery builds only for data loss, big regressions, security ([endgame](https://github.com/microsoft/vscode/wiki/Running-the-Endgame)); a recovery fix ran 24 hours on Insiders first                                                               |
| Firefox        | Every 2 weeks ([pocket guide](https://firefox-source-docs.mozilla.org/contributing/pocket-guide-shipping-firefox.html))                                | Nightly every 12 hours, Beta 3 times a week                                                                                             | Starts at 25% of users; a "chemspill" is the emergency dot release; 0% halts                                                                                                                                                                         |
| Slack desktop  | About every 1-2 weeks ([Mac notes](https://slack.com/release-notes/mac))                                                                               | Opt-in beta, installed within 6 hours ([help](https://slack.com/help/articles/226192087-Join-Slack%E2%80%99s-desktop-app-beta-program)) | Server deploys go 2%, 10, 25, 50, 75, 100% ([Slack Engineering](https://slack.engineering/deploys-at-slack/))                                                                                                                                        |
| GitHub Desktop | About every 2 weeks ([release planning](https://github.com/desktop/desktop/blob/development/docs/process/release-planning.md))                         | Beta                                                                                                                                    | Production is built only from a beta tag; new features behind flags                                                                                                                                                                                  |
| Cursor         | Default channel of "tested releases" ([docs](https://cursor.com/docs/account/update-access))                                                           | Nightly                                                                                                                                 | No public rollout numbers                                                                                                                                                                                                                            |
| Linear         | Desktop updates silently in the background ([docs](https://linear.app/docs/get-the-app))                                                               | none public                                                                                                                             | Internal process not published                                                                                                                                                                                                                       |

What they share: a fixed stable cadence, a fast channel that takes every build, promotion of a build
that has already run (not a rebuild), a written and narrow hotfix bar, and one owner who decides.
electron-updater cannot recall a release; the only fix for a bad one is a higher version
([electron-builder](https://www.electron.build/docs/features/auto-update)). Version numbers in apps
are loose: VS Code stays on 1.x and Slack's third number grows with every build. The full notes with
sources were collected for this decision.

## The train

**Cadence.** One stable release a day at most, cut at **15:00 UTC** by
[`.github/workflows/release-train.yml`](../../.github/workflows/release-train.yml). A day where no
build qualifies ends green and ships nothing. Daily rather than weekly because agents fix things
every hour and a day-old fix is still fresh; the soak keeps it safe.

**Two channels.**

|               | Insiders                                                                | Stable                                     |
| ------------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| Who           | The fleet's own machines (M4, M1, the Linux worker), anyone who opts in | Everyone else, the website, npm            |
| What          | Every build, minutes after it is published                              | A build that ran 24 hours on Insiders      |
| GitHub        | Prerelease, never Latest                                                | Not a prerelease, Latest                   |
| Desktop app   | Settings > Update track > Insiders                                      | Settings > Update track > Stable (default) |
| Service agent | `channel: preview`                                                      | `channel: stable` (default)                |

Settings writes the desktop track to the service agent too, so one switch moves a machine.

**Soak gate.** The train promotes the newest Insiders build that

- is above the current stable release and at or above 1.1.0,
- was published at least 24 hours before the cut,
- carries all four update manifests (`latest-mac.yml`, `latest.yml`, `latest-linux.yml`,
  `latest-linux-arm64.yml`), so every platform can update, and
- is not held.

It promotes the same release: no rebuild, so stable users get the files the fleet ran. The notes
list the Insiders builds it includes. One promotion per 20 hours.

**Holding a bad build.** Anyone who sees an Insiders build misbehave holds it, and the train skips
it:

```sh
python3 -B scripts/release/release_train.py hold --repo anton-abyzov/specwithcode --version 1.1.4 --reason "login loops on Windows"
python3 -B scripts/release/release_train.py unhold --repo anton-abyzov/specwithcode --version 1.1.4
python3 -B scripts/release/release_train.py status --repo anton-abyzov/specwithcode
```

A newer build that fixes it ships on its own schedule. When every build is broken, hold them all.

## Hotfixes

A hotfix skips the soak and the daily limit. It qualifies only for:

- a security issue,
- data loss or corruption (the database, threads, worktrees, credentials),
- an update or install that fails or leaves the app unusable,
- a crash at start, or a primary flow broken for stable users.

Features, polish, performance and anything seen only on Insiders ride the next train.

**Approval.** Anton approves every hotfix. An agent proposes it with the evidence; on Anton's yes
the merged pull request gets the `hotfix` label, then:

```sh
bash scripts/release/request-release.sh --hotfix 123   # run in the background
```

It requests a build when none holds the fix yet, waits for it, and runs the train with
`hotfix_pr`, which checks that the pull request is merged and labelled and promotes the newest
complete build that holds it. If the train answers that the Windows and Linux manifests are
missing, run it again when the Release Windows and Linux run ends:
`gh workflow run release-train.yml -R anton-abyzov/specwithcode -f hotfix_pr=123`.

A hotfix ships main's head, so anything merged since the last stable ships with it unsoaked.
Before asking for one, look at what main holds since the last stable; a cherry-pick release
branch is the next step if that becomes a problem.

## Who releases

- **Builds (Insiders):** anyone, as before. Sessions run `request-release.sh`; the Release macOS
  queue picks the version and cuts one build at a time on the M1 release Mac. Nobody needs to
  coordinate builds.
- **Stable:** only the Release train workflow. It is the release owner; no machine or session
  promotes by hand, and no one edits a release to Latest. The guard is structural:
  `release-flags.mjs` publishes every 1.1+ build as a prerelease, and only `release_train.py`
  turns one into stable, with the soak or a labelled hotfix.
- **Machines:** M4, M1 and the Linux worker run Insiders, so they are the canary ring for every
  build. Their sessions report problems by holding the build. The M4 coordinator watches the train
  run each day and says when a hold or a hotfix is needed; the other machines do not dispatch
  hotfixes on their own.

## Versions: the 1.1 line

- **1.1.0 is the first stable release.** It is cut as an Insiders build like any other and the
  train promotes it after its soak. Its notes say it starts the 1.1 line and that 1.0.x is frozen.
- **1.0.x is frozen** at the last 1.0 release. Nothing is deleted or rewritten; the tags and
  releases stay. Once v1.1.0 exists, the release plan counts from it, so no new 1.0.x is cut, and
  a dispatch below the newest version is refused. 1.0 installs update to 1.1.0 when it becomes
  stable, through the normal updater.
- **Numbers after 1.1.0.** Insiders and stable share one series: 1.1.0, 1.1.1, 1.1.2 and so on,
  one per build. A stable release can skip numbers (1.1.0, then 1.1.6), and its notes list the
  builds it includes. The minor goes up for a release worth announcing, by dispatching Release macOS
  with that version once (1.2.0).
- **Website.** The download page already shows only stable releases; it now reads the newest 30
  releases so a day of Insiders builds cannot hide the stable one. It changes once a day at most.
- **Release notes.** Each Insiders build keeps its own notes. The promoted release gets a header,
  its own notes and the notes of every build it includes.
- **npm.** `specwithcode` on npm follows stable: the train asks release-npm.yml for each promoted
  version. Insiders builds are not published to npm.
- **Installers.** `install.sh` reads the Latest release for stable; `install.ps1` skips prereleases.
- **App Store.** The iOS app keeps its own version line (0.1.x today) and build numbers that only
  go up, as Apple requires; it is not tied to the desktop number. When it reaches the App Store as
  stable it can take 1.1.0 to match, since that is above every version it shipped.

## Rollout of this change

1. Merge the tooling. Until a v1.1.0 tag exists, releases behave exactly as before: 1.0.x builds
   are Latest.
2. Let one more 1.0.x release ship and install. It carries the agent, desktop and installer code
   that skips Insiders builds on Stable. A host that has not taken it yet would install Insiders
   builds, because older code ignores GitHub's prerelease flag.
3. Switch M4, M1 and the Linux worker to Settings > Update track > Insiders.
4. Stabilize: only fixes merge between that release and the 1.1.0 cut.
5. On Anton's go, dispatch Release macOS with `version=1.1.0`. It publishes as an Insiders build.
6. The next 15:00 UTC train after 24 hours promotes it to stable.

Proposed dates: 1.1.0 cut on Monday, November 16, 2026, promoted on Tuesday, November 17, 2026
at 15:00 UTC.

## Later

- Percentage rollout for stable through electron-updater's `stagingPercentage` (start near 10%,
  0% halts), and the same for the service agent.
- A release branch for hotfixes, so a hotfix carries only its fix.
- Read the fleet's installed versions and crash counts into the soak gate, not only time.
