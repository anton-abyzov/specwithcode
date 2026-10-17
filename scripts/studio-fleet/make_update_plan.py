#!/usr/bin/env python3
"""Write a release's studio-update.json from local SHA256SUMS; optionally upload it with gh.

--upload also writes the plan's own line into that SHA256SUMS and uploads both files: the agent
and the next release's prev stage check the plan against the release's SHA256SUMS, and 1.0.38
shipped a plan uploaded on its own, which its SHA256SUMS did not list.

The plan is validated by the same policy the background update agent enforces, so a
release can never publish a plan the agent would reject (unknown args, other
entrypoints, hashes that are not in SHA256SUMS).

The source commits that may upgrade on their own come from --from-source, from
--previous-plan (the previous release's studio-update.json: its sourceCommit and every
fromSourceCommits entry it accepted), or both. scripts/release/release.sh passes the
previous plan it downloaded and checked against that release's SHA256SUMS.
"""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import uuid

import update_agent as agent


def build_plan(version, source_commit, sums, runtime, helpers, helpers_root, from_sources, args):
    for name in (runtime, helpers):
        if name not in sums:
            raise agent.AgentError('%s is not listed in SHA256SUMS' % name)
    plan = {'schemaVersion': 1, 'product': agent.PRODUCT, 'version': version, 'sourceCommit': source_commit,
            'service': {'platform': agent.PLATFORM,
                        'runtime': {'asset': runtime, 'sha256': sums[runtime]},
                        'helpers': {'asset': helpers, 'sha256': sums[helpers], 'root': helpers_root},
                        'upgrades': [{'fromSourceCommits': list(dict.fromkeys(from_sources)),
                                      'entrypoint': agent.ENTRYPOINT, 'args': list(dict.fromkeys(args))}]}}
    agent.validate_plan(plan, version)
    return plan


def previous_sources(path):
    """The previous plan's sourceCommit, then every source commit it accepted, without repeats."""
    try:
        plan = json.loads(pathlib.Path(path).read_text())
    except (OSError, ValueError):
        raise agent.AgentError('The previous plan %s is not readable JSON' % path) from None
    service = plan.get('service') if isinstance(plan, dict) else None
    upgrades = service.get('upgrades') if isinstance(service, dict) else None
    source = plan.get('sourceCommit') if isinstance(plan, dict) else None
    if not (isinstance(source, str) and agent.HEX40.fullmatch(source) and isinstance(upgrades, list)):
        raise agent.AgentError('The previous plan %s has no sourceCommit or upgrades' % path)
    sources = [source]
    for upgrade in upgrades:
        listed = upgrade.get('fromSourceCommits') if isinstance(upgrade, dict) else None
        if not (isinstance(listed, list) and all(isinstance(item, str) and agent.HEX40.fullmatch(item)
                                                 for item in listed)):
            raise agent.AgentError('The previous plan %s has an invalid fromSourceCommits list' % path)
        sources.extend(listed)
    return list(dict.fromkeys(sources))


def sums_with(data, name, digest):
    """SHA256SUMS bytes with `name` listed at `digest`: its earlier line (if any) dropped and the
    new one added at the end, every other line kept as it was."""
    agent.parse_sums(data)  # Refuses a malformed or repeating SHA256SUMS before anything is written.
    kept = []
    for line in data.decode('utf-8').splitlines():
        listed = line.rstrip('\r').split(None, 1)
        if not line.strip() or (len(listed) == 2 and listed[1].lstrip('*') in (name, './' + name)):
            continue
        kept.append(line.rstrip('\r'))
    return ('\n'.join(kept + ['%s  %s' % (digest, name)]) + '\n').encode()


def write_atomically(path, data):
    temporary = path.with_name('.' + path.name + '.tmp-' + uuid.uuid4().hex)
    try:
        temporary.write_bytes(data)
        temporary.chmod(0o644)  # Public release assets; they contain only names and hashes.
        os.replace(str(temporary), str(path))
    finally:
        if temporary.exists():
            temporary.unlink()


def default_root(helpers):
    for suffix in ('.tar.gz', '.tgz'):
        if helpers.endswith(suffix):
            return helpers[:-len(suffix)]
    return helpers


def find_gh():
    for candidate in agent.GH_PATHS + (shutil.which('gh') or '',):
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    raise agent.AgentError('gh was not found; install GitHub CLI or upload studio-update.json manually')


def normalize_argv(argv):
    """`--arg --allow-x` would look like a flag to argparse; bind it as `--arg=--allow-x`."""
    result, index = [], 0
    while index < len(argv):
        if argv[index] == '--arg' and index + 1 < len(argv):
            result.append('--arg=' + argv[index + 1])
            index += 2
        else:
            result.append(argv[index])
            index += 1
    return result


def main(argv=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser(description='Write studio-update.json for a SpecWithCode release')
    parser.add_argument('--version', required=True)
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--sha256sums', required=True, type=pathlib.Path)
    parser.add_argument('--runtime', required=True, help='runtime asset name')
    parser.add_argument('--helpers', required=True, help='deployment helpers asset name')
    parser.add_argument('--helpers-root', help='top-level folder in the helpers tarball (default: asset stem)')
    parser.add_argument('--from-source', action='append', default=[],
                        help='installed sourceCommit this release may auto-upgrade from (repeatable)')
    parser.add_argument('--previous-plan', type=pathlib.Path,
                        help="the previous release's studio-update.json; its source commits may upgrade too")
    parser.add_argument('--arg', action='append', default=[], help='helper flag: ' + ', '.join(agent.ALLOWED_ARGS))
    parser.add_argument('--output', type=pathlib.Path, default=pathlib.Path(agent.PLAN_ASSET))
    parser.add_argument('--upload', metavar='TAG',
                        help='also add the plan to --sha256sums and gh release upload both to TAG --clobber')
    parser.add_argument('--repo', default=agent.DEFAULT_REPOSITORY)
    args = parser.parse_args(normalize_argv(list(sys.argv[1:] if argv is None else argv)))
    try:
        sources = (previous_sources(args.previous_plan) if args.previous_plan else []) + args.from_source
        if not sources:
            raise agent.AgentError('Give --from-source or --previous-plan')
        sums = agent.parse_sums(args.sha256sums.read_bytes())
        plan = build_plan(args.version, args.source_commit, sums, args.runtime, args.helpers,
                          args.helpers_root or default_root(args.helpers), sources, args.arg)
        output = args.output.resolve()
        sums_path = args.sha256sums.resolve()
        if args.upload:
            if args.upload != 'v' + args.version:
                raise agent.AgentError('Upload tag must be v' + args.version)
            if output.name != agent.PLAN_ASSET:
                raise agent.AgentError('The uploaded file must be named ' + agent.PLAN_ASSET)
            if sums_path.name != 'SHA256SUMS':
                raise agent.AgentError('--upload also uploads --sha256sums, so it must be named SHA256SUMS')
            if not agent.REPOSITORY.fullmatch(args.repo):
                raise agent.AgentError('Invalid --repo')
        data = (json.dumps(plan, indent=2) + '\n').encode()
        write_atomically(output, data)
        uploaded = False
        if args.upload:
            write_atomically(sums_path, sums_with(sums_path.read_bytes(), agent.PLAN_ASSET,
                                                  hashlib.sha256(data).hexdigest()))
            result = subprocess.run([find_gh(), 'release', 'upload', args.upload, str(output), str(sums_path),
                                     '--repo', args.repo, '--clobber'], stdin=subprocess.DEVNULL,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=300)
            if result.returncode != 0:
                raise agent.AgentError('gh release upload failed; output withheld')
            uploaded = True
    except (agent.AgentError, OSError) as error:
        message = error.message if isinstance(error, agent.AgentError) else type(error).__name__
        print('make_update_plan: ' + message, file=sys.stderr)
        return 2
    print(json.dumps({'result': 'written', 'output': str(output), 'version': args.version, 'uploaded': uploaded}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
