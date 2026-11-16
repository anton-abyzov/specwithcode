# Credentials a project uses, when you copy it to another machine

Copy to another machine carries the project folder and the secret files inside it that you tick (`.env`, keys in the folder, .NET user secrets). It never carries what lives in your home folder: sign-ins to GitHub, Azure, Google Cloud, AWS, Cloudflare, npm or a container registry, Kubernetes access and SSH keys. Each machine keeps its own, so a copied project can find the new machine not signed in to something it needs.

The review and Done screens of a copy show **Credentials this project uses**. It answers three questions.

- **What does this project use?** The source machine reads names in the project: Terraform providers, commands in scripts, workflows, a Makefile and `package.json`, files such as `wrangler.jsonc` or `Chart.yaml`, and the hosts of its Git remotes. It never opens a secret file and reports no file content.
- **Does the new machine have it?** The destination first looks for each tool, then asks it, for example `gh auth status`, `wrangler whoami`, `npm whoami` or `gcloud auth list`, and answers with one word: ready, not signed in, tool not found, or check it yourself. A row is ready only when the tool itself says so. A sign-in file alone never makes a row ready; when a check cannot answer, the row says a sign-in file is there but was not verified. A check that could not reach its service (offline, a proxy in the way) is no answer, not "not signed in". Container registries and SSH servers other than GitHub, GitLab and Bitbucket have no check, and Windows machines answer "check it yourself".
- **How do I set it up there?** Sign in there shows the commands for that machine, in order: the install when the tool is missing, the sign-in, then a command that shows it worked. For SSH keys the row says to create a new key on the new machine and add it where the old one is trusted. Nothing in this list is sent.

**Check again** on a row or at the top runs the checks again on the new machine. A row shows a spinner while its check runs, then "Checked just now" and how long ago after that. An answer the new machine kept from an earlier check shows its real age. When a check gets no answer, the rows keep what the machine said before and a line above them says so until those rows are answered again. A machine is asked to update SpecWithCode only when it does not have the check at all, not when it has it and could not run it this time.

Ready means the tool reports a sign-in on that machine. For npm that is its default registry: when the project has an `.npmrc`, which may name another registry, the list says so under the ready rows.

Skip marks a row as not needed. Rows the new machine already has sit under Ready.

## The saved list

**Save list to project** writes `.specweave/project/credentials.json` in the project:

```json
{
  "version": 1,
  "credentials": [
    { "id": "azure" },
    { "id": "kubernetes", "note": "production cluster" },
    { "id": "npm", "skip": true }
  ]
}
```

It holds names from the app's own list, a skip mark and a short note. It has no field for a command, a path or a value, so it is safe to commit, and a file that holds anything else is not used. The next copy merges it with a fresh scan, which is how a credential the scan cannot see (one used only by hand) stays on the list.

## Where a tool is, and what to run

The destination says where it has each tool, and the commands change to match.

| Where the tool is                                                              | What the row shows                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A new Terminal window finds it                                                 | The plain commands: `wrangler login`, then `wrangler whoami`.                                                                                                                                                                                                              |
| Only in SpecWithCode's own folders                                             | The same commands with that folder added to PATH first: `export PATH=<folder>:"$PATH" && npm login`. For npm the row says it comes with the Node.js that SpecWithCode installs, and that **Use these commands in Terminal** (Settings > General) puts it on PATH for good. |
| In a system folder your Terminal's PATH lacks                                  | The same commands with that folder added to PATH first, and no note.                                                                                                                                                                                                       |
| In the project (`node_modules/.bin` of a folder whose `package.json` lists it) | The commands in that folder through `npx`: `cd <folder> && npx wrangler login`, then `cd <folder> && npx wrangler whoami`.                                                                                                                                                 |
| Nowhere, and the project lists it                                              | First `cd <folder> && npm install` (pnpm, yarn or bun when the project uses one), then the commands above. Nothing is installed for the whole machine.                                                                                                                     |
| Nowhere                                                                        | First the install: `npm install --global <package>` for a tool that comes from npm, `brew install …` where Homebrew is there, or the tool's own installer (Google's install script for gcloud, then a new Terminal window).                                                |

A command is offered only when what it starts with is on that machine: an install through npm needs npm there, one through Homebrew needs `brew`. A folder is added to PATH, instead of naming the tool by its full path, because most of these tools are scripts that look for `node` beside them. A Homebrew cask is offered only on a Mac, and Google's installer only where `curl` is. A project's own tool runs through `npx`, or through `npm exec` on a machine that has npm without it; with neither, the row asks for Node.js first, even where pnpm, yarn or bun stands alone. Where a tool installs through npm, or the project brings it, and Node.js is not on that machine, the row says to install Node.js first (Machine basics offers it). A tool the app knows no install for, such as Docker, gets one plain line: install it yourself, then check again.

**Install there** runs the install command shown above it on the new machine, in the terminal panel that agent installs use, so you see its log and can answer what it asks. It shows only to a connection that may use that machine's terminal, and nothing installs before the click. The install keeps running when its row closes or changes; the row then says it is still running, checks again by itself every 15 seconds, open or closed, and offers no second install until it lands or ten minutes pass. An install is known by its tool and its command, so the same tool being installed for another project does not hold this row back.

Before the copy the new machine has no folder to look in, so a tool the project lists reads "comes with this project" and its commands appear on the Done screen. When the copy turns out not to hold a folder that brings the tool, the Done screen gives the plain install instead.

## What the check does on the destination

The check runs only commands from the app's own list, found by full path in the folders a new Terminal window searches (the login shell's PATH, read again on Check again), system folders (`/usr/bin`, `/usr/local/bin`, Homebrew) and the folders the app installed tools into. A tool whose real location is inside a project registered on that machine is passed over, and no folder inside a registered project is on the PATH the tool gets, so the `node` a script tool looks up is not a project's either. It runs in the home folder, stops after 10 seconds and keeps nothing the tool prints: an exit code is the answer; for Wrangler, which exits 0 when signed out, which of its two fixed sentences it printed; for npm and SSH, whether the error output held the service's own refusal. No account name, token or output is returned, logged or shown.

Its environment is a short fixed list. From your Terminal it gets the proxy settings, the SSH key agent, and the sign-in variables that one tool reads: `GH_TOKEN` or `GITHUB_TOKEN` for `gh`, the `CLOUDFLARE_*` token variables for Wrangler, `NPM_TOKEN` or `NODE_AUTH_TOKEN` for npm. So a machine signed in through such a variable in your shell profile reads as ready, as it does in Terminal. Each tool gets only its own, and the values go to that tool and nowhere else.

A project's own copy of a tool is the project's code, so it never runs when the list opens. The row says so, and it runs when you click Check again.

For SSH the destination runs `ssh -T git@<host>` for github.com, gitlab.com and bitbucket.org, and only those the project reaches over SSH. It runs with `BatchMode=yes`, so it never asks for a passphrase, and with the host's published key pinned beside your own `known_hosts`, so nothing is trusted on first contact and nothing is written there. A host that refuses every key reads "does not accept a key"; a host that could not be reached is no answer. The SSH row is ready only when every place the project connects to is one of those Git hosts and was checked. A project that also reaches a server from a script, or a Git host outside the three, keeps its row and its steps: the row says its Git hosts accept the key and that the other places were not checked.

Sign-in files are looked for by name and never opened: among them `~/.wrangler/config/default.toml`, `~/Library/Preferences/.wrangler/config/default.toml` on macOS, and `.wrangler/config/default.toml` under `XDG_CONFIG_HOME` when that is set. An `XDG_CONFIG_HOME` inside a registered project is not used.

Results are kept for a minute unless you click Check again. Opening the list starts at most six rounds of checks a minute; your own Check again clicks have a separate allowance of thirty a minute. A client needs permission to run work on the machine to ask; reading files is not enough.
