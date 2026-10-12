# Workflow candidate

This candidate adds Settings → Agents to installed Studio v0.1.4's source baseline. It runs from its own built server and uses a separate profile by default:

```sh
node scripts/studio-verify/workflow-candidate.mjs
```

Use Node 22. The launcher chooses a free loopback port; open the local server address shown in your terminal. The default profile is `~/.local/share/specweave-studio-workflow-candidate`; it has its own settings and projects. Select your existing repository in this profile, then open Settings → Agents. Environment instructions always remain part of the effective context; project instructions are additions. The workflow policy is Disabled, On request or Automatic, independently from reasoning effort. Existing Claude Code login is used by native execution.

The launcher forwards other commands to the same built candidate:

```sh
node scripts/studio-verify/workflow-candidate.mjs managed-agents --help
node scripts/studio-verify/workflow-candidate.mjs managed-agents status
```

The separate public beta requires `ANTHROPIC_API_KEY` and an active Managed Agents environment in an explicit JSON configuration. See [Managed Agents](managed-agents.md) for the complete command and budget fields. It is a bounded text-workflow executor; its cloud instructions are specified in that configuration, separately from native project settings. Test environments were archived after verification and are intentionally not reusable configurations. The candidate stores no API key.

Native evidence independently verified two workflow workers using Claude Code 2.1.295 and SDK 0.3.276. Public-beta evidence independently verified three predefined worker threads and two ended phases. UI verification used the built server with explicit headless browser execution and isolated fixture state. These are development receipts, not a published release or persistent cloud-project service.
