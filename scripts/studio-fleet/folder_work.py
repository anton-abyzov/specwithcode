"""Folder copies in progress on a SpecWithCode service, as the service publishes them.

While it copies a folder to or from another machine, the service keeps `updates/folder-work.json`
(apps/server/src/fleet/folderTransfer/folderWork.ts), written every 10 seconds with an `until` a
minute ahead. The database and process checks cannot see a copy: the source serves it from inside
the server process and the destination keeps its state in files. So a normal or automatic install
reads this file and waits while it is live (`update.py snapshot`), and so does a forced request
written by an automatic pause or a rollout's drain (`request_waits`); one a person forced does not. A file
whose `until` passed (its service stopped or crashed), an unreadable one and one dated further
ahead than a write lasts hold nothing, so a copy can never keep an update back for good.
"""
import datetime
import json

FILE = 'folder-work.json'
REFUSAL = 'Folder copies are in progress'
CODE = 'folder-copy'
TTL = datetime.timedelta(minutes=1)  # folderWork.ts HEARTBEAT_TTL_MS
SKEW = datetime.timedelta(seconds=30)
MAX_BYTES = 4096
# update_request.WAITS_FOR_FOLDER_COPIES: the installRequestedAt of a forced request that waits.
WAITS_KEY = 'installWaitsForFolderCopiesAt'
CONFIG_BYTES = 64 << 10  # update_agent.load_config's cap


def _utc(value):
    if not isinstance(value, str) or not 0 < len(value) <= 64:
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value[:-1] + '+00:00' if value.endswith('Z') else value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def in_progress(updates, now=None):
    """The folder copies the service reports in progress at `now`; 0 for none or a stale file."""
    path = updates / FILE
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_BYTES:
            return 0
        value = json.loads(path.read_text())
    except (OSError, ValueError):
        return 0
    if not isinstance(value, dict) or value.get('schemaVersion') != 1:
        return 0
    count, until = value.get('operations'), _utc(value.get('until'))
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if type(count) is not int or count < 1 or until is None or not now < until <= now + TTL + SKEW:
        return 0
    return count


def request_waits(updates, request):
    """True when config.json marks the pending forced request dated `request` as one that waits for
    folder copies: written by an automatic pause or a rollout's drain, not by a person. A request
    written since (the desktop, a person's CLI request) carries no matching mark."""
    path = updates / 'config.json'
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > CONFIG_BYTES:
            return False
        config = json.loads(path.read_text())
    except (OSError, ValueError):
        return False
    return (isinstance(config, dict) and isinstance(request, str)
            and config.get(WAITS_KEY) == request == config.get('installRequestedAt'))


def refusal(count):
    """The helper's REFUSAL line; details are a count only."""
    return 'REFUSAL %s operations=%d' % (CODE, count)


