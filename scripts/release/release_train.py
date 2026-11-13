#!/usr/bin/env python3
"""The daily stable train (docs/studio/release-train.md): the only way a 1.1+ build becomes stable.

Every release run publishes a 1.1+ build as an Insiders build, a GitHub prerelease that never takes
Latest (scripts/studio-projects/release-flags.mjs). Once a day, at the cut time in
.github/workflows/release-train.yml, `promote` picks the newest Insiders build that

  - is above the current stable release and at or above 1.1.0,
  - was published at least --soak-hours before the run (24 by default),
  - carries the macOS, Windows and Linux update manifests (the Windows and Linux apps are attached
    after the macOS release), and
  - is not held (`hold`),

and promotes that same release to stable: not a draft, not a prerelease, Latest, with notes that
list the Insiders builds it includes. Nothing is rebuilt, so stable users get the exact files the
fleet ran. A run that finds nothing to promote, or runs within --min-hours of the last promotion,
ends green and changes nothing.

A hotfix (--hotfix-pr N) skips the soak and the interval: the pull request must be merged and carry
the `hotfix` label, and the newest complete, unheld Insiders build that holds its merge commit is
promoted. Build one first (scripts/release/request-release.sh --hotfix N does both).

    python3 -B scripts/release/release_train.py promote --repo OWNER/NAME [--version X.Y.Z]
                                               [--hotfix-pr N] [--soak-hours 24] [--dry-run]
    python3 -B scripts/release/release_train.py hold --repo OWNER/NAME --version X.Y.Z --reason TEXT
    python3 -B scripts/release/release_train.py unhold --repo OWNER/NAME --version X.Y.Z
    python3 -B scripts/release/release_train.py status --repo OWNER/NAME

promote writes action, version and reason to $GITHUB_OUTPUT and a line to $GITHUB_STEP_SUMMARY.
Exit 0 promoted or nothing to do, 1 refused (a bad hotfix or --version), 2 bad arguments.
Tests: test-release-train.py.
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import tempfile

VERSION_RE = re.compile(r'^v?((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$')
TRAIN_SINCE = (1, 1, 0)
MANIFESTS = ('latest-mac.yml', 'latest.yml', 'latest-linux.yml', 'latest-linux-arm64.yml')
HOLD_RE = re.compile(r'^<!-- release-train: hold: (.*) -->\n(?:\*\*Held from stable:\*\*.*\n)?', re.MULTILINE)
PROMOTED_RE = re.compile(r'<!-- release-train: promoted (\S+) -->')
HOTFIX_LABEL = 'hotfix'
NOTES_LIMIT = 120_000  # GitHub refuses release bodies over 125,000 characters.


def key(version):
    return tuple(int(part) for part in version.split('.'))


def plain(tag):
    match = VERSION_RE.match(tag or '')
    return match.group(1) if match else None


def parse_time(text):
    return datetime.datetime.strptime(text, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)


def iso(moment):
    return moment.astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def held(release):
    match = HOLD_RE.search(release.get('body') or '')
    return match.group(1) if match else None


def promoted_at(release):
    match = PROMOTED_RE.search(release.get('body') or '')
    return parse_time(match.group(1)) if match else None


def builds(releases):
    """Published releases with plain versions, newest first, as (version, release)."""
    found = []
    for release in releases:
        version = plain(release.get('tag_name'))
        if version and not release.get('draft') and release.get('published_at'):
            found.append((version, release))
    return sorted(found, key=lambda item: key(item[0]), reverse=True)


def current_stable(releases):
    for version, release in builds(releases):
        if not release.get('prerelease'):
            return version, release
    return None, None


def missing_manifests(release):
    names = {asset.get('name') for asset in release.get('assets') or []}
    return [name for name in MANIFESTS if name not in names]


def outcome(action, version='', reason='', included=()):
    return {'action': action, 'version': version, 'reason': reason, 'included': list(included)}


def decide(releases, now, soak_hours=24.0, min_hours=20.0, requested='', hotfix=None):
    """What promote does. hotfix: None, or {'number', 'merged', 'labels', 'contains': set of
    versions whose tag holds the merge commit} as read from GitHub."""
    stable, stable_release = current_stable(releases)
    if hotfix is not None:
        if not hotfix['merged']:
            return outcome('refuse', reason=f"pull request #{hotfix['number']} is not merged")
        if HOTFIX_LABEL not in hotfix['labels']:
            return outcome('refuse', reason=(
                f"pull request #{hotfix['number']} has no `{HOTFIX_LABEL}` label; a hotfix needs "
                f"Anton's yes and the label (docs/studio/release-train.md)"))
    else:
        last = promoted_at(stable_release) if stable_release else None
        if last and now - last < datetime.timedelta(hours=min_hours):
            return outcome('noop', stable, (
                f'v{stable} was promoted at {iso(last)}, less than {min_hours:g} hours ago; '
                f'one stable release a day'))
    skipped = []
    for version, release in builds(releases):
        if not release.get('prerelease') or key(version) < TRAIN_SINCE:
            continue
        if stable and key(version) <= key(stable):
            continue
        if requested and version != requested:
            continue
        why = None
        if held(release) is not None:
            why = f'held ({held(release)})'
        elif missing_manifests(release):
            why = 'missing ' + ', '.join(missing_manifests(release))
        elif hotfix is not None and version not in hotfix['contains']:
            why = f"does not hold pull request #{hotfix['number']}"
        elif hotfix is None and now - parse_time(release['published_at']) < datetime.timedelta(hours=soak_hours):
            why = f"published {release['published_at']}, soaking until {soak_hours:g} hours have passed"
        if why and requested:
            return outcome('refuse', version, f'v{version} {why}')
        if why:
            skipped.append(f'v{version} {why}')
            continue
        included = [v for v, r in builds(releases) if r.get('prerelease') and key(v) <= key(version)
                    and key(v) >= TRAIN_SINCE and (stable is None or key(v) > key(stable))]
        label = f"hotfix #{hotfix['number']}" if hotfix is not None else f'soaked {soak_hours:g} hours'
        return outcome('promote', version, f'promoting v{version} to stable ({label})', included)
    if requested:
        return outcome('refuse', requested, f'v{requested} is not an Insiders build above the current stable')
    if hotfix is not None:
        return outcome('refuse', reason=(
            f"no complete, unheld Insiders build holds pull request #{hotfix['number']} yet"
            + (f" ({'; '.join(skipped[:3])})" if skipped else '')
            + '; request a release first (scripts/release/request-release.sh --hotfix)'))
    return outcome('noop', stable or '', 'nothing to promote'
                   + (f": {'; '.join(skipped[:5])}" if skipped else ': no Insiders build above the current stable'))


def stable_notes(version, release, releases, included, now):
    """The promoted release's body: what it includes, then each included build's own notes."""
    stable, _ = current_stable(releases)
    by_version = dict(builds(releases))
    since = f' since {stable}' if stable and key(stable) >= TRAIN_SINCE else ''
    others = [v for v in included if v != version]
    lines = [f'<!-- release-train: promoted {iso(now)} -->',
             f'**Stable release.** Promoted from Insiders by the daily train on {now:%B} {now.day}, {now.year}.']
    if not stable or key(stable) < TRAIN_SINCE:
        lines.append(f'SpecWithCode {version} starts the 1.1 line, the first stable release. 1.0.x is '
                     f'frozen at {stable or "its last release"}; 1.0 installs update to this one.')
    if others:
        lines.append(f'Includes the Insiders builds {", ".join(sorted(others, key=key))}{since}.')
    lines.append('')
    lines.append(HOLD_RE.sub('', release.get('body') or '').strip())
    for other in sorted(others, key=key, reverse=True):
        body = HOLD_RE.sub('', by_version[other].get('body') or '').strip()
        if body:
            lines += ['', f'<details><summary>From {other}</summary>', '', body, '', '</details>']
    text = '\n'.join(lines).strip() + '\n'
    if len(text) > NOTES_LIMIT:
        text = text[:NOTES_LIMIT].rsplit('\n', 1)[0] + '\n\n(Notes shortened; see each Insiders release.)\n'
    return text


# ---------------------------------------------------------------- GitHub


def gh(*args, stdin=None):
    done = subprocess.run(['gh', *args], capture_output=True, text=True, check=False, input=stdin)
    if done.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args)}: {done.stderr.strip() or done.stdout.strip()}")
    return done.stdout


def read_releases(repo, run=gh):
    pages = run('api', '--paginate', '--slurp', f'repos/{repo}/releases?per_page=100')
    releases = [release for page in json.loads(pages) for release in page]
    # The newest 300 are plenty: a stable release more than a few days back is promoted already.
    return releases[:300]


def read_hotfix(repo, number, releases, run=gh):
    pull = json.loads(run('api', f'repos/{repo}/pulls/{number}'))
    merge = pull.get('merge_commit_sha') if pull.get('merged') else None
    contains = set()
    if merge:
        for version, release in builds(releases):
            if not release.get('prerelease') or key(version) < TRAIN_SINCE:
                continue
            status = run('api', f'repos/{repo}/compare/{merge}...v{version}', '--jq', '.status').strip()
            if status not in ('ahead', 'identical'):
                break  # Older builds than the first one without it cannot hold it either.
            contains.add(version)
    return {'number': number, 'merged': bool(pull.get('merged')),
            'labels': [label.get('name') for label in pull.get('labels') or []], 'contains': contains}


def edit_body(repo, version, body, *flags, run=gh):
    with tempfile.NamedTemporaryFile('w', suffix='.md', delete=False, encoding='utf-8') as handle:
        handle.write(body)
        path = handle.name
    try:
        run('release', 'edit', f'v{version}', '-R', repo, '--notes-file', path, *flags)
    finally:
        os.unlink(path)


def release_of(releases, version):
    for found, release in builds(releases):
        if found == version:
            return release
    raise RuntimeError(f'v{version} is not a published release')


# ---------------------------------------------------------------- output


def write_output(pairs):
    output = os.environ.get('GITHUB_OUTPUT')
    if output:
        with open(output, 'a', encoding='utf-8') as handle:
            handle.write(''.join(f"{name}={' '.join(str(value).split())}\n" for name, value in pairs))


def announce(line, refused):
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as handle:
            handle.write(line + '\n')
    print(f"::{'error' if refused else 'notice'}::{line}")


def main(argv=None, run=gh, now=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('promote', 'hold', 'unhold', 'status'):
        command = commands.add_parser(name)
        command.add_argument('--repo', required=True)
        command.add_argument('--version', default='')
        if name == 'promote':
            command.add_argument('--hotfix-pr', type=int, default=0)
            command.add_argument('--soak-hours', type=float, default=24.0)
            command.add_argument('--min-hours', type=float, default=20.0)
            command.add_argument('--dry-run', action='store_true')
        if name == 'hold':
            command.add_argument('--reason', required=True)
    args = parser.parse_args(argv)
    requested = (args.version or '').strip()
    if requested and not plain(requested):
        print(f'release_train.py: version must look like 1.2.3, got {requested[:40]!r}', file=sys.stderr)
        return 2
    requested = plain(requested) if requested else ''
    if args.command in ('hold', 'unhold') and not requested:
        print(f'release_train.py: {args.command} needs --version', file=sys.stderr)
        return 2
    now = now or datetime.datetime.now(datetime.timezone.utc)
    releases = read_releases(args.repo, run)

    if args.command == 'status':
        stable, _ = current_stable(releases)
        print(f'stable: v{stable}' if stable else 'stable: none')
        for version, release in builds(releases)[:20]:
            if release.get('prerelease') and key(version) >= TRAIN_SINCE:
                state = held(release) and f'held: {held(release)}' or (
                    'missing ' + ', '.join(missing_manifests(release)) if missing_manifests(release) else 'complete')
                print(f"insiders: v{version} published {release['published_at']} ({state})")
        return 0

    if args.command in ('hold', 'unhold'):
        release = release_of(releases, requested)
        if not release.get('prerelease'):
            print(f'release_train.py: v{requested} is stable already; ship a fix instead', file=sys.stderr)
            return 1
        body = HOLD_RE.sub('', release.get('body') or '')
        if args.command == 'hold':
            reason = ' '.join(args.reason.split()).replace('-->', '')[:200]
            body = f'<!-- release-train: hold: {reason} -->\n**Held from stable:** {reason}\n\n' + body.lstrip('\n')
        edit_body(args.repo, requested, body, run=run)
        print(f"v{requested} {'held' if args.command == 'hold' else 'no longer held'}")
        return 0

    hotfix = read_hotfix(args.repo, args.hotfix_pr, releases, run) if args.hotfix_pr else None
    result = decide(releases, now, args.soak_hours, args.min_hours, requested, hotfix)
    write_output([('action', result['action']), ('version', result['version']), ('reason', result['reason'])])
    if result['action'] == 'promote' and not args.dry_run:
        release = release_of(releases, result['version'])
        notes = stable_notes(result['version'], release, releases, result['included'], now)
        edit_body(args.repo, result['version'], notes, '--prerelease=false', '--latest', run=run)
        state = json.loads(run('release', 'view', f"v{result['version']}", '-R', args.repo,
                               '--json', 'isPrerelease,isDraft'))
        if state.get('isPrerelease') or state.get('isDraft'):
            raise RuntimeError(f"v{result['version']} is still a prerelease or draft after the edit")
    prefix = 'Release train (dry run)' if args.dry_run else 'Release train'
    announce(f"{prefix}: {result['action']} {result['version'] or ''}. {result['reason']}.".replace('  ', ' '),
             result['action'] == 'refuse')
    print(json.dumps(result))
    return 1 if result['action'] == 'refuse' else 0


if __name__ == '__main__':
    sys.exit(main())
