#!/usr/bin/env python3
"""What one Release macOS run does, decided on GitHub's side and not by whoever dispatched it.

release-macos.yml runs this first, on a hosted runner, inside the workflow's concurrency group, so
one run at a time reads the repository and decides. Any number of sessions may dispatch the
workflow; none of them picks the version:

  no version      release what main holds: the next patch after the highest v1.x.y tag. A run that
                  finds main already released ends green without touching the release Mac. A run
                  that finds the newest release published but not merged finishes that one first.
  version         a deliberate version: refused when it is tagged or not above the highest tag.
  version+resume  continue that release on the release Mac (release.sh --resume).

Run: python3 -B scripts/release/release_plan.py --repo OWNER/NAME [--version X] [--resume]
Writes action, version, resume, mode, latest and reason to $GITHUB_OUTPUT, a line to
$GITHUB_STEP_SUMMARY, and exits 1 only for a refusal. Tests: test-release-plan.py.
"""
import argparse
import json
import os
import re
import subprocess
import sys

# The installer and updater accept only 1.x.y (release.sh POLICY_RE).
VERSION_RE = re.compile(r'^1\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')
TAG_RE = re.compile(r'^refs/tags/v(1\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$')


def key(version):
    return tuple(int(part) for part in version.split('.'))


def next_patch(version):
    major, minor, patch = key(version)
    return f'{major}.{minor}.{patch + 1}'


def plan(action, version='', resume=False, mode='', latest='', reason=''):
    return {'action': action, 'version': version, 'resume': resume, 'mode': mode,
            'latest': latest or '', 'reason': reason}


def decide(requested, resume, tags, main_tree, latest_tree, latest_merged):
    """The run's plan. tags: released versions (1.x.y). latest_tree: the tree of the highest tag.
    latest_merged: whether that release is on main (its tag is reachable from main, or its
    release/<version> pull request merged)."""
    released = sorted({tag for tag in tags if VERSION_RE.match(tag)}, key=key)
    latest = released[-1] if released else ''
    if requested:
        if not VERSION_RE.match(requested):
            return plan('refuse', latest=latest, reason=f"version must look like 1.2.3, got '{requested}'")
        if resume:
            return plan('release', requested, True, 'resume', latest,
                        f'continuing {requested} on the release Mac')
        if requested in released:
            return plan('refuse', latest=latest, reason=(
                f'v{requested} is already released. Dispatch without a version to release what '
                f'main holds now, or with resume to finish {requested}.'))
        if latest and key(requested) < key(latest):
            return plan('refuse', latest=latest, reason=(
                f'{requested} is below the newest release {latest}. Dispatch without a version.'))
        return plan('release', requested, False, 'version', latest, f'releasing {requested} as asked')
    if resume:
        return plan('refuse', latest=latest, reason='resume needs the version to continue')
    if not latest:
        return plan('refuse', reason='no v1.x.y tag to count from; dispatch with a version')
    if not latest_merged:
        return plan('release', latest, True, 'finish', latest, (
            f'v{latest} is published but release/{latest} is not on main; finishing it before '
            f'anything new is cut'))
    if main_tree and main_tree == latest_tree:
        return plan('noop', latest, False, 'request', latest,
                    f'main is already released as v{latest}; nothing to cut')
    return plan('release', next_patch(latest), False, 'request', latest,
                f'main has changes since v{latest}')


def gh(*args):
    done = subprocess.run(['gh', *args], capture_output=True, text=True, check=False)
    if done.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args)}: {done.stderr.strip() or done.stdout.strip()}")
    return done.stdout


def read_tags(repo, run=gh):
    refs = run('api', '--paginate', f'repos/{repo}/git/matching-refs/tags/v1.?per_page=100',
               '--jq', '.[].ref')
    return [match.group(1) for match in map(TAG_RE.match, refs.split()) if match]


def read_commit(repo, ref, run=gh):
    """(commit sha, tree sha) of a branch, tag or commit."""
    sha, tree = run('api', f'repos/{repo}/commits/{ref}', '--jq', '.sha, .commit.tree.sha').split()
    return sha, tree


def read_merged(repo, branch, version, run=gh):
    """Whether v<version> is on the branch: reachable from it, or its release pull request merged
    (a squash merge leaves the tag unreachable)."""
    status = run('api', f'repos/{repo}/compare/{branch}...v{version}', '--jq', '.status').strip()
    if status in ('behind', 'identical'):
        return True
    merged = run('pr', 'list', '-R', repo, '--head', f'release/{version}', '--state', 'merged',
                 '--json', 'number', '--jq', 'length').strip()
    return merged not in ('', '0')


def gather(repo, branch, requested, run=gh):
    tags = read_tags(repo, run)
    facts = {'tags': tags, 'main_sha': '', 'main_tree': '', 'latest_tree': '', 'latest_merged': True}
    released = sorted({tag for tag in tags if VERSION_RE.match(tag)}, key=key)
    if requested or not released:
        return facts
    latest = released[-1]
    facts['main_sha'], facts['main_tree'] = read_commit(repo, branch, run)
    facts['latest_tree'] = read_commit(repo, f'v{latest}', run)[1]
    facts['latest_merged'] = read_merged(repo, branch, latest, run)
    return facts


def emit(result, main_sha):
    lines = [f"{name}={str(value).lower() if isinstance(value, bool) else value}"
             for name, value in result.items()]
    lines.append(f'main_sha={main_sha}')
    output = os.environ.get('GITHUB_OUTPUT')
    if output:
        with open(output, 'a', encoding='utf-8') as handle:
            handle.write('\n'.join(lines) + '\n')
    headline = {
        'release': f"Release macOS: {result['version']} ({result['mode']}). {result['reason']}.",
        'noop': f"Release macOS: nothing to do. {result['reason']}.",
        'refuse': f"Release macOS refused: {result['reason']}",
    }[result['action']]
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as handle:
            handle.write(headline + '\n')
    level = 'error' if result['action'] == 'refuse' else 'notice'
    print(f'::{level}::{headline}')
    print(json.dumps(dict(result, main_sha=main_sha)))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    parser.add_argument('--repo', required=True)
    parser.add_argument('--branch', default='main')
    parser.add_argument('--version', default='')
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args(argv)
    requested = args.version.strip()
    facts = gather(args.repo, args.branch, requested)
    result = decide(requested, args.resume, facts['tags'], facts['main_tree'], facts['latest_tree'],
                    facts['latest_merged'])
    emit(result, facts['main_sha'])
    return 1 if result['action'] == 'refuse' else 0


if __name__ == '__main__':
    sys.exit(main())
