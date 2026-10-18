#!/usr/bin/env bash
# Fails when a commit in the given range names an AI assistant as its author or
# committer, or carries an assistant co-author, session or "generated with" line.
# Usage: scripts/check-commit-attribution.sh <rev-range>   e.g. origin/main..HEAD
set -euo pipefail

range="${1:?usage: check-commit-attribution.sh <rev-range>}"
identity='(noreply@anthropic\.com|@anthropic\.com|codex@openai\.com|noreply@openai\.com|copilot-swe-agent|^(claude|codex|chatgpt|copilot|gemini)( |\||$))'
trailer='^(co-authored-by:.*(claude|anthropic|codex|openai|chatgpt|copilot|gemini)|claude-session:|.*generated with \[?(claude|codex)|.*claude\.ai/code/session|.*chatgpt\.com/codex)'

status=0
while read -r sha; do
  people="$(git log -1 --format='%an <%ae>|%cn <%ce>' "$sha")"
  lines="$(git log -1 --format='%B' "$sha" | grep -inE "$trailer" || true)"
  if grep -qiE "$identity" <<<"$people" || grep -qiE "$identity" <<<"$(git log -1 --format='%an|%cn' "$sha")" || test -n "$lines" || git log -1 --format='%B' "$sha" | grep -q $'\xf0\x9f\xa4\x96'; then
    status=1
    printf '%s %s\n  %s\n' "$(git log -1 --format='%h' "$sha")" "$(git log -1 --format='%s' "$sha")" "$people"
    test -z "$lines" || sed 's/^/  /' <<<"$lines"
  fi
done < <(git rev-list "$range")

if test "$status" -ne 0; then
  cat >&2 <<'MSG'

These commits carry AI assistant attribution, which this repository does not accept.
Rewrite them before merging, for example:
  git filter-branch -f \
    --msg-filter 'grep -viE "^(co-authored-by:.*(claude|anthropic|codex|openai|chatgpt|copilot|gemini)|claude-session:)"' \
    --env-filter 'export GIT_AUTHOR_NAME="$(git config user.name)" GIT_AUTHOR_EMAIL="$(git config user.email)" GIT_COMMITTER_NAME="$(git config user.name)" GIT_COMMITTER_EMAIL="$(git config user.email)"' \
    origin/main..HEAD
then force-push the branch.
MSG
fi
exit "$status"
