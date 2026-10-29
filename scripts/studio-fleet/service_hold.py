"""Drain and hold one Mac's SpecWithCode service for an install, the way the desktop's Update now does.

Two callers share it: fleet_rollout.py holds M4 before it asks for a forced install, and the update
agent (update_agent_pause.py) holds the service once an automatic install has waited for running work
longer than its grace. Both run the service's own CLI, so the drain is the service's prepareServiceUpdate
call and the turns it stops continue after the restart. Stdlib only and Python 3.9 compatible; copied
beside the installed update agent (update_request.AGENT_FILES), which imports it without this checkout.
"""
import json
import os
import pathlib
import re
import subprocess

import studio_paths

# The CLI's own drain call allows 150 s (servicePrepareUpdate.ts STOP_WORK_TIMEOUT), plus start-up.
HOLD_TIMEOUT = 200
RELEASE_TIMEOUT = 60
# The first release whose CLI has `service prepare-update ... --json` (servicePrepareUpdate.ts).
# Older services serve the same prepareServiceUpdate call to their own Update now, not to a CLI.
PREPARE_UPDATE_SINCE = (1, 0, 45)
# What an older CLI prints for the command or its flags.
CLI_PARSE_ERRORS = ('Unrecognized flag', 'Unknown subcommand', 'Invalid subcommand', 'Unknown command')
_VERSION = re.compile(r'(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})')


class HoldUnavailable(Exception):
    """The service could not be drained and held; callers never go on as if it were."""


class HoldUnsupported(HoldUnavailable):
    """The installed service CLI predates `service prepare-update` (PREPARE_UPDATE_SINCE)."""


def _tuple(version):
    match = _VERSION.fullmatch(version) if isinstance(version, str) else None
    return tuple(int(part) for part in match.groups()) if match else None


class ServiceHold(object):
    """Drains and holds the identity's service for an install the way the desktop's Update now does:
    its own CLI (`cliWrapper` in the identity's installation.json, which runs the installed
    release with the service's environment) calls `service prepare-update`, which makes the
    service's prepareServiceUpdate call over its socket with a five-minute session it leaves to
    lapse (a revoke could land between update.py's snapshot and apply). The service then refuses new
    work until the update installs, fails, is released, or its hold runs out, and keeps
    updates/hold.json for update.py --reap. Raises HoldUnavailable when that CLI or its service cannot
    do it (an older release has no such command)."""

    wait_for_idle = False

    def __init__(self, identity, home=None, run=subprocess.run):
        self.identity = identity
        self.home = pathlib.Path(home or pathlib.Path.home())
        self.run = run

    def receipt(self):
        own = studio_paths.identity_home(self.home, self.identity)
        try:
            receipt = json.loads((own / 'installation.json').read_text())
        except (OSError, ValueError) as error:
            raise HoldUnavailable('no readable installation.json in %s (%s)' % (own, type(error).__name__)) from None
        return own, receipt

    def support(self):
        """(True, None) when the installed CLI has `service prepare-update`, else (False, reason).
        An unreadable or unversioned receipt is left to the call itself."""
        installed = self.installed_version()
        if installed is not None and installed < PREPARE_UPDATE_SINCE:
            return False, '%s runs %s; `service prepare-update` first shipped in %s' % (
                self.identity.upper(), '.'.join(map(str, installed)), '.'.join(map(str, PREPARE_UPDATE_SINCE)))
        return True, None

    def installed_version(self):
        """The installed release from installation.json as (major, minor, patch); None when the
        receipt is unreadable or names no version."""
        try:
            _own, receipt = self.receipt()
        except HoldUnavailable:
            return None
        return _tuple(receipt.get('version') if isinstance(receipt, dict) else None)

    def command(self, flags):
        own, receipt = self.receipt()
        wrapper = receipt.get('cliWrapper') if isinstance(receipt, dict) else None
        studio_home = receipt.get('studioHome') if isinstance(receipt, dict) else None
        if not isinstance(wrapper, str) or not os.path.isabs(wrapper) or not os.path.isfile(wrapper) \
                or not os.access(wrapper, os.X_OK):
            raise HoldUnavailable('installation.json names no runnable cliWrapper')
        if studio_home != str(own):
            raise HoldUnavailable('installation.json names the home %r, not %s' % (studio_home, own))
        return [wrapper, 'service', 'prepare-update', '--base-dir', studio_home] + list(flags) + ['--json']

    def _call(self, flags, timeout):
        argv = self.command(flags)
        try:
            result = self.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise HoldUnavailable('no answer within %ds' % timeout) from None
        except OSError as error:
            raise HoldUnavailable('could not run the service CLI (%s)' % type(error).__name__) from None
        lines = [line for line in (result.stdout or '').splitlines() if line.strip()]
        try:
            value = json.loads(lines[-1]) if lines else None
        except ValueError:
            value = None
        if isinstance(value, dict) and result.returncode == 0 and 'error' not in value:
            return value
        if isinstance(value, dict) and isinstance(value.get('error'), str):
            reason = value['error']
        else:  # An older CLI prints its usage for the unknown command.
            other = [line.strip() for line in (result.stderr or '').splitlines() if line.strip()]
            reason = 'exit %d%s' % (result.returncode, ': ' + other[-1][:200] if other else '')
            if any(phrase in (result.stderr or '') + (result.stdout or '') for phrase in CLI_PARSE_ERRORS):
                raise HoldUnsupported('the service CLI has no `service prepare-update --json` (%s)' % reason)
        raise HoldUnavailable(reason)

    def prepare(self):
        """Stops the service's work and holds it for an install; returns its answer. Raises
        HoldUnsupported, without running anything, for a release older than the command."""
        supported, reason = self.support()
        if not supported:
            raise HoldUnsupported(reason)
        return self._call(self.prepare_flags(), HOLD_TIMEOUT)

    def prepare_flags(self):
        return (['--hold', '--if-idle'] if self.wait_for_idle else ['--stop-work', '--hold']) + ['--reason', 'install']

    def release(self):
        """Releases the hold, as Cancel update does, so work can start again."""
        supported, reason = self.support()
        if not supported:
            raise HoldUnsupported(reason)
        return self._call(['--release-hold'], RELEASE_TIMEOUT)
