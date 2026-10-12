# Upstream provenance

SpecWeave Studio is an independent MIT fork of [T3 Code](https://github.com/pingdotgg/t3code), pinned to commit `10f39eb9ac80c9a4b7f5097575dd2addc3b6f631` (nightly 20261007.2761).

The original MIT LICENSE and `Copyright (c) 2026 T3 Tools Inc.` notice are retained verbatim. Third-party and vendored/reference notices remain applicable. The notice generator recognizes both @t3tools/ and @specweave-studio/ without removing inherited attribution.

Studio changes product/CLI/package/runtime/data identities and defaults to its own private home and loopback port. Hosted cloud/relay, product telemetry and self-update are disabled by default. Native provider protocols, commands/events, approvals, steering/queues, direct pairing and Git checkpoints remain. Original installed apps, stores and services are independent and preserved.

.repos/ reference trees are unmodified inherited development references and excluded from deployment artifacts. Cryptographic/replay/binary fixtures preserve original bytes; historical names there are provenance/test data, not runtime defaults. The canonical SpecWeave increment 0885 tracks integration and validation.

The pinned upstream root tooling requested Node 24. Studio narrowly ports workspace import/export metadata and build verification to Node 22.20.0 without changing pinned registry resolutions, integrity records or inherited patches. Focused frozen installation, production web/server builds, native sidecar loading and generated CLI version/help are verified on Node 22.20.0. The private Node 24 toolchain is an optional fallback and is not needed for those accepted artifacts. A standalone extracted bundle and live fleet runtime require separate installation and behavior receipts. No registry publication or upstream push occurs during local building.
