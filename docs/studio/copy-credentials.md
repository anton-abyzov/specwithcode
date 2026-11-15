# Credentials a project uses, when you copy it to another machine

Copy to another machine carries the project folder and the secret files inside it that you tick (`.env`, keys in the folder, .NET user secrets). It never carries what lives in your home folder: sign-ins to GitHub, Azure, Google Cloud, AWS, Cloudflare, npm or a container registry, Kubernetes access and SSH keys. Each machine keeps its own, so a copied project can find the new machine not signed in to something it needs.

The review and Done screens of a copy show **Credentials this project uses**. It answers three questions.

- **What does this project use?** The source machine reads names in the project: Terraform providers, commands in scripts, workflows, a Makefile and `package.json`, files such as `wrangler.jsonc` or `Chart.yaml`, and the hosts of its Git remotes. It never opens a secret file and reports no file content.
- **Does the new machine have it?** The destination asks each tool it has, for example `gh auth status` or `az account show`, and answers with one word: ready, not signed in, tool not installed, or check it yourself. npm, Wrangler, container registries and SSH have no check, and Windows machines answer "check it yourself".
- **How do I set it up there?** Sign in there shows the command for that machine, with Copy and Check again. For SSH keys the row says to create a new key on the new machine and add it where the old one is trusted. Nothing in this list is sent.

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

## What the check does on the destination

The check runs only commands from the app's own list, found by full path in system and app-managed folders, never a tool inside a project. It runs in the home folder with a short fixed environment, stops after 10 seconds and keeps nothing the tool prints. Results are kept for a minute and a machine is checked at most six times a minute. A client needs permission to run work on the machine to ask; reading files is not enough.
