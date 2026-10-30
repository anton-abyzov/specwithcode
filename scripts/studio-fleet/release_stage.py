#!/usr/bin/env python3
"""Unpacking a verified runtime archive into the release store, during the apply or ahead of it.

update.py's apply unpacks the archive with the release's own install.py in a private staging home
and publishes it at install/releases/<sha20> (update.publish_release): 5.6-7.0 s of every Restart to
update on M4 (receipts 1.0.119-1.0.126, verifyAndStage). The update agent now has the verified
helper do the same right after it downloads a release (`update.py --stage-release`, stage_ahead),
while nothing waits on it, and records what it published in <identity>/updates/staged-release.json
(RECORD_FILE). An apply of that archive then skips install.py when the published release's manifest
is still the one recorded (staged); it still checks every byte of it (release_verified) before any
pointer can name it, as publish_release does for a release a retry reuses. A published release is
inert until the pointers name it, and release_retention keeps the one a record names.

Stdlib only; shipped in the helpers archive beside update.py.
"""
import contextlib
import datetime
import hashlib
import json
import os
import pathlib
import shutil
import socket
import sys
import tempfile
import time
import uuid

from installation_descriptor import installation_lock, owned_path
from release_check import release_manifest
from release_policy import validate_upgrade
from release_retention import RELEASE_NAME, referenced_releases
import studio_paths

RECORD_FILE = 'staged-release.json'
INSTALLER = pathlib.Path(__file__).with_name('install.py')
# A liveness bound, as update.STAGE_TIMEOUT_SECONDS: nothing waits on a staging done ahead.
AHEAD_TIMEOUT_SECONDS = 600


@contextlib.contextmanager
def scratch_directory(prefix, parent):
    """tempfile.TemporaryDirectory whose cleanup never fails an update. Finder can write .DS_Store
    into a folder while it is removed (ENOTEMPTY failed a 1.0.112 install after the release was
    published); prune_update_leftovers removes whatever is left on the next verified update."""
    path = tempfile.mkdtemp(prefix=prefix, dir=str(parent))
    try:
        yield path
    finally:
        for attempt in range(3):
            try:
                shutil.rmtree(path)
                break
            except FileNotFoundError:
                break
            except OSError as error:
                if attempt == 2:
                    print(f'Left {path} for the next prune: {error}', file=sys.stderr)
                else:
                    time.sleep(0.2)


def stage_release(archive, archive_sha, node, destination, incoming, *, run, timeout, check, publish):
    """Unpacks `archive` with install.py in a new private staging home under `incoming`, never a
    live home, passes the staged version to `check` (the version gate, which reads only manifests),
    then publishes it at `destination` (publish: update.publish_release, which verifies every staged
    byte) and returns its manifest. `timeout()` bounds install.py; subprocess.TimeoutExpired passes."""
    with scratch_directory('owned-update-stage-', incoming) as temporary:
        stage_home = pathlib.Path(temporary)
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0)); stage_port = probe.getsockname()[1]
        value = run(['/usr/bin/python3', str(INSTALLER), '--archive', str(archive), '--sha256', archive_sha,
                     '--node', node, '--identity', 'stage', '--port', str(stage_port)],
                    timeout=timeout(), env={'HOME': str(stage_home), 'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8'}, text=True)
        staged_release = pathlib.Path(json.loads(value)['release'])
        upgrade = release_manifest(staged_release)['version']
        check(upgrade)
        # A retry reuses a published release (publish_release), so the prestate is checked once, before pointers.
        manifest = publish(staged_release, destination)
        assert manifest['version'] == upgrade, 'The staged release changed while it was published'
    return manifest


def _digest(path):
    with open(str(path), 'rb') as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def record_path(own, home):
    return owned_path(pathlib.Path(own) / 'updates' / RECORD_FILE, home)


def staged(own, home, archive_sha, destination):
    """True when stage_ahead published this very archive at `destination` and the manifest there is
    still the one it published. Never raises: any doubt stages again."""
    try:
        record = json.loads(record_path(own, home).read_text())
        destination = pathlib.Path(destination)
        return (isinstance(record, dict) and record.get('schemaVersion') == 1
                and record.get('archiveSha256') == archive_sha and record.get('release') == str(destination)
                and destination.is_dir() and not destination.is_symlink()
                and record.get('manifestSha256') == _digest(destination / 'studio-manifest.json'))
    except Exception:
        return False


def forget(own, home, archive_sha):
    """Removes the record once the release it names, that of `archive_sha`, is installed. Never raises."""
    with contextlib.suppress(Exception):
        path = record_path(own, home)
        if json.loads(path.read_text()).get('archiveSha256') == archive_sha:
            path.unlink()


def _write_record(path, value):
    temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex)
    try:
        temporary.write_text(json.dumps(value, indent=2) + '\n')
        temporary.chmod(0o600)
        os.replace(str(temporary), str(path))
    finally:
        if temporary.exists():
            temporary.unlink()


def _superseded(home, release, keep):
    """Removes `release`, which the record named before this staging replaced it, unless it is in
    `keep` or any identity's launcher, receipt or staged record names it. Each staging unpacks about
    340 MB and prune_releases runs only after a verified apply, so a Mac whose install never sees
    quiet would keep every release it skipped. Never raises."""
    with contextlib.suppress(Exception):
        path = pathlib.Path(release)
        root = studio_paths.releases_root(home)
        if (path.parent != root or not RELEASE_NAME.fullmatch(path.name) or path.is_symlink()
                or not path.is_dir() or path.name in {pathlib.Path(item).name for item in keep}
                or path.name in referenced_releases(home)):
            return
        shutil.rmtree(str(owned_path(path, home)))


def stage_ahead(own, home, archive, archive_sha, *, run, publish):
    """`update.py --stage-release`: publish the downloaded `archive` as an apply would, under the
    installation lock (which never waits: an apply under way refuses this, never the other way),
    and record it. Nothing a service runs changes; returns the record. The release an older record
    named goes once nothing else names it (_superseded)."""
    assert len(archive_sha) == 64 and hashlib.sha256(pathlib.Path(archive).read_bytes()).hexdigest() == archive_sha, \
        'Archive hash mismatch'
    with installation_lock(home):
        receipt = json.loads(owned_path(pathlib.Path(own) / 'installation.json', home).read_text())
        installed = release_manifest(pathlib.Path(receipt['release']))['version']
        destination = owned_path(studio_paths.releases_root(home) / archive_sha[:20], home)
        incoming = owned_path(studio_paths.incoming_root(home), home)
        incoming.mkdir(parents=True, exist_ok=True)
        manifest = stage_release(archive, archive_sha, receipt['node'], destination, incoming, run=run,
                                 timeout=lambda: AHEAD_TIMEOUT_SECONDS,
                                 check=lambda version: validate_upgrade(installed, version), publish=publish)
        record = {'schemaVersion': 1, 'archiveSha256': archive_sha, 'release': str(destination),
                  'version': manifest['version'], 'manifestSha256': _digest(destination / 'studio-manifest.json'),
                  'stagedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        path = record_path(own, home)
        try:
            superseded = json.loads(path.read_text()).get('release')
        except Exception:
            superseded = None
        path.parent.mkdir(mode=0o700, exist_ok=True)
        _write_record(path, record)
        if isinstance(superseded, str) and superseded != str(destination):
            _superseded(home, superseded, [destination, receipt['release']])
    return record
