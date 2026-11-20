# "Also add on", Adopt and machine table fixture

Build from the repository root with `node node_modules/vite-plus/bin/vp build --config apps/web/tests/skill-rollout/vite.config.ts`, then run `node apps/web/tests/skill-rollout/verify.mjs /absolute/external/evidence-directory`.

The fixture renders the production Skills panels with fictional machines, skills and mock answers. It never reads live files and never reaches a machine, GitHub or a registry; the runner fails on any request that leaves the fixture.

It captures light and dark at 1440 and 390 wide: "Also add on" unticked with each disabled machine's reason, ticked with the review, the result rows with Undo and Retry failed, the Adopt list, the pull request confirmation, and a machine whose scan was incomplete in "Across machines".

This fixture does not establish a real rollout, a private repo read on another machine or a pull request.
