"""Which install request the update agent may still act on.

The desktop writes `installRequestedAt` (read by every agent) and, beside it, `installRequest`
`{at, version}`: the version the app showed when the user asked. A request with that record is
bound to its version and lapses after REQUEST_TTL, so a click for 1.0.7 never installs 1.0.8
and a request nobody followed never installs at some later idle moment. A request without the
record (an older desktop) keeps the earlier behaviour. Shipped beside update_agent.py, which
imports it; stdlib only and Python 3.9 compatible like the agent.
"""
import datetime
import os
import re

REQUEST_TTL = datetime.timedelta(minutes=10)
# A request dated this far ahead of the agent's clock was not written by this computer's app.
CLOCK_SKEW = datetime.timedelta(minutes=5)
EXPIRED = 'The update request expired before it could start; choose Update now again.'
_SEMVER = re.compile(r'(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})')


def _time(value):
    if not isinstance(value, str) or not 0 < len(value) <= 64:
        return None
    text = value[:-1] + '+00:00' if value.endswith('Z') else value
    try:
        moment = datetime.datetime.fromisoformat(text)
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else None


def _version(value):
    match = _SEMVER.fullmatch(value) if isinstance(value, str) else None
    return tuple(int(part) for part in match.groups()) if match else None


def bound(config):
    """The `installRequest` record of the pending request: a dict, None when the request has
    none (an older desktop wrote it), or False when the record is malformed."""
    record = config.get('installRequest')
    if record is None:
        return None
    if not (isinstance(record, dict) and set(record) == {'at', 'version'}
            and _time(record['at']) is not None and _version(record['version']) is not None):
        return False
    return record if record['at'] == config.get('installRequestedAt') else None


def _verdict(config, state, installed, now, cancelled):
    """(pending, message) for the settings' install request; `installed` is the installed version
    as a tuple, or None. A request that is not pending is settled (copied into
    handledInstallRequestAt); message says why when the user should know."""
    requested = config.get('installRequestedAt')
    if requested is None or requested == state.get('handledInstallRequestAt'):
        return False, None
    record = bound(config)
    settled, expired = cancelled(config) or record is False, False
    if record:
        at, wanted = _time(record['at']), _version(record['version'])
        settled = settled or at > now + CLOCK_SKEW
        settled = settled or (installed is not None and wanted <= installed)
        expired = not settled and now - at > REQUEST_TTL
    if settled or expired:
        state['handledInstallRequestAt'] = requested
    return not (settled or expired), EXPIRED if expired else None


def pending(config, state, installed, now, cancelled, failure):
    """True while the settings hold an install request this pass should act on. A request that
    was cancelled, has a malformed record or asks for a version already installed is settled
    here and never acted on later. One that lapsed is settled too, and raises failure(EXPIRED)
    so the pass ends saying why instead of with an unrelated status."""
    waiting, message = _verdict(config, state, installed, now, cancelled)
    if message:
        raise failure(message)
    return waiting


def refuse(config, state, version):
    """The message for a pending request bound to a version other than `version`, the release
    this pass would install; the request is then settled. None when the request may install it."""
    record = bound(config)
    if not record or record['version'] == version:
        return None
    state['handledInstallRequestAt'] = config['installRequestedAt']
    return ('SpecWithCode %s was asked for, but %s is the update now available; '
            'choose Update now again to install it.' % (record['version'], version))


def replaced(before, config, state, version, now):
    """None while the pending request is still `before` (the one this pass started with) or is a
    newer one that may install `version`. Otherwise that newer request is settled and this is
    the (status, message) that ends the pass, so it never installs a version it did not ask for."""
    if config.get('installRequestedAt') == before:
        return None
    waiting, message = _verdict(config, state, None, now, lambda _config: False)
    refusal = refuse(config, state, version) if waiting else None
    if message or refusal:
        return 'error', message or refusal
    return None if waiting else ('downloaded', None)


def arrived(agent, load):
    """True when a request written while the agent's pass held the lock is still pending. The
    kick that came with it found the lock taken, so nothing else would serve it before it
    lapses. `load` re-reads the settings; nothing runs again while an install marker is left."""
    try:
        requested = load().get('installRequestedAt')
    except Exception:  # Settings that do not load are reported by the next scheduled pass.
        return False
    seen = (None, agent.config.get('installRequestedAt'), agent.state.get('handledInstallRequestAt'))
    return requested not in seen and not os.path.lexists(str(agent.marker_path))
