#!/usr/bin/env python3
"""Small, testable pieces of scripts/release/release.sh that bash 3.2 does badly.

    packages ROOT                          workspace packages with a test script, minus the root
                                           and apps/server, as "dir<TAB>name" lines
    sums --dir D --out F NAME...           SHA256SUMS for NAME... in D (--append adds lines)
    verify-sums --dir D NAME...            NAME... are listed in D/SHA256SUMS and match it
    google-env check FILE                  FILE holds exactly the Google OAuth pair, mode 600
    google-env copy SOURCE FILE            copy only that pair from SOURCE into a new FILE
    previous --version V                   newest published X.Y.Z below V from `gh release list
                                           --json tagName,isDraft` on stdin
    newer A B                              exit 0 when version A is above B
    notes --repo R --to SHA --version V --out F [--base SHA]
                                           draft release notes from commit subjects
    public-notes --in F --out F [--rules F]
                                           notes with the private repository renamed and the
                                           public mirror's deny list checked
    timing record|summary|compare ...      per-stage timings and the regression table
    json-get FILE KEY / json-set FILE KEY=VALUE...

Nothing here prints a secret: google-env reports only whether the two names are present.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

SEMVER = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)')
GOOGLE_KEYS = ('STUDIO_GOOGLE_OAUTH_CLIENT_ID', 'STUDIO_GOOGLE_OAUTH_CLIENT_SECRET')
PRIVATE_REPO, PUBLIC_REPO = 'anton-abyzov/specwithcode', 'anton-abyzov/specwithcode'
# The shapes scripts/public-mirror/publish.mjs refuses (BUILT_IN_DENY), written generally so
# this file can itself be mirrored: home folders, private LAN addresses, Mac host names and
# internal increment branches.
PUBLIC_DENY = (re.compile(r'/Users/[^/\s]+/'), re.compile(r'\b192\.168\.\d+\.\d+\b'),
               re.compile(r'\b[A-Za-z]+s-MacBook', re.I), re.compile(r'\b(?:codex|claude)/\d{4}-'))
SERVER_DIR = 'apps/server'


class ToolError(Exception):
    pass


def version(text):
    match = SEMVER.fullmatch(text or '')
    return tuple(int(part) for part in match.groups()) if match else None


def write_atomic(path, data, mode=0o644):
    path = pathlib.Path(path)
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=str(path.parent))
    try:
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(data)
        os.chmod(temporary, mode)
        os.replace(temporary, str(path))
    except BaseException:
        if os.path.lexists(temporary):
            os.unlink(temporary)
        raise


# ---------------------------------------------------------------- workspace packages

def workspace_globs(root):
    """The `packages:` list of pnpm-workspace.yaml (a plain block list, as this repo writes it)."""
    globs, inside = [], False
    for line in (root / 'pnpm-workspace.yaml').read_text().splitlines():
        if re.match(r'^packages:\s*$', line):
            inside = True
            continue
        if inside:
            match = re.match(r'^\s+-\s+["\']?([^"\'#]+?)["\']?\s*$', line)
            if match:
                globs.append(match.group(1))
            elif line.strip() and not line.startswith(' '):
                break
    if not globs:
        raise ToolError('pnpm-workspace.yaml lists no packages')
    return globs


def packages(root):
    """[(dir, name)] of workspace packages with a test script, except the root and the server,
    and the server's entry, so a caller can check nothing was left out."""
    root = pathlib.Path(root).resolve()
    found = []
    for pattern in workspace_globs(root):
        if pattern.startswith('!'):
            continue
        candidates = sorted(root.glob(pattern)) if any(ch in pattern for ch in '*?[') else [root / pattern]
        for directory in candidates:
            manifest = directory / 'package.json'
            if not manifest.is_file() or 'node_modules' in directory.parts:
                continue
            data = json.loads(manifest.read_text())
            if isinstance(data.get('scripts'), dict) and data['scripts'].get('test'):
                found.append((directory.relative_to(root).as_posix(), data.get('name') or directory.name))
    found = sorted(dict.fromkeys(found))
    if SERVER_DIR not in [directory for directory, _name in found]:
        raise ToolError('%s has no test script; the server stage would test nothing' % SERVER_DIR)
    return [entry for entry in found if entry[0] != SERVER_DIR]


# ---------------------------------------------------------------- SHA256SUMS

def sha256(path):
    digest = hashlib.sha256()
    with open(str(path), 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def read_sums(path):
    sums = {}
    for line in pathlib.Path(path).read_text().splitlines():
        if not line.strip():
            continue
        match = re.fullmatch(r'([0-9a-fA-F]{64}) [ *](\S+)', line)
        if not match or match.group(2) in sums:
            raise ToolError('%s has a malformed or repeated line' % path)
        sums[match.group(2)] = match.group(1).lower()
    return sums


def write_sums(directory, out, names, append=False):
    directory = pathlib.Path(directory)
    existing = read_sums(out) if append and pathlib.Path(out).exists() else {}
    lines = ['%s  %s' % (digest, name) for name, digest in existing.items()]
    for name in names:
        if name in existing:
            raise ToolError('%s is already listed' % name)
        if '/' in name or not (directory / name).is_file():
            raise ToolError('%s is not a file in %s' % (name, directory))
        lines.append('%s  %s' % (sha256(directory / name), name))
    write_atomic(out, ('\n'.join(lines) + '\n').encode(), 0o644)


def verify_sums(directory, names):
    directory = pathlib.Path(directory)
    sums = read_sums(directory / 'SHA256SUMS')
    for name in names:
        if name not in sums:
            raise ToolError('%s is not listed in SHA256SUMS' % name)
        if sha256(directory / name) != sums[name]:
            raise ToolError('%s does not match SHA256SUMS' % name)


# ---------------------------------------------------------------- Google OAuth pair

def google_lines(path):
    pairs = {}
    for line in pathlib.Path(path).read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            continue
        key = stripped.split('=', 1)[0].replace('export ', '').strip()
        pairs.setdefault(key, []).append(stripped)
    return pairs


def google_check(path):
    path = pathlib.Path(path)
    if not path.is_file():
        raise ToolError('%s is missing' % path)
    if path.stat().st_mode & 0o077:
        raise ToolError('%s must be mode 600' % path)
    pairs = google_lines(path)
    for key in GOOGLE_KEYS:
        values = pairs.get(key, [])
        if len(values) != 1 or not values[0].split('=', 1)[1].strip().strip('"\''):
            raise ToolError('%s must set %s exactly once, non-empty' % (path, key))
    others = sorted(set(pairs) - set(GOOGLE_KEYS))
    if others:
        raise ToolError('%s holds %d other variable(s); keep only the Google OAuth pair' % (path, len(others)))


def google_copy(source, target):
    target = pathlib.Path(target)
    if target.exists():
        raise ToolError('%s already exists' % target)
    pairs = google_lines(source)
    lines = []
    for key in GOOGLE_KEYS:
        if len(pairs.get(key, [])) != 1:
            raise ToolError('%s does not set %s exactly once' % (source, key))
        lines.append(pairs[key][0].replace('export ', '', 1))
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    write_atomic(target, ('\n'.join(lines) + '\n').encode(), 0o600)


# ---------------------------------------------------------------- release notes

def notes(repo, to, release, base=None):
    lines = ['## SpecWithCode %s' % release, '']
    if base:
        log = subprocess.run(['git', '-C', str(repo), 'log', '--no-merges', '--format=%s', '%s..%s' % (base, to)],
                             capture_output=True, text=True, env=dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull))
        subjects = log.stdout.splitlines() if log.returncode == 0 else []
        if log.returncode != 0:
            lines.append('<!-- %s is not in this history; write the notes by hand. -->' % base[:12])
    else:
        subjects = []
    for subject in subjects:
        if subject.startswith('Prepare SpecWithCode ') or not subject.strip():
            continue
        lines.append('- ' + re.sub(r'\s*\(#\d+\)$', '', subject.strip()))
    lines += ['', '<!-- Draft from commit subjects. Rewrite for people who use the app, then rerun',
              '     release.sh --resume; the published release takes this file as it is then. -->']
    return '\n'.join(lines) + '\n'


def public_notes(text, rules=None):
    replacements = [(PRIVATE_REPO, PUBLIC_REPO), ('anton-abyzov/specwithcode', PUBLIC_REPO)]
    deny = []
    if rules and pathlib.Path(rules).is_file():
        data = json.loads(pathlib.Path(rules).read_text())
        replacements = list(data.get('replace') or []) + replacements
        deny = [value.lower() for value in data.get('deny') or [] if value]
    for old, new in replacements:
        text = re.sub(re.escape(old), new, text, flags=re.I)
    lower = text.lower()
    leaks = sum(1 for value in deny + [old.lower() for old, _new in replacements] if value and value in lower)
    leaks += sum(1 for pattern in PUBLIC_DENY if pattern.search(text))
    if leaks:
        raise ToolError('The public notes still hold %d private value(s); edit notes.md' % leaks)
    return text


# ---------------------------------------------------------------- timings

def timing_record(path, stage, start, end, status, sha, attempt):
    entry = {'stage': stage, 'start': int(start), 'end': int(end), 'seconds': int(end) - int(start),
             'status': status, 'sha': sha, 'attempt': int(attempt)}
    with open(str(path), 'a') as handle:  # One short line per write: appends do not interleave.
        handle.write(json.dumps(entry, sort_keys=True) + '\n')


def timing_attempts(path, stage):
    """The attempt number the next run of `stage` gets: one more than the runs recorded."""
    count = 0
    if pathlib.Path(path).exists():
        for line in pathlib.Path(path).read_text().splitlines():
            if line.strip() and json.loads(line).get('stage') == stage:
                count += 1
    return count + 1


def timing_summary(path, release):
    entries = []
    if pathlib.Path(path).exists():
        for line in pathlib.Path(path).read_text().splitlines():
            if line.strip():
                entries.append(json.loads(line))
    stages, order = {}, []
    for entry in entries:
        name = entry['stage']
        if name not in stages:
            order.append(name)
            stages[name] = {'stage': name, 'seconds': None, 'status': None, 'attempts': 0, 'totalSeconds': 0}
        record = stages[name]
        record['attempts'] += 1
        record['totalSeconds'] += entry['seconds']
        record['status'] = entry['status']
        if entry['status'] == 'ok':
            record['seconds'] = entry['seconds']
    wall = (max(e['end'] for e in entries) - min(e['start'] for e in entries)) if entries else 0
    return {'schemaVersion': 1, 'version': release, 'wallSeconds': wall, 'stages': [stages[name] for name in order]}


def timing_compare(current, previous, threshold=25.0, minimum=10):
    """Lines of the stage table and the names of stages slower than the threshold (and by at
    least `minimum` seconds, so a 2s stage taking 3s is not a regression)."""
    before = {stage['stage']: stage for stage in (previous or {}).get('stages', [])}
    title = 'Stage timings for %s, compared with %s' % (
        current.get('version'), previous.get('version') if previous else 'nothing (no previous stages.json)')
    row = '%-16s %8s %9s %8s  %s'
    lines = [title, row % ('STAGE', 'SECONDS', 'PREVIOUS', 'CHANGE', '')]
    slower = []
    for stage in current.get('stages', []):
        now = stage.get('seconds')
        then = before.get(stage['stage'], {}).get('seconds')
        change, notes = '', []
        if now is not None and then:
            percent = 100.0 * (now - then) / then
            change = '%+.0f%%' % percent
            if percent > threshold and now - then >= minimum:
                notes.append('SLOWER')
                slower.append(stage['stage'])
        if stage.get('status') != 'ok':
            notes.append(stage.get('status') or 'not run')
        if stage.get('attempts', 1) > 1:
            notes.append('%d attempts, %ds in all' % (stage['attempts'], stage['totalSeconds']))
        lines.append((row % (stage['stage'], '-' if now is None else now, '-' if then is None else then, change,
                             ', '.join(notes))).rstrip())
    lines.append((row % ('wall clock', current.get('wallSeconds', 0),
                         previous.get('wallSeconds', '-') if previous else '-', '', '')).rstrip())
    return lines, slower


# ---------------------------------------------------------------- command line

def main(argv=None):
    parser = argparse.ArgumentParser(prog='release_tools.py')
    commands = parser.add_subparsers(dest='command', required=True)
    command = commands.add_parser('packages')
    command.add_argument('root')
    command = commands.add_parser('sums')
    command.add_argument('--dir', required=True)
    command.add_argument('--out', required=True)
    command.add_argument('--append', action='store_true')
    command.add_argument('names', nargs='+')
    command = commands.add_parser('verify-sums')
    command.add_argument('--dir', required=True)
    command.add_argument('names', nargs='+')
    command = commands.add_parser('google-env')
    command.add_argument('action', choices=('check', 'copy'))
    command.add_argument('paths', nargs='+')
    command = commands.add_parser('previous')
    command.add_argument('--version', required=True)
    command = commands.add_parser('newer')
    command.add_argument('first')
    command.add_argument('second')
    command = commands.add_parser('notes')
    command.add_argument('--repo', required=True)
    command.add_argument('--to', required=True)
    command.add_argument('--version', required=True)
    command.add_argument('--out', required=True)
    command.add_argument('--base')
    command = commands.add_parser('public-notes')
    command.add_argument('--in', dest='source', required=True)
    command.add_argument('--out', required=True)
    command.add_argument('--rules')
    command = commands.add_parser('timing')
    command.add_argument('action', choices=('record', 'attempts', 'summary', 'compare'))
    command.add_argument('--file')
    command.add_argument('--out')
    command.add_argument('--stage')
    command.add_argument('--start', type=int)
    command.add_argument('--end', type=int)
    command.add_argument('--status')
    command.add_argument('--sha', default='')
    command.add_argument('--attempt', type=int, default=1)
    command.add_argument('--version')
    command.add_argument('--current')
    command.add_argument('--previous')
    command.add_argument('--threshold', type=float, default=25.0)
    command.add_argument('--min-seconds', type=int, default=10)
    command = commands.add_parser('json-get')
    command.add_argument('file')
    command.add_argument('key')
    command = commands.add_parser('json-set')
    command.add_argument('file')
    command.add_argument('pairs', nargs='+')
    args = parser.parse_args(argv)
    try:
        if args.command == 'packages':
            for directory, name in packages(args.root):
                print('%s\t%s' % (directory, name))
        elif args.command == 'sums':
            write_sums(args.dir, args.out, args.names, args.append)
        elif args.command == 'verify-sums':
            verify_sums(args.dir, args.names)
        elif args.command == 'google-env':
            if args.action == 'check' and len(args.paths) == 1:
                google_check(args.paths[0])
            elif args.action == 'copy' and len(args.paths) == 2:
                google_copy(*args.paths)
                google_check(args.paths[1])
            else:
                parser.error('google-env check FILE | google-env copy SOURCE FILE')
        elif args.command == 'previous':
            wanted = version(args.version)
            if wanted is None:
                raise ToolError('Invalid version %s' % args.version)
            published = [version(item.get('tagName', '')[1:]) for item in json.load(sys.stdin)
                         if isinstance(item, dict) and not item.get('isDraft') and str(item.get('tagName', '')).startswith('v')]
            below = sorted(item for item in published if item is not None and item < wanted)
            if not below:
                raise ToolError('No published release below %s' % args.version)
            print('%d.%d.%d' % below[-1])
        elif args.command == 'newer':
            first, second = version(args.first), version(args.second)
            if first is None or second is None:
                raise ToolError('Invalid version')
            return 0 if first > second else 1
        elif args.command == 'notes':
            write_atomic(args.out, notes(args.repo, args.to, args.version, args.base).encode(), 0o644)
        elif args.command == 'public-notes':
            write_atomic(args.out, public_notes(pathlib.Path(args.source).read_text(), args.rules).encode(), 0o644)
        elif args.command == 'timing':
            if args.action == 'record':
                timing_record(args.file, args.stage, args.start, args.end, args.status, args.sha, args.attempt)
            elif args.action == 'attempts':
                print(timing_attempts(args.file, args.stage))
            elif args.action == 'summary':
                summary = timing_summary(args.file, args.version)
                write_atomic(args.out, (json.dumps(summary, indent=2) + '\n').encode(), 0o644)
            else:
                current = json.loads(pathlib.Path(args.current).read_text())
                previous = json.loads(pathlib.Path(args.previous).read_text()) \
                    if args.previous and pathlib.Path(args.previous).is_file() else None
                lines, slower = timing_compare(current, previous, args.threshold, args.min_seconds)
                print('\n'.join(lines))
                if slower:
                    print('Slower than the previous release by more than %d%%: %s' % (args.threshold, ', '.join(slower)))
        elif args.command == 'json-get':
            value = json.loads(pathlib.Path(args.file).read_text()).get(args.key)
            if value is None:
                return 1
            print(value)
        elif args.command == 'json-set':
            path = pathlib.Path(args.file)
            data = json.loads(path.read_text()) if path.exists() else {}
            for pair in args.pairs:
                key, _, value = pair.partition('=')
                data[key] = value
            write_atomic(path, (json.dumps(data, indent=2, sort_keys=True) + '\n').encode(), 0o644)
    except (ToolError, OSError, ValueError, KeyError) as error:
        print('release_tools: %s' % error, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
