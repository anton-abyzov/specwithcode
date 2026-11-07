# Upstream provenance

SpecWithCode is independently maintained. Its inherited code baseline is [T3 Code](https://github.com/pingdotgg/t3code), pinned to commit `10f39eb9ac80c9a4b7f5097575dd2addc3b6f631` (nightly 20261007.2761).

The original MIT license text in THIRD_PARTY_NOTICES.md and `Copyright (c) 2026 T3 Tools Inc.` notice are retained verbatim. Third-party and vendored/reference notices remain applicable. The notice generator treats @specweave-studio/ packages as first party without removing inherited attribution.

Studio changes product/CLI/package/runtime/data identities and defaults to its own private home and loopback port. Hosted cloud/relay and product telemetry are disabled by default. Self-update uses only the owned release feed. Native provider protocols, commands/events, approvals, steering/queues, direct pairing and Git checkpoints remain. Original installed apps, stores and services are independent and preserved.

.repos/ reference trees are unmodified inherited development references and excluded from deployment artifacts. Cryptographic/replay/binary fixtures preserve original bytes; historical names there are provenance/test data, not runtime defaults. The canonical SpecWeave increment 0885 tracks integration and validation.

The pinned upstream root tooling requested Node 24. Studio narrowly ports workspace import/export metadata and build verification to Node 22.20.0 without changing pinned registry resolutions, integrity records or inherited patches. Focused frozen installation, production web/server builds, native sidecar loading and generated CLI version/help are verified on Node 22.20.0. The private Node 24 toolchain is an optional fallback and is not needed for those accepted artifacts. A standalone extracted bundle and live fleet runtime require separate installation and behavior receipts. No registry publication or upstream push occurs during local building.

## Selected ports, October 28, 2026

Increment `1129` selectively ports these T3 Code changes onto the independent implementation:

- Worktree configuration serialization and retries: `3b22620a5c`. Setup timing logs and macOS Spotlight markers are local adaptations.
- GitHub credential-host validation: `80b7b0fd23`.
- MCP advertised-schema compaction and registration: `ed44f251d8` (compaction only) and `bc813670d9`. Action-tool merging is excluded. Local repairs retain explicit nullable values and non-string discriminator types; decoding remains unchanged.
- Codex home locks and process recovery: `c4606e564d`, dependencies `140ee145ac` and `70e3174b77`, plus `b88da91397`. Existing local runtime lock entries are preserved rather than unlinked during migration. Usage deduplication from `c3f5e363e5` also covers this implementation's model-specific buckets.
- Background work, bounded delegated stops, queue visibility and interrupted context: `2a738273e7`, `36d4d711b7`, `10e709c337`, and `bc8d02ffd5`. The `975b3dc568` parent-question change is not applied: child requests remain owned by the child, and existing attention routing links genuine actionable questions to that child.
- Local file wrapping, markdown frontmatter and full chat tables: `48a292364a`, `f81c4cd79f`, and `eb751fa073`.

These selected ports do not change the inherited baseline pin or grant a new license over original material. Required notices remain intact.

## Selected ports, October 30, 2026

Increment `1146` selectively ports T3 Code changes through nightly `v0.1.6-nightly.20261030.3904` onto the independent implementation. Each was adapted by hand to this tree's names and layout; the full triage, with the commits not taken and why, is in the increment's `reports/triage.md`.

- Connect and pairing: managed cloudflared 2026.10.4 with checksums, case-insensitive pairing codes that survive a scope rejection, pairing links that cannot add routes to a saved environment, `--base-url` validation (`bdf84df8ca`), dead-route probe backoff (`65b0ab8c91`), the permissions check after a reconnect (`4092c4ac56`), and history loads on their own concurrency key.
- Relay: delivery-attempt retention (a D1 index swap), idle-tunnel cleanup and the tunnel limit for abandoned reprovisions.
- Security: clone-error URL redaction (`1cc9d413a5`), signed URLs kept out of HTTP traces (`4afdabab44`), compound credential keys redacted in provider errors, and the resolved OpenCode server password (`d796063f78`).
- Orchestration: restart continuations that retry failed starts and respect a parent's stop (`36dac688a1`), held queues released after a completed run (`8ab098a4a8`), mark unread without reviving a dismissed wake (`cb5fac907a`), plus Copilot follow-up queueing, Cursor subagent results, approval command display and subagent pin inheritance. Local repairs: a parent's service-update interrupt does not block a child's continuation, and every attempt of a retried run counts when deciding whether the provider took the prompt.
- Server: lighter run preparation (`22c37a8da4`), Bitbucket discovery timeout (`3898c32986`), active turn-item partial indexes (`624e70ecdd`, migration `068` here), checkout leases, and Linux CLI packaging (libatomic, patchelf).

The model picker was redesigned locally rather than ported. Electron 44.10.0, the pairing deep link (`dde3fdb5a6`), smaller checkpoint payloads (`7f39a860d9`), service protect, the SQLite read pool and sidebar shell performance are not applied. These selected ports do not change the inherited baseline pin or grant a new license over original material. Required notices remain intact.

## Selected ports, November 2, 2026

Increment `1169` reviewed T3 Code changes through nightly `v0.1.7-nightly.20261102.4066` and rewrites a small set by hand onto the independent implementation. The full triage is in the increment's `reports/triage.md`.

- Desktop and security: renderer navigation compares scheme and host (`2a180c7b6a`); preview `window.open` loads nothing for local and inline schemes (`c94ff9b6e5`); the Clerk token file is owner-only, with our own wrapper rather than a store migration (`bd9cc0a901`); the socket upgrade stays out of HTTP traces, by a path exemption rather than redaction (`6d46336476`).
- Preview browser: Chrome for Testing 156.0.8078.80 (`dcc31b81d3`), with sizes and hashes computed from our own downloads.
- Reliability: login shell probes ignore stderr (`0b75a852d8`); one-shot SSH commands get a keepalive (`0ce257b880`); one failed provider check no longer ends the settings loop (`8ae3dfc761`); restart continuations ask the agent to check state first (`5bb50dca8e`).
- Data safety: `studio_thread_organize` refuses unknown arguments (`a773dc38ac`); selected-file commits stop on a failed reset and refuse during a merge, cherry-pick or revert (`cf5e6d3f0c`, `66eb776c9b`); forks and subagents drop pending title jobs and list placement (`8670378049`, `7f005d4d8d`, `ef4c658109`); truncated Markdown stays read-only (`12d1e4c23c`); a stored secret variable keeps its name and protection (`2a9335680e`); shared worktrees are compared through trailing separators (`f5bc64b7b7`).

The managed policy (`d897d3f3f0`) is not applied. Team rules (increment `1170`, `docs/user/team-rules.md`) are a separate design of our own, with their own names, schema and code. These selected ports do not change the inherited baseline pin or grant a new license over original material. Required notices remain intact.
