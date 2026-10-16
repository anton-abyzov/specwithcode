# SpecWithCode Mods

Mods customize the workbench: they add command palette entries, a short status in the sidebar, toasts, and panes. They are shaped like [Claude Code mods](https://code.claude.com/docs/en/plugins/mods/overview): one module exports `register(on)`, and every hook is `($, e, next)`.

A mod belongs to a SpecWithCode host. Every client of that host (browser, desktop app) runs the same approved mods. In this first version clients run the mods of their primary environment only.

## Install a mod

1. Check it: `specweave-studio mods validate path/to/my-mod`. It prints the mod's permissions and a content hash, or what is wrong.
2. Copy the folder into the host's mods folder, `<studio home>/userdata/mods/<name>/`. `specweave-studio mods list` prints that folder and each mod's status.
3. Open **Settings > Mods**, read what the mod asks for, and approve it. The dialog shows the same content hash as the validate command.

A mod runs only after you approve its exact contents. Editing `mod.json` or the module afterwards pauses the mod ("Changed, paused") until you approve again. **Turn off** stops a mod without deleting it. Approvals are stored in `<studio home>/userdata/mod-approvals.json`, outside the mods folder, so a mod cannot approve itself.

Examples ship in [`examples/mods`](../../examples/mods): `review-queue` (sessions waiting on you), `focus-timer` (needs no permissions), and three that read SpecWeave progress: `ac-trace-lint`, `increment-standup` and `ready-to-close`.

## Write a mod

```
my-mod/
  mod.json
  register.js
```

`mod.json`:

```json
{
  "name": "my-mod",
  "version": "0.1.0",
  "description": "What it does, in one line",
  "main": "./register.js",
  "permissions": ["threads:read"]
}
```

The name must match the folder: lowercase letters, digits and dashes. The module is one plain JavaScript file (no imports) of at most 256 KB. It runs in a worker, so it has timers but no `document` or `window`, and top-level `await` is not available.

`register.js`:

```js
export function register(on) {
  let count = 0;
  on("app.start", ($, e, next) => {
    $.command.register({ name: "count", description: "Open the counter" });
    return next(e);
  });
  on("command.run", { name: "count" }, ($) => $.ui.open({ id: "counter", title: "Counter" }));
  on("ui.render", { component: "Pane", requestId: "counter" }, () =>
    h(
      "Box",
      { direction: "row", gap: 2 },
      h("Text", { tone: "strong" }, `Pressed ${count}`),
      h(
        "Button",
        {
          onPress: () => {
            count++;
          },
        },
        "Press",
      ),
    ),
  );
}
```

`on(event, matcher?, hook)` adds a hook. A matcher is an object whose keys must equal the event's fields. A hook that returns without calling `next` answers for itself; `next({ ...e, x })` passes a changed event on.

### Events

| Event               | Fields                                        | Notes                                              |
| ------------------- | --------------------------------------------- | -------------------------------------------------- |
| `app.start`         | `surface` (`web` or `desktop`), `permissions` | Once, when the mod starts                          |
| `command.run`       | `name`                                        | The user picked one of the mod's palette commands  |
| `ui.render`         | `component: "Pane"`, `requestId`              | Return a tree for an open pane                     |
| `threads.changed`   | `threads`                                     | Needs `threads:read`; sent when sessions change    |
| `specweave.changed` | `increments`, `truncated`                     | Needs `specweave:read`; sent when progress changes |

Open panes redraw after every event and after a button press.

### `$`

| Call                                                             | What it does                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `$.command.register({ name, description })`                      | Adds a palette entry (up to 16)                                          |
| `$.ui.status(text)`                                              | Short sidebar status (40 characters); `undefined` clears it              |
| `$.ui.toast(text)`                                               | A toast; at most three per ten seconds                                   |
| `$.ui.open({ id, title })`, `$.ui.close(id)`, `$.ui.redraw(id?)` | Panes (up to four per mod)                                               |
| `$.threads.list()`                                               | Needs `threads:read`                                                     |
| `$.threads.open(id)`                                             | Needs `threads:open`; only within five seconds of the user using the mod |
| `$.specweave.list()`                                             | Needs `specweave:read`; the same summary `specweave.changed` carries     |
| `$.mod()`                                                        | The mod's name, surface and permissions                                  |

### UI trees

`h(type, props, ...children)` builds a tree. The workbench draws it with its own components, so a mod's UI follows the theme. Elements: `Box` (`direction: "row" | "column"`, `gap: 0-6`), `Text` (`tone: default | muted | strong | success | warning | danger`, `mono`), `Button` (`onPress`, `variant: default | outline | ghost`, `disabled`). Strings and numbers are text. Other elements and props are dropped; text is never rendered as HTML. A tree holds at most 400 nodes, 12 levels deep, 2000 characters per text and 8000 characters of text in total; a tree over a limit is not drawn, so keep long lists short.

### Permissions

| Permission       | Grants                                                                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `threads:read`   | Session titles, project names, state and attention on this host. Never messages, files or paths                                                                                                                 |
| `threads:open`   | Opening one of those sessions, right after the user used the mod                                                                                                                                                |
| `specweave:read` | SpecWeave increments of this host's projects: titles, status, acceptance criteria, task titles, task state and the last verify result. Never files, paths, spec prose, who claimed a task, evidence or commands |

### SpecWeave progress

With `specweave:read` a mod sees the increments under `<project>/.specweave/increments/` of every project on the host: open ones, plus those closed in the last seven days (up to 25 per project and 60 in all). The server reads `metadata.json`, `spec.md` (or an older increment's `tasks.md`), `ledger.jsonl` and `reports/verify.json`; it never runs the SpecWeave CLI and never writes. Task state follows the ledger's rules: a claim older than two hours is `stale`, and done or skipped is final. The summary is re-read every 30 seconds while such a mod runs.

```ts
{
  increments: Array<{
    project: string; // the SpecWithCode project's title
    id: string; // "0894-consolidate-agent-skills"
    title: string | null;
    status: string; // metadata.json status: active, planned, completed...
    updatedAt: string | null;
    readable: boolean; // false when no tasks could be read
    criteria: Array<{ id: string; text: string }>;
    tasks: Array<{
      id: string;
      title: string;
      status: "planned" | "claimed" | "stale" | "done" | "released" | "skipped" | "blocked";
      criteria: string[]; // AC ids the task cites
      changedAt: string | null; // when the ledger last changed it
      note: string | null; // block or skip reason
    }>;
    malformedLedgerLines: number;
    verify: { ok: boolean; ranAt: string } | null;
  }>;
  truncated: boolean;
}
```

## Security

Each approved mod runs in its own `<iframe sandbox="allow-scripts">` without `allow-same-origin`, so it has an opaque origin: no workbench DOM, cookies, storage, session or credentials. The frame's content policy is `default-src 'none'` with inline scripts only, which blocks every fetch, WebSocket, image, frame and form.

The mod's code does not run in that frame. A frame can navigate itself (`location.href = …`, a link click, a meta refresh) and no content policy directive prevents it, so code in the frame could carry data out in a URL. The frame only holds a bridge that starts the mod in a dedicated worker and relays its messages. A worker has no document and cannot navigate; it inherits the frame's policy, so its fetches are blocked as well. Network constructors such as `fetch`, `XMLHttpRequest` and `WebSocket` are also removed from the worker and its prototypes before the mod runs. If a mod frame ever loads a second document, the workbench stops that mod. The only way out is `postMessage` to the workbench, which checks every message, bounds every text, and enforces permissions itself.

A mod can never answer approvals, grant folder access, choose accounts, change settings or start a provider turn; none of those calls exist. The server only reads and hashes mod files; it never runs them.

`node scripts/studio-mods/verify.mjs <report-dir>` checks all of this headless against a freshly built server in a private home, including a probe mod that tries to reach the network and to navigate.
