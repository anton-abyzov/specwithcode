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
