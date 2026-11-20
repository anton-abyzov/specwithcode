# Skill repos, search and update fixture

Build from the repository root with `node node_modules/vite-plus/bin/vp build --config apps/web/tests/skill-repos/vite.config.ts`, then run `node apps/web/tests/skill-repos/verify.mjs /absolute/external/evidence-directory`.

The fixture renders the production search box, connected repos and update panels with fictional skills and mock answers. It never reads live files and never reaches a machine, GitHub or a registry; the runner fails on any request that leaves the fixture.

It captures light and dark at 1440 and 390 wide, before and after a search, an update and an install, and checks the three search groups, the version and commit pairs, the readiness chips and that the page does not scroll sideways.

This fixture does not establish a real install, a private repo read or what a running agent has loaded.
