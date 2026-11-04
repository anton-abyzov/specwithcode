#!/usr/bin/env python3
"""The disk an update of one host needs, measured before anything stops (`update.py room`, and
scripts/release/preflight_fleet.py before a release builds anything).

An update takes, on the volume of the host's state database:
  - fallback: the full read a pending FULL_READ migration forces after the restart (the page
    proof refuses it, additive_migrations.FULL_READ). It hashes one table at a time through sorted
    runs on the database's volume, so its peak is FULL_READ_LINE_FACTOR times the largest table's
    bytes (largest_table_bytes, an estimate from the b-tree pages, without reading the tables)
    plus kept_lines.DISK_FLOOR_MARGIN. 0 when the release has no FULL_READ migration above the
    live database's newest effect_sql_migrations row (update_apply.fallback_room asks the same
    before the service stops). Runs that cannot spill (no scratch folder on the database's volume)
    need that memory instead (fallbackMemoryBytes).
  - backup: the pre-update copy and its margin (state_backup.backup_space_needed: a clone's
    headroom where the backups folder can clone, else a full copy).
  - staged: the release unpacked beside the installed one. 0 once a release of that version is in
    the release store; STAGE_UNPACK_FACTOR times the archive the update agent downloaded for it;
    else STAGED_RELEASE_BYTES.
M4's 1.0.180 to 1.0.184 update (22 GB database, orchestration_events 11.5 GB, 12-18 GB free) ran
out of scratch 374 s after the service stopped (`SpillFailed ... Scratch volume is below its
floor`); this report names that shortfall before a release is built.

Imports only stdlib modules and studio_paths, live_database, installation_descriptor,
state_backup, additive_migrations and kept_lines (themselves stdlib only), so
preflight_fleet.py streams exactly these sources to a host's /usr/bin/python3 the way
fleet_rollout.py streams update_request.py: update.py itself imports most of this folder.

    python3 -B disk_room.py --identity m1 --version 1.0.188 --json
    python3 -B update.py room --version 1.0.188 --json

Prints one JSON object (or one line without --json). Exit 0 when the host has room, 1 when it is
short, 2 when it cannot tell (no such identity, no database).
"""
import argparse
import contextlib
import json
import os
import pathlib
import random
import re
import sqlite3
import struct
import sys
import urllib.parse

import additive_migrations
import kept_lines
import state_backup
import studio_paths

# Bytes of sorted runs (typed and legacy lines, each about the row's text, JSON-escaped) per byte
# of the table's b-tree: M4's orchestration_events, 20 GB of lines for 11.5 GB (1.74); JSON event
# payloads in test-update-page-mode.py, 2.0. An estimate, not a bound (BLOBs are hex).
FULL_READ_LINE_FACTOR = 2.25
TREE_DEPTH_LIMIT = 40
OVERFLOW_SAMPLE = 1024  # Leaves of one table read for its overflow pages.
# A release not yet on the host: unpacked, about 340 MB (release_retention keeps two), its archive
# about 120 MB, and install.py unpacks into incoming/ before the rename. 1 GiB covers both.
STAGED_RELEASE_BYTES = 1 << 30
STAGE_UNPACK_FACTOR = 3  # Unpacked release bytes per byte of its downloaded archive.
MODULES = ('studio_paths', 'live_database', 'installation_descriptor', 'state_backup', 'additive_migrations',
           'kept_lines', 'disk_room')
IDENTITY = re.compile(r'[a-z][a-z0-9_-]{0,31}')
VERSION = re.compile(r'(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})')
ROOTS = "SELECT type, rootpage FROM sqlite_master WHERE type IN ('table', 'index') AND rootpage > 0"


class RoomError(Exception):
    """The report cannot be made: no such identity or no state database."""


def _varint(data, offset):
    value = 0
    for index in range(9):
        byte = data[offset + index]
        if index == 8:
            return (value << 8) | byte, offset + 9
        value = (value << 7) | (byte & 0x7f)
        if byte < 0x80:
            return value, offset + index + 1
    raise ValueError('varint')


class Pages:
    """Pages of the main file of a SQLite database, read with pread; ValueError on anything that
    is not a well-formed b-tree page."""
    def __init__(self, fd, size):
        header = os.pread(fd, 100, 0)
        if len(header) != 100 or header[:16] != b'SQLite format 3\0':
            raise ValueError('header')
        page_size = struct.unpack_from('>H', header, 16)[0]
        self.fd, self.page_size = fd, 65536 if page_size == 1 else page_size
        self.usable = self.page_size - header[20]
        self.count, self.free = size // self.page_size, struct.unpack_from('>I', header, 36)[0]

    def read(self, number):
        if not 1 <= number <= self.count:
            raise ValueError('page-outside-database')
        data = os.pread(self.fd, self.page_size, (number - 1) * self.page_size)
        if len(data) != self.page_size:
            raise ValueError('short-read')
        offset = 100 if number == 1 else 0
        if data[offset] not in (2, 5, 10, 13):
            raise ValueError('not-a-tree-page')
        return data, offset, data[offset]

    def children(self, number):
        """The child pages of interior page `number`, or None for a leaf."""
        data, offset, kind = self.read(number)
        if kind in (10, 13):
            return None
        count = struct.unpack_from('>H', data, offset + 3)[0]
        return [struct.unpack_from('>I', data, struct.unpack_from('>H', data, offset + 12 + 2 * index)[0])[0]
                for index in range(count)] + [struct.unpack_from('>I', data, offset + 8)[0]]

    def tree(self, root):
        """(pages, leaves) of the b-tree at `root` (interior and leaf pages, not overflow), from its
        interior pages and one child of each: every child of an interior page sits at one depth."""
        level, seen, total = [root], {root}, 1
        if self.children(root) is None:
            return total, [root]
        for _ in range(TREE_DEPTH_LIMIT):
            children = [child for number in level for child in self.children(number)]
            if len(set(children)) != len(children) or seen.intersection(children):
                raise ValueError('page-owned-twice')
            seen.update(children)
            total += len(children)
            if self.children(children[0]) is None:  # Leaves: counted, not read.
                return total, children
            level = children
        raise ValueError('tree-depth')

    def overflow(self, number):
        """Overflow pages the cells of leaf `number` own, from their payload sizes alone (a rowid
        table's leaf, or a WITHOUT ROWID table's, which is an index b-tree)."""
        data, offset, kind = self.read(number)
        if kind not in (10, 13):
            raise ValueError('not-a-leaf')
        usable, total = self.usable, 0
        most, least = (usable - 35) if kind == 13 else (usable - 12) * 64 // 255 - 23, (usable - 12) * 32 // 255 - 23
        for index in range(struct.unpack_from('>H', data, offset + 3)[0]):
            payload = _varint(data, struct.unpack_from('>H', data, offset + 8 + 2 * index)[0])[0]
            if payload > most:
                local = least + (payload - least) % (usable - 4)
                local = local if local <= most else least
                total += -(-(payload - local) // (usable - 4))
        return total


@contextlib.contextmanager
def read_only(database):
    """A read-only connection to `database` (the probe's own; update.py reads through
    read_cache.Snapshot while the service runs). It never writes, checkpoints or truncates the -wal.
    With no -wal (a stopped service, whose last close folded and removed it) it opens the file as
    immutable, so it leaves no -wal or -shm of its own behind either."""
    path = pathlib.Path(database).resolve()
    immutable = not os.path.exists(str(path) + '-wal')
    db = sqlite3.connect('file:' + urllib.parse.quote(str(path), safe='/') + '?mode=ro' + ('&immutable=1' if immutable else ''),
                         uri=True)
    try:
        yield db
    finally:
        db.close()


def largest_table_bytes(database, schema=read_only):
    """An estimate, without reading the tables, of the largest table's bytes in the live
    `database`: see update_apply.largest_table_bytes, which reads its schema through `schema` (a
    context manager yielding a connection, held open during the walk). The whole file plus its
    -wal when the walk cannot tell."""
    size = os.stat(str(database)).st_size
    try:
        size_wal = os.stat(str(database) + '-wal').st_size
    except OSError:
        size_wal = 0
    pages = None
    try:
        with schema(database) as db:
            roots = list(db.execute(ROOTS))
            with open(str(database), 'rb') as handle:
                pages = Pages(handle.fileno(), size)
                sample = random.Random(size)
                walked, tables = 0, []
                for kind, root in [('schema', 1)] + roots:  # sqlite_schema's own tree, read by nobody.
                    count, leaves = pages.tree(root)
                    walked += count
                    if kind == 'table':
                        chosen = leaves if len(leaves) <= OVERFLOW_SAMPLE else sample.sample(leaves, OVERFLOW_SAMPLE)
                        owned = sum(pages.overflow(number) for number in chosen) * len(leaves) / max(1, len(chosen))
                        tables.append((count, owned))
    except (OSError, sqlite3.Error, ValueError, IndexError, struct.error):
        return size + size_wal
    unexplained = max(0, pages.count - pages.free - walked - sum(owned for _, owned in tables))
    largest = max((count + owned for count, owned in tables), default=0)
    return min(size, int((largest + unexplained) * pages.page_size)) + size_wal


def live_migration(database):
    """The newest migration id `database` recorded, or None when it cannot tell."""
    try:
        with read_only(database) as db:
            return additive_migrations.newest(db)
    except (OSError, sqlite3.Error, ValueError):
        return None


def full_read_runs(table):
    """Bytes of the sorted runs a full read of a `table`-byte table holds at its peak."""
    return int(FULL_READ_LINE_FACTOR * table)


def _existing(path):
    path = pathlib.Path(path)
    while not path.exists() and path != path.parent:
        path = path.parent
    return path


def staged_release_bytes(own, home, version):
    """(bytes, source): what staging `version` still writes; see the module docstring."""
    releases = studio_paths.releases_root(home)
    with contextlib.suppress(OSError):
        for release in releases.iterdir():
            manifest = release / 'studio-manifest.json'
            if release.is_symlink() or not release.is_dir() or not manifest.is_file():
                continue
            with contextlib.suppress(OSError, ValueError):
                if json.loads(manifest.read_text()).get('version') == version:
                    return 0, 'in-release-store'
    downloads = pathlib.Path(own) / 'updates' / 'downloads' / version
    with contextlib.suppress(OSError):
        archives = [entry.stat().st_size for entry in downloads.iterdir()
                    if entry.is_file() and not entry.is_symlink() and entry.name.endswith(('.tar.gz', '.tgz', '.zip'))]
        if archives:
            return STAGE_UNPACK_FACTOR * max(archives), 'downloaded-archive'
    return STAGED_RELEASE_BYTES, 'estimate'


def default_identity(home):
    """The one identity with an installation under `home`; RoomError when none or several."""
    root = studio_paths.studio_root(home)
    found = sorted(path.parent.name for path in root.glob('*/installation.json')
                   if path.is_file() and IDENTITY.fullmatch(path.parent.name))
    if len(found) != 1:
        raise RoomError('Give --identity: %s installations under %s' % (len(found) or 'no', root))
    return found[0]


def room(home, identity, version, live=None, largest=None):
    """The report `update.py room` prints. `live` and `largest` read the newest migration and
    the largest table's bytes (update.py passes update_apply's, which read through a snapshot)."""
    home = pathlib.Path(home)
    if not IDENTITY.fullmatch(identity or ''):
        raise RoomError('Invalid identity %r' % identity)
    if not VERSION.fullmatch(version or ''):
        raise RoomError('Invalid version %r' % version)
    own = studio_paths.identity_home(home, identity)
    database = own / 'userdata' / 'statev2.sqlite'
    if not database.is_file():
        raise RoomError('%s has no state database at %s' % (identity, database))
    newest = (live or live_migration)(database)
    pending = additive_migrations.full_read_pending(newest)
    folder = kept_lines.spill_folder(database)
    runs = full_read_runs((largest or largest_table_bytes)(database)) if pending else 0
    fallback = runs + kept_lines.DISK_FLOOR_MARGIN if pending and folder is not None else 0
    backup, method = state_backup.backup_space_needed(own, home, state_backup._clonefile())
    staged, staged_from = staged_release_bytes(own, home, version)
    state_volume = folder or own / 'userdata'
    # Each part on the volume it is written to; on one Mac all three are usually the same.
    places = [(state_volume, 'fallback', fallback), (state_backup._backup_volume(home), 'backup', backup),
              (_existing(studio_paths.releases_root(home)), 'staged', staged)]
    volumes = {}
    for path, _, need in places:
        device = os.stat(str(path)).st_dev
        entry = volumes.setdefault(device, {'volume': str(path), 'freeBytes': kept_lines.available_disk(path), 'needBytes': 0})
        entry['needBytes'] += need
    for entry in volumes.values():
        entry['ok'] = entry['freeBytes'] is not None and entry['freeBytes'] >= entry['needBytes']
    first = volumes[os.stat(str(state_volume)).st_dev]
    report = {'identity': identity, 'version': version, 'freeBytes': first['freeBytes'],
              'needBytes': fallback + backup + staged,
              'parts': {'fallback': fallback, 'backup': backup, 'staged': staged},
              'ok': all(entry['ok'] for entry in volumes.values()), 'volume': str(state_volume),
              'installedMigration': newest, 'fullReadMigrations': pending, 'backupMethod': method,
              'stagedFrom': staged_from}
    if pending and folder is None:  # Runs held in memory: no disk for them, memory instead.
        report['fallbackMemoryBytes'] = runs
        report['ok'] = report['ok'] and kept_lines.memory_room(runs)
    if len(volumes) > 1:
        report['volumes'] = list(volumes.values())
    return report


def describe(report):
    """One line naming the host, its need and its free space."""
    if 'error' in report:
        return '%s: room unknown (%s)' % (report.get('identity') or '?', report['error'])
    parts = report['parts']
    line = '%s: needs %.1f GB, %.1f GB free on %s (fallback %.1f, backup %.1f, staged %.1f GB)' % (
        report['identity'], report['needBytes'] / 1e9, (report['freeBytes'] or 0) / 1e9, report['volume'],
        parts['fallback'] / 1e9, parts['backup'] / 1e9, parts['staged'] / 1e9)
    if 'fallbackMemoryBytes' in report:
        line += ', %.1f GB of memory for the full read' % (report['fallbackMemoryBytes'] / 1e9)
    return line + (' - ok' if report['ok'] else ' - SHORT')


def main(argv=None, live=None, largest=None):
    parser = argparse.ArgumentParser(prog='room', description='Disk an update of this host needs.')
    parser.add_argument('--version', required=True, help='The release to be installed')
    parser.add_argument('--identity', help='Default: the one installation under the home')
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--home', type=pathlib.Path, help=argparse.SUPPRESS)  # Tests: a temporary private home.
    args = parser.parse_args(argv)
    home = (args.home or pathlib.Path.home()).resolve()
    try:
        identity = args.identity or default_identity(home)
        report = room(home, identity, args.version, live=live, largest=largest)
    except (RoomError, OSError) as error:
        report = {'identity': args.identity, 'version': args.version, 'error': str(error)[:300]}
    print(json.dumps(report, sort_keys=True) if args.json else describe(report))
    return 2 if 'error' in report else 0 if report['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
