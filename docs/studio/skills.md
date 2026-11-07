# Create and manage skills

In SpecWithCode, open **Settings → Skills**, choose the machine and project (or the machine’s user scope), then select **New skill**. You can also open **Skills** beside the conversation composer and select **New skill**.

## Create a skill

1. Choose **Describe** to write what the skill should do, or **Paste SKILL.md** to import existing instructions. Describing a skill requires a configured, available provider; pasting does not generate content.
2. Choose the agents and project/user scope. Review the name, description, instructions and version before saving. A local draft is not a registry publication or an installed skill.
3. Use **Save draft** to keep your work. In the review step, choose a repository and public/private visibility, review the publication confirmation, then select **Publish for review**. A queued submission is not yet published. Private publication requires the corresponding registry access.
4. In **Apply**, preview the files that will change before confirming installation. Availability to new sessions is distinct from whether a running agent has reloaded those files.

## Read and edit

Click any skill name in the composer’s Skills popover to open its detail in Settings with that machine, agent and conversation folder retained. The popover search is retained when you return. If the original context is unavailable, reconnect it rather than editing a same-named skill elsewhere.

The detail shows a summary and usage guidance taken from the skill’s own description. **Show more** reveals the full description. **Instructions** renders the selected copy’s SKILL.md body. Markdown links and inline code are supported; embedded HTML and remote images are not executed or fetched.

Under **Instructions**, select the copy you want and choose **Edit and publish**. Existing drafts are preserved: explicitly choose **Use selected copy** when offered. Review the version and content before publishing. Unsupported frontmatter is reported rather than silently discarded. Plugin-managed or otherwise protected copies cannot be edited here.

**Loaded by** groups agents that share a path while retaining each agent’s switch. A file version, the version installed through the registry, and an agent’s loading readiness describe different things; they should not be treated as interchangeable.

## Resolve differing copies

Select **Copies differ** in the popover or detail to open **Compare** directly. Choose **Content to keep** and **Compare with** to inspect paths, agent membership, versions, hashes and text differences on the selected machine.

Select writable destinations, choose **Choose this copy**, inspect the exact destination changes, then select **Confirm replacement**. **Cancel** performs no writes. A changed source or destination invalidates the preview; refresh and review again. Copy replacement does not publish a new registry version.

## Install on other machines

**Available on** reports observations from the selected machine and its linked fleet members. Expand a machine to inspect agents and refresh its observation. Offline, inaccessible, incomplete and unknown states are not proof that a skill is absent. A project must be linked on a target before project-scope availability can be checked.

For a registry-backed skill, select **Install on all**. Choose reachable machines, agents and user/project scope, then preview installation. Review the pinned version, content hash and eligible destinations before selecting **Confirm installation**. A verified registry content hash and permission to maintain machines are required. Publish local-only skills before registry distribution.

Installation reports a result for each target. Successful targets remain recorded; retry previews only the failed targets. Offline or permission-denied targets are not silently treated as installed. Running sessions are not restarted, so installation does not prove that they have loaded the new version.

If the connection drops after a target accepts installation, its outcome stays unknown until checked. Refresh availability before retrying. Discovery does not substitute for an installation receipt.

Current verification limit: Codex-only or Cursor-only installation of a skill containing Claude-specific frontmatter can finish writing but fail exact-content verification because the installer transforms those fields. Selecting Claude Code as well provides the original-content proof. An unverified result is never reported as installed.
