# Skills page and provider logo fixture

Renders the production Skills page inside a Settings-dialog layer with a synthetic
snapshot (no provider, vskill or network access), and a gallery of every provider
mark (`?view=logos`). Use it to check that skill details open above the dialog,
that source and verified-skill.com links stay readable, and that every provider
mark renders in light (`?theme=light`) and dark (`?theme=dark`).

```sh
node node_modules/vite-plus/bin/vp build --config apps/web/tests/skills-and-logos/vite.config.ts
```

Serve `.artifacts/skills-and-logos/site` from a loopback server and open it in a
headless browser only.
