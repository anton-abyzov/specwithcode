# Skills clarity fixture

Renders the production Skills page and the composer's skills popover with 72 fictional skills, three fictional agents and three fictional machines. It never reads a real skills folder, lock file or machine.

Build from the repository root:

```sh
node node_modules/vite-plus/bin/vp build --config apps/web/tests/skills-clarity/vite.config.ts
```

Check and capture it, headless, into a folder outside the checkout:

```sh
node apps/web/tests/skills-clarity/verify.mjs /absolute/external/evidence-directory
```

Views, each in light and dark at 1440 and 390 pixels:

- `?view=settings`: the table paged 25 at a time, a search that covers every page, the lines that say which agent was not read in full, scope chips, lock source and the folder-scan marker; then "Across machines", searched and paged.
- `?view=popover`: an agent that advertises 40 skills with no file paths. 36 share a name with a file the app found and read "Matching file"; four have no file and read "Location unknown".

The fixture does not prove what a real agent loads, which copy it uses, or what another machine reports.
