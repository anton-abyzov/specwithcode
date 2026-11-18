# Skills page per-machine fixture

Renders the production Skills page under the real scope line, with fictional machines and skills. It never reads a real skills folder or another machine.

Build from the repository root:

```sh
node node_modules/vite-plus/bin/vp build --config apps/web/tests/skills-machines/vite.config.ts
```

Check and capture it, headless, into a folder outside the checkout:

```sh
node apps/web/tests/skills-machines/verify.mjs /absolute/external/evidence-directory
```

Cases, each in light and dark at 1440 and 390 pixels:

- `?case=synced`: a home that holds only claude.ai-synced skills.
- `?case=codex`: a machine with only Codex and its system skills.
- `?case=across`: the "Across machines" table with one machine offline.
- `?case=offline`: the page set up for a machine that is offline.
- `?case=view-only`: another machine, from a sign-in that may not change it.

The fixture does not prove what a real agent loads or what another machine reports.
