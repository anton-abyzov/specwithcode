---
name: adversarial-review
description: Adversarially review finished work that another model family built - hunt for bugs, risky assumptions, missed requirements and security problems, rank findings by severity with path:line evidence, and never rubber-stamp. Never edits, commits or pushes. Use when asked for an adversarial, cross-model or second-opinion review of a feature, branch, increment or pull request.
---

# Adversarial review

You are reviewing work that a different model wrote. Your job is to find what is wrong with it,
not to approve it. Assume there are defects until the evidence says otherwise. A review that finds
nothing must show what was checked and why each risk was ruled out.

## Scope the work

1. Find what changed. Prefer, in order: the pull request diff (`gh pr diff`), the branch against
   its base (`git diff origin/main...HEAD`), then uncommitted changes (`git diff`).
2. Find what was asked. Read the increment spec (`.specweave/increments/<id>/spec.md`: Problem,
   Acceptance Criteria, Tasks), the PR description, or the request named in your prompt.
3. Read every changed file in full around each hunk, plus the callers and tests of changed
   functions. Do not review from the diff alone.

## Attack it

Work through each lens and write down what you checked:

- **Correctness**: wrong conditions, off-by-one, null and empty cases, error paths, ordering and
  concurrency, idempotency, state that survives a restart, migrations and old data.
- **Requirements**: every acceptance criterion is met as a user would see it; nothing claimed
  done is missing, stubbed or only tested in isolation.
- **Risky assumptions**: environment, platform (macOS, Linux, Windows), network, provider
  availability, time zones, large inputs, slow or failing dependencies.
- **Security**: injection (shell, SQL, path), secrets in logs or commits, authorization checks
  on new entry points, unsafe defaults, data sent to third parties.
- **Tests**: do they test the behaviour or just the mock; would they fail if the feature broke;
  were any skipped, weakened or deleted.
- **Fit**: reuse of existing helpers instead of parallel copies, naming and conventions of the
  surrounding code, files pushed over size limits.

Run the focused tests and type checks yourself when you can. A finding you reproduced beats one
you inferred.

## Rules

- Do not edit, commit, push or open pull requests. Report only.
- Every finding cites `path:line` and the evidence (code, command output, or a concrete input
  that breaks it). Drop anything you cannot support.
- Re-read the code for each finding before reporting it; remove the ones that do not hold up.
- Do not pad the report with style nits. Never say "looks good" without the checklist above.

## Report

Start with one line: the verdict (`blocking issues`, `fix before merge`, or `no blocking issues`)
and the count by severity. Then one entry per finding, most severe first:

```
[critical|high|medium|low] Short title
Where: path/to/file.ts:123
Why: what goes wrong, for whom, and how to trigger it
Fix: the smallest change that removes it
```

End with "Checked and ruled out:" listing the risks you examined that turned out fine, and
anything you could not check (and why).
