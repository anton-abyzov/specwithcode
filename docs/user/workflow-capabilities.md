# Workflow dependency checks

A skill supplies instructions. A provider session supplies tools. SpecWithCode keeps those separate, with capability evidence scoped to the execution machine, provider instance, exact folder and native session/thread.

In Settings > Skills, open a skill to see configuration, discovery, session registration and local check evidence. Every observation has a time and a reason. A discovered skill is not proof its instructions loaded. A registered tool is not proof the external account will authorize its next action.

Declare optional requirements in `SKILL.md` frontmatter:

```yaml
---
name: match-report
metadata:
  specwithcode:
    requires:
      tools:
        - mcp__reports__read_match
      binaries:
        - ffmpeg
      platforms:
        - darwin
        - linux
---
```

Only exact tool ids, executable names and platform names are accepted. Commands, binary paths, arguments, probe scripts, URLs, environment values and credentials are not accepted. Lists and names are bounded. Requirements contain no sign-in material and can travel with the project.

The skill picker checks dependencies on its own execution host. Proven blockers are left out of runnable skill choices; Settings explains them. Submission checks again at the actual provider session, including manually typed known skill invocations. Missing executables, unsupported platforms, malformed declarations and explicit native denials stop dispatch with a reason. Unknown or stale tool evidence is disclosed to the provider without granting access or assuming an absent tool. Skills without declarations retain their existing invocation behavior and show readiness unknown.

Binary checks inspect executable files on the execution PATH, never run commands. Native tool inspection reuses an already-open Codex thread's MCP inventory or Claude's native init metadata. Built-in or deferred tools may be omitted, so an absent tool in a partial list remains unknown. Providers without native session introspection report unsupported. Session closure and replacement discard their runtime evidence. Reopening a session does not inherit an old session's tool registration.

No external service calls are performed to prove workflow readiness. Even when every declared dependency is present, account authentication, OS permission and action authorization remain separate. No credential or provider home is copied between machines; no grant, install, enable, restart or remote provider turn is triggered by these checks. A disconnected or older remote server cannot be replaced with local capability evidence.

Agents can read the same evidence with `studio_workflow_capabilities {"skill":"match-report"}`. It is restricted to the calling project and returns each provider's own observations; an empty result does not prove the tool or workflow is unavailable elsewhere.

The existing app-managed project connections remain the explicit way to make a tool available across providers. Native provider plugins and ChatGPT account connectors keep their own loading and authorization rules. These checks do not emulate those connectors for other providers.
