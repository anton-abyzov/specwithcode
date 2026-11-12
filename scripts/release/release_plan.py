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

Then, on the release Mac, `attempt` decides how the planned version starts when an earlier attempt
left its staging folder there: continued (release.sh --resume), started over from main, or refused.

Run: python3 -B scripts/release/release_plan.py plan --repo OWNER/NAME [--version X] [--resume]
     python3 -B scripts/release/release_plan.py attempt --repo OWNER/NAME --version X [--resume]
plan writes action, version, resume, mode, latest, reason and main_sha to $GITHUB_OUTPUT; attempt
writes resumed. Both add a line to $GITHUB_STEP_SUMMARY and exit 1 only for a refusal.
Tests: test-release-plan.py.
"""
import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import uuid

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


def decide(requested, resume, tags, main_tree, latest_tree, latest_merged, conflict=0):
    """The run's plan. tags: released versions (1.x.y). latest_tree: the tree of the highest tag.
    latest_merged: whether that release is on main (its tag is reachable from main, or its
    release/<version> pull request merged). conflict: the number of its open pull request when
    that one conflicts with main, else 0."""
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
    if not latest_merged and conflict:
        return plan('refuse', latest=latest, reason=(
            f'v{latest} is published, but its merge into main (pull request #{conflict}) '
            f'conflicts. Resolve and merge that pull request, then dispatch again: nothing new '
            f'is cut on top of a release main does not hold.'))
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


def read_conflict(repo, version, run=gh):
    """The number of release/<version>'s open pull request when it conflicts with its base."""
    number = run('pr', 'list', '-R', repo, '--head', f'release/{version}', '--state', 'open',
                 '--json', 'number,mergeable', '--jq',
                 '[.[] | select(.mergeable == "CONFLICTING")][0].number // 0').strip()
    return int(number or 0)


def gather(repo, branch, requested, run=gh):
    tags = read_tags(repo, run)
    facts = {'tags': tags, 'main_sha': '', 'main_tree': '', 'latest_tree': '', 'latest_merged': True,
             'conflict': 0}
    released = sorted({tag for tag in tags if VERSION_RE.match(tag)}, key=key)
    if requested or not released:
        return facts
    latest = released[-1]
    facts['main_sha'], facts['main_tree'] = read_commit(repo, branch, run)
    facts['latest_tree'] = read_commit(repo, f'v{latest}', run)[1]
    facts['latest_merged'] = read_merged(repo, branch, latest, run)
    if not facts['latest_merged']:
        facts['conflict'] = read_conflict(repo, latest, run)
    return facts


# ---------------------------------------------------------------- attempt (on the release Mac)

BUMP_SUBJECT = 'Prepare SpecWithCode {version} release'
# An unchanged candidate is continued this many times by runs that did not ask for it by name.
# release.sh already retries a flaky job itself, so a candidate that failed, was continued once
# and failed again needs a fix, not the release Mac for another run.
SAME_CANDIDATE_RETRIES = 1
HELD = 'held'
REQUESTS = 'requests.log'


def git(build, *args):
    done = subprocess.run(['git', '-C', str(build), *args], capture_output=True, text=True, check=False)
    if done.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {done.stderr.strip()}")
    return done.stdout.strip()


def attempt(version, resume, staging_root, trees, url, branch='main', run=git):
    """('resume' | 'fresh' | 'refuse', why) for the planned version on this Mac.

    A staging folder with release.json is an attempt that did not finish. It is continued when
    that is what was asked (resume), when it already published, when someone committed a fix to
    its release branch, or when main has not moved since its candidate was cut (a flaky failure).
    When main has moved and the attempt holds nothing but the bump, the attempt is retired and
    the version starts over from main, so a fix merged to main reaches it. A release stopped on
    purpose (stop_after) and a candidate that keeps failing unchanged are refused: both need a
    person or session to decide, with resume."""
    stage = pathlib.Path(staging_root) / version
    held = stage / HELD
    if resume:
        held.unlink(missing_ok=True)
        return 'resume', f'continuing {version} as asked'
    if not (stage / 'release.json').is_file():
        return 'fresh', f'no earlier attempt of {version} on this Mac'
    if held.exists():
        return 'refuse', (f'{version} was stopped on purpose ({held.read_text().strip()}). '
                          f'Dispatch with version {version} and resume to continue it.')
    if (stage / 'published.sha').is_file():
        return 'resume', f'{version} is published; finishing it'
    if (stage / 'lock').exists():
        return 'resume', f'{version} holds a lock; release.sh decides'
    build = pathlib.Path(trees) / 'build'
    ref = f'refs/heads/release/{version}'
    try:
        candidate = run(build, 'rev-parse', '--verify', '--quiet', f'{ref}^{{commit}}')
        run(build, 'fetch', '-q', url, branch)
        main = run(build, 'rev-parse', 'FETCH_HEAD')
        base = run(build, 'merge-base', main, candidate)
        subjects = run(build, 'log', '--format=%s', f'{base}..{candidate}', '--').splitlines()
    except (RuntimeError, OSError) as error:
        return 'resume', f'could not compare {version} with {branch} ({error}); release.sh decides'
    fixed = [subject for subject in subjects if subject and subject != BUMP_SUBJECT.format(version=version)]
    if not fixed and main != base:
        stage.rename(stage.with_name(f'.retired-{version}-{uuid.uuid4().hex}'))
        return 'fresh', (f'{branch} moved since the failed attempt of {version} was cut, and that '
                         f'attempt holds no fix of its own; starting {version} over from {branch}')
    log = stage / REQUESTS
    seen = log.read_text().splitlines() if log.is_file() else []
    entry = f'{candidate} {main}'
    if seen.count(entry) >= SAME_CANDIDATE_RETRIES:
        return 'refuse', (
            f'{version} failed at candidate {candidate[:12]} and nothing changed since: fix it on '
            f'{branch} (the next run starts {version} over) or commit the fix in the build tree, '
            f'then dispatch again. Dispatch with version {version} and resume to try it unchanged.')
    with log.open('a', encoding='utf-8') as handle:
        handle.write(entry + '\n')
    why = 'its release branch holds a fix' if fixed else f'{branch} has not moved since it was cut'
    return 'resume', f'continuing the earlier attempt of {version}: {why}'


def hold(version, stage_name, staging_root, note=''):
    """Mark a release stopped on purpose (stop_after), so only a run that names it continues it."""
    stage = pathlib.Path(staging_root) / version
    if (stage / 'release.json').is_file():
        (stage / HELD).write_text(f'after {stage_name}{", " + note if note else ""}\n', encoding='utf-8')


# ---------------------------------------------------------------- output

def write_output(pairs):
    output = os.environ.get('GITHUB_OUTPUT')
    if output:
        with open(output, 'a', encoding='utf-8') as handle:
            handle.write(''.join(f'{name}={value}\n' for name, value in pairs))


def announce(headline, refused):
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as handle:
            handle.write(headline + '\n')
    print(f"::{'error' if refused else 'notice'}::{headline}")


def emit(result, main_sha):
    write_output([(name, str(value).lower() if isinstance(value, bool) else value)
                  for name, value in result.items()] + [('main_sha', main_sha)])
    headline = {
        'release': f"Release macOS: {result['version']} ({result['mode']}). {result['reason']}.",
        'noop': f"Release macOS: nothing to do. {result['reason']}.",
        'refuse': f"Release macOS refused: {result['reason']}",
    }[result['action']]
    announce(headline, result['action'] == 'refuse')
    print(json.dumps(dict(result, main_sha=main_sha)))


def default_staging():
    return os.environ.get('RELEASE_STAGING_ROOT') or os.path.expanduser('~/.specwithcode/release-staging')


def default_trees():
    return os.environ.get('RELEASE_TREES') or os.path.expanduser('~/.specwithcode/release.noindex')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('plan', 'attempt'):
        command = commands.add_parser(name)
        command.add_argument('--repo', required=True)
        command.add_argument('--branch', default='main')
        command.add_argument('--version', default='')
        command.add_argument('--resume', action='store_true')
    held = commands.add_parser('hold')
    held.add_argument('--version', required=True)
    held.add_argument('--after', required=True)
    held.add_argument('--note', default='')
    args = parser.parse_args(argv)
    requested = args.version.strip()
    if args.command == 'plan':
        facts = gather(args.repo, args.branch, requested)
        result = decide(requested, args.resume, facts['tags'], facts['main_tree'],
                        facts['latest_tree'], facts['latest_merged'], facts['conflict'])
        emit(result, facts['main_sha'])
        return 1 if result['action'] == 'refuse' else 0
    if not VERSION_RE.match(requested):
        print(f"::error::version must look like 1.2.3, got '{requested}'")
        return 1
    if args.command == 'hold':
        hold(requested, args.after, default_staging(), args.note)
        return 0
    how, why = attempt(requested, args.resume, default_staging(), default_trees(),
                       f'https://github.com/{args.repo}.git', args.branch)
    write_output([('resumed', 'true' if how == 'resume' else 'false')])
    announce(f'Release macOS {requested}: {why}.' if how != 'refuse' else f'Release macOS refused: {why}',
             how == 'refuse')
    return 1 if how == 'refuse' else 0


if __name__ == '__main__':
    sys.exit(main())
