"""The desktop app on M1 and M3: fleet_rollout updates it once it has confirmed that worker's service on
the version (DesktopApps), over the same pinned fleet ssh as the service request.

The worker runs desktop_app_update_remote.sh, streamed to `/bin/bash -s` with the version, the zip's
expected sha256 and the public mirror in a preamble. It downloads SpecWithCode-<v>-arm64.zip from the
mirror's release (publish-public runs before fleet-workers) and installs it in release.sh's desktop-stage
order: ShipIt first, else unpacked and checked beside the app, then renamed in, the previous app to the
Trash; it reopens the app only when it was running.

The expected sha256 is the zip's line in the release's SHA256SUMS, found the way release.sh's desktop stage
finds its zip: in this Mac's staging folder for the version, the assets of the candidate it published
(<RELEASE_STAGING_ROOT>/<v>/published.sha, assets-<sha12>/SHA256SUMS; the file publish-private and
publish-public checked byte for byte against both releases). A rollout run on its own for a release with no
staging folder here (a --ci release, or one pruned) reads SHA256SUMS from the public release instead.

The version, sha256 and repository are checked here before any of them reaches a shell (digits and dots,
64 hex digits, owner/name) and checked again by the remote script.
"""
import os
import pathlib
import re
import shlex
import subprocess
import threading
import urllib.error
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
REMOTE_SCRIPT = HERE / 'desktop_app_update_remote.sh'
REMOTE_COMMAND = '/bin/bash -s'
VERSION = re.compile(r'(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})')
HEX64 = re.compile(r'[0-9a-f]{64}')
HEX40 = re.compile(r'[0-9a-f]{40}')
REPOSITORY = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}')
SUMS_LINE = re.compile(r'([0-9a-fA-F]{64}) [ *](\S+)')
PUBLIC_REPO = 'anton-abyzov/specwithcode'  # release.sh's PUBLIC_REPO; RELEASE_PUBLIC_REPO overrides both.
STAGING_ROOT = '~/.specwithcode/release-staging'  # release.sh's; RELEASE_STAGING_ROOT overrides both.
SUMS_LIMIT = 256 << 10
HTTP_TIMEOUT = 60
TIMEOUT = 30 * 60  # Download, quit, ShipIt, unpack and two signature checks; minutes in practice.
HOWS = ('already-current', 'updater-on-quit', 'swapped', 'dry-run')
SAID = {'already-current': 'already on %(after)s',
        'updater-on-quit': '%(before)s -> %(after)s: its own updater installed it as the app quit',
        'swapped': '%(before)s -> %(after)s: unpacked and checked beside the app, then swapped in',
        'dry-run': 'dry run on %(before)s; nothing changed'}


class DesktopAppError(Exception):
    pass


def zip_name(version):
    return 'SpecWithCode-%s-arm64.zip' % version


def checked_version(version):
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise DesktopAppError('the version must be X.Y.Z, digits and dots only: %r' % (version,))
    return version


def checked_repo(repo):
    if not isinstance(repo, str) or not REPOSITORY.fullmatch(repo) or '..' in repo:
        raise DesktopAppError('the public repository must be owner/name: %r' % (repo,))
    return repo


def public_repo():
    return checked_repo(os.environ.get('RELEASE_PUBLIC_REPO') or PUBLIC_REPO)


def parse_sums(data, source):
    """{name: sha256} from SHA256SUMS bytes, refused as the update agent refuses them
    (update_agent.parse_sums): a malformed line or a file listed twice."""
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        raise DesktopAppError('%s is not UTF-8' % source) from None
    sums = {}
    for line in text.splitlines():
        line = line.rstrip('\r')
        if not line.strip():
            continue
        match = SUMS_LINE.fullmatch(line)
        if not match:
            raise DesktopAppError('%s has a malformed line' % source)
        name = match.group(2)[2:] if match.group(2).startswith('./') else match.group(2)
        if name in sums:
            raise DesktopAppError('%s lists %s twice' % (source, name))
        sums[name] = match.group(1).lower()
    return sums


def staging_root():
    return pathlib.Path(os.path.expanduser(os.environ.get('RELEASE_STAGING_ROOT') or STAGING_ROOT))


def staged_sums_path(version, root=None):
    """The SHA256SUMS release.sh built and published for `version`, when its staging folder is on this Mac."""
    stage = pathlib.Path(root) if root is not None else staging_root()
    stage = stage / version
    try:
        published = (stage / 'published.sha').read_text().strip()
    except (OSError, UnicodeDecodeError):
        return None
    if not HEX40.fullmatch(published):
        return None
    path = stage / ('assets-' + published[:12]) / 'SHA256SUMS'
    return path if path.is_file() else None


def sums_url(version, repo):
    return 'https://github.com/%s/releases/download/v%s/SHA256SUMS' % (repo, version)


class _HttpsOnly(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.startswith('https://'):
            raise DesktopAppError('GitHub redirected SHA256SUMS to a location that is not https')
        return urllib.request.HTTPRedirectHandler.redirect_request(self, req, fp, code, msg, headers, newurl)


def fetch_url(url):
    """The bytes at `url` (https only, redirects too), at most SUMS_LIMIT + 1 of them."""
    opener = urllib.request.build_opener(_HttpsOnly())
    request = urllib.request.Request(url, headers={'User-Agent': 'specwithcode-fleet-rollout'})
    with opener.open(request, timeout=HTTP_TIMEOUT) as response:
        return response.read(SUMS_LIMIT + 1)


def expected_sha256(version, repo, root=None, fetch=fetch_url):
    """(sha256 of SpecWithCode-<v>-arm64.zip, where it was read): this Mac's staging folder for the
    version first, else the public release's SHA256SUMS."""
    version, repo = checked_version(version), checked_repo(repo)
    path = staged_sums_path(version, root)
    if path is not None:
        try:
            data, source = path.read_bytes(), str(path)
        except OSError as error:
            raise DesktopAppError('could not read %s (%s)' % (path, type(error).__name__)) from None
    else:
        source = sums_url(version, repo)
        try:
            data = fetch(source)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                raise DesktopAppError('v%s has no SHA256SUMS on %s (%s); is it published there? The workers download '
                                      'the app from it' % (version, repo, source)) from None
            raise DesktopAppError('could not download %s (HTTP %d)' % (source, error.code)) from None
        except DesktopAppError:
            raise
        except (urllib.error.URLError, OSError, ValueError) as error:
            raise DesktopAppError('could not download %s (%s)' % (source, type(error).__name__)) from None
        if len(data) > SUMS_LIMIT:
            raise DesktopAppError('%s is larger than %d KiB' % (source, SUMS_LIMIT >> 10))
    sha = parse_sums(data, source).get(zip_name(version))
    if not sha:
        raise DesktopAppError('%s does not list %s' % (source, zip_name(version)))
    return sha, source


def parse_result(line):
    """The fields of the remote script's last 'RESULT key=value ...' line."""
    fields = {}
    for part in line.split()[1:]:
        key, sep, value = part.partition('=')
        if sep:
            fields[key] = value
    return fields


class DesktopApps(object):
    """fleet_rollout's desktop step. `commands` maps each worker to the argv that runs `/bin/bash -s`
    there (fleet_rollout.ssh_command with REMOTE_COMMAND). Calling it with (identity, say) updates that
    worker's app to `version` and returns {'result', 'before', 'after', 'relaunched'}; it raises
    DesktopAppError naming the reason. Tests pass `sums` (a resolver), `env` and `timeout`."""

    def __init__(self, version, commands, repo=None, sums=None, dry_run=False, timeout=TIMEOUT, env=None,
                 script=REMOTE_SCRIPT):
        self.version = checked_version(version)
        self.repo = checked_repo(repo) if repo is not None else public_repo()
        self.commands = {identity: list(command) for identity, command in commands.items()}
        self.resolve = sums or (lambda: expected_sha256(self.version, self.repo))
        self.dry_run = bool(dry_run)
        self.timeout = timeout
        self.env = env
        self.script = pathlib.Path(script)
        self.lock = threading.Lock()
        self.found = None  # (sha256, source) once resolved; both workers use the one answer.
        self.failure = None

    def plan(self):
        """What a dry run of fleet_rollout prints: where the sha256 comes from and each command."""
        staged = staged_sums_path(self.version)
        return {'sums': str(staged) if staged else sums_url(self.version, self.repo),
                'commands': dict(self.commands)}

    def expected(self, say):
        with self.lock:
            if self.found is None and self.failure is None:
                try:
                    sha, source = self.resolve()
                    if not isinstance(sha, str) or not HEX64.fullmatch(sha):
                        raise DesktopAppError('%s gives no sha256 for %s' % (source, zip_name(self.version)))
                    self.found = (sha, source)
                    say('desktop apps: %s %s from %s' % (zip_name(self.version), sha[:12], source))
                except DesktopAppError as error:
                    self.failure = str(error)
            if self.failure is not None:
                raise DesktopAppError(self.failure)
            return self.found[0]

    def program(self, sha):
        """The preamble (each value checked above, quoted all the same) and the remote script."""
        if not HEX64.fullmatch(sha):
            raise DesktopAppError('the expected sha256 must be 64 hex digits')
        preamble = ''.join('%s=%s\n' % (name, shlex.quote(value)) for name, value in (
            ('V', checked_version(self.version)), ('SHA', sha), ('REPO', checked_repo(self.repo)),
            ('DRY_RUN', '1' if self.dry_run else '0')))
        return preamble + self.script.read_text()

    def __call__(self, identity, say):
        command = self.commands.get(identity)
        if not command:
            raise DesktopAppError('no ssh command for %s in the fleet inventory' % identity)
        program = self.program(self.expected(say))
        code, lines, timed_out = self.run(command, program, lambda line: say('%s: app: %s' % (identity, line)))
        if timed_out:
            limit = '%d min' % (self.timeout // 60) if self.timeout >= 60 else '%d s' % self.timeout
            raise DesktopAppError('did not finish within %s, so its ssh session was stopped; a run cut short '
                                  'is repaired by the next one' % limit)
        last = [line for line in lines if line.startswith('RESULT ') or line.startswith('FAIL ')]
        if code == 0 and last and last[-1].startswith('RESULT '):
            fields = parse_result(last[-1])
            how, before, after = fields.get('how'), fields.get('before'), fields.get('after')
            expected_after = before if how == 'dry-run' else self.version
            if how not in HOWS or after != expected_after:
                raise DesktopAppError('gave an unexpected answer: %s' % last[-1])
            result = {'result': how, 'before': before, 'after': after, 'relaunched': fields.get('relaunched')}
            line = SAID[how] % result
            if result['relaunched'] == 'yes':
                line += '; reopened, as it was running'
            elif result['relaunched'] == 'failed':
                line += '; WARNING: it was running and could not be opened again'
            say('%s: desktop app %s' % (identity, line))
            return result
        if last and last[-1].startswith('FAIL '):
            raise DesktopAppError(last[-1][len('FAIL '):])
        tail = lines[-1] if lines else 'no output'
        if code == 255:
            raise DesktopAppError('could not be reached over ssh: %s' % tail)
        raise DesktopAppError('exit %d: %s' % (code, tail))

    def run(self, command, program, emit):
        """Runs `command` with `program` on stdin, emitting each output line; stops the process it started
        (by its own pid) after self.timeout. Returns (exit code, lines, timed out)."""
        try:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, env=self.env)
        except OSError as error:
            raise DesktopAppError('could not start %s (%s)' % (command[0], type(error).__name__)) from None
        stopped = threading.Event()

        def stop():
            stopped.set()
            process.kill()

        def feed():
            try:
                process.stdin.write(program.encode())
                process.stdin.close()
            except OSError:
                pass  # The host hung up; the exit code and output say why.

        timer = threading.Timer(self.timeout, stop)
        timer.daemon = True
        writer = threading.Thread(target=feed, daemon=True)
        lines = []
        timer.start()
        writer.start()
        try:
            for raw in process.stdout:
                line = raw.decode('utf-8', 'replace').rstrip('\r\n')
                lines.append(line)
                emit(line)
            process.wait()
        finally:
            timer.cancel()
            if process.poll() is None:
                process.kill()
                process.wait()
            writer.join(5)
            process.stdout.close()
        return process.returncode, lines, stopped.is_set()
