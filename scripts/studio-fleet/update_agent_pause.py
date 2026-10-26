"""What a refused snapshot means, and how long an automatic install waits for running work.

An automatic install used to wait for a fully quiet service forever: a long turn kept "Waiting for
running work" up for hours, and only Update now drained it. Now the first busy refusal starts a
grace (state.json `automaticWaitSince`, the start of that pass; config.json `pauseWorkAfterMinutes`,
default 10). Once it has passed, and no "Later" postpones it (`automaticPausePostponedUntil`), the
agent drains and holds the service the way Update now does (service_hold.ServiceHold: `service
prepare-update --stop-work --hold --reason install`), then writes a forced request bound to the
downloaded version. run_once's second iteration serves that request inside the same pass lock, and
the turns the drain stopped continue after the restart. state.json `automaticPauseAt` tells the
desktop when that happens.

The clock (one launchd pass every START_INTERVAL): automaticPauseAt is the first scheduled pass at
or after the grace and any "Later", counted in whole passes from the pass that started the grace
(since + k * START_INTERVAL, k >= 1), and a pass pauses only when the grace started in an earlier
pass and now >= automaticPauseAt. So a 10-minute grace pauses on the second scheduled busy pass,
and nothing pauses before the time shown. There is no early allowance: the desktop also starts
unscheduled passes (app start, startAgent's `launchctl kickstart`), which run the same job with the
same argv and environment as launchd's timer, so a pass cannot tell which it is, and an allowance
sized for the next scheduled pass would let an unscheduled one pause before the time shown. When the
pass that started the grace was itself unscheduled, the grid is off launchd's phase and the pause
lands on the first pass after automaticPauseAt, at most one START_INTERVAL late. `now` is read after
the snapshot, so a scheduled pass on the grid is past automaticPauseAt by the snapshot's duration.
The grace starts again when the last busy refusal (`automaticLastBusyAt`) is older than two passes,
or when the last pass published no `automaticPauseAt`. At most one drain runs per version
in DRAIN_EVERY (`automaticPausedAt` {version, at}); a drain that did not install leaves the pass
waiting and asks the person to choose Update now. Every drain that ends without a written forced
request releases its hold. A service that has not published CLI_CREDENTIAL never drains automatically.

It also holds refusal_reason and its phrases, moved here from update_agent.py (file-size cap), which
re-exports them. Stdlib only and Python 3.9 compatible; copied beside every installed agent.
"""
import datetime
import os
import pathlib
import re
import subprocess
import sys

import service_hold  # Shipped beside this file.
import update_request  # Shipped beside this file.
from service_handles import DETACHED_DATABASE, LOCKS_LOST  # Shipped beside this file: update.py's own texts.

TIMED_OUT = "The updater's check took too long; retrying"
WAITING = 'Waiting for running sessions and open SpecWithCode terminals to finish'
# What the snapshot helper's refusal means, in the words the app shows. The helper's
# output is read only for its REFUSAL line or these phrases; it is never logged or kept.
WAITING_REASONS = (
    ('Native work is not idle', 'Waiting for running tasks, queued messages and open questions to finish'),
    ('has unexpected descendants', 'Waiting for open SpecWithCode terminals and agent processes to close'),
    ('unexpected or missing descendants', 'Waiting for open SpecWithCode terminals and agent processes to close'),
)
# update.py idle_agent_refusal: only the service's own idle provider servers are open (idle_agents.py).
IDLE_AGENTS = ('Waiting for a quiet moment, then closing idle agent processes so the update can install',
               'Closed idle agent processes; installing after a quiet moment')
# update.py database_restart_refusal: the service lost its database locks; only a restart recovers it.
# Shown while the helper restarts it itself (restarted=, wait=, retry=). Otherwise Update now or Try
# again does: update.py restarts such a service for a live explicit request (database_restart.py).
# '' is any other fault: nothing restarts it for an update, so it never promises that Update now does.
RECOVERING = ('Restarting SpecWithCode to recover its database',
              'Restarted SpecWithCode to recover its database; installing after a quiet moment')
RESTART_FAULTS = {
    'locks-lost': LOCKS_LOST, 'detached': DETACHED_DATABASE,
    '': ('The SpecWithCode service lost its hold on its database. '
         'SpecWithCode will try again; if this persists, restart the Mac')}
# `REFUSAL <code> <detail>`, the helper's structured reason; details are counts and names only.
REFUSAL_LINE = re.compile(r'^REFUSAL ([a-z][a-z-]{0,31})(?: ([ -~]{0,400}))?$', re.M)
WORK_NOUNS = (('runs', 'running task'), ('queued', 'queued message'), ('requests', 'open request'),
              ('effects', 'finishing step'), ('sessions', 'active session'))

GRACE_MAX_MINUTES = 10080  # As quietMinutes: a week.
# A wait dated this far ahead of the agent's clock was not counted by this computer.
CLOCK_SKEW = datetime.timedelta(minutes=5)
START_INTERVAL = datetime.timedelta(seconds=600)  # update_agent.install_launch_agent's StartInterval: one pass.
DRAIN_EVERY = datetime.timedelta(minutes=60)  # At most one automatic drain per version in this window.
# Published by a running service whose CLI calls it with this token instead of opening the live
# database read-write to add its own session (1085, apps/server/src/auth/LocalCliCredential.ts). An
# older CLI's open is what deleted M4's -wal on 2026-10-26, so without the file the agent keeps
# waiting for quiet. Its presence, not a version number, decides; fleet_rollout keeps PREPARE_UPDATE_SINCE.
CLI_CREDENTIAL = ('secrets', 'local-cli-credential.bin')
HOLD = service_hold.ServiceHold  # Tests replace it with a fake.
PAUSING = 'Pausing running work to install SpecWithCode %s; it continues after the update'
PAUSED = 'Paused running work; installing SpecWithCode %s'
WILL_PAUSE = '%s; running work will be paused at %s and continue after the update'
NOT_PAUSED = '%s; the automatic pause did not install the update. Choose Update now to pause running work and install'


def refusal_reason(refusal, outcome):
    """(status, message) for a refused snapshot. The helper's last REFUSAL line wins; older
    helpers print none, so the phrase table stays. Only an environment fault, or a database fault
    that no automatic restart will clear, is an error."""
    found = REFUSAL_LINE.findall(refusal) if outcome != 'timeout' else [('timeout', '')]
    code, detail = found[-1] if found else ('', '')
    detail = re.sub(r'[^A-Za-z0-9 ._:,=()+-]', '', detail).strip()[:200]
    if code == 'timeout':
        return 'waiting-for-quiet', TIMED_OUT
    if code == 'environment':
        return 'error', 'SpecWithCode cannot be updated right now: ' + (detail or 'the service does not match its installation')
    if code == 'native-work':
        counts = {key: int(value) for key, value in re.findall(r'([a-z]+)=(\d{1,6})', detail)}
        parts = ['%d %s%s' % (counts[key], noun, '' if counts[key] == 1 else 's')
                 for key, noun in WORK_NOUNS if counts.get(key)]
        return 'waiting-for-quiet', WAITING_REASONS[0][1] + (' (%s)' % ', '.join(parts) if parts else '')
    if code in ('descendants', 'idle-agents'):
        pairs = re.findall(r'([A-Za-z0-9._+-]{1,40})=(\d{1,4})', detail)
        names = ['%s%s' % (name, '' if count == '1' else ' x' + count)
                 for name, count in pairs if name not in ('wait', 'stopped')][:6]
        message = WAITING_REASONS[1][1] if code == 'descendants' else IDLE_AGENTS['stopped' in dict(pairs)]
        return 'waiting-for-quiet', message + (' (%s)' % ', '.join(names) if names else '')
    if code == 'restart-needed':
        if re.search(r'(?:^| )(?:restarted|wait|retry)=', detail):
            return 'waiting-for-quiet', RECOVERING['restarted=' in detail]
        return 'error', 'SpecWithCode cannot be updated right now: ' + RESTART_FAULTS.get(detail.split(' ')[0], RESTART_FAULTS[''])
    return 'waiting-for-quiet', next((message for phrase, message in WAITING_REASONS if phrase in refusal), WAITING)


def _ua(agent):
    return sys.modules[type(agent).__module__]


def running_work(refused):
    """True for a refusal a drain clears: running tasks, queued messages and open questions (the
    drain records the questions and asks them again), or terminals and agent processes beneath the
    service. A timeout, idle agent processes the helper closes itself, a database fault or an
    unrecognized refusal is not running work, so it never pauses anything."""
    work = (WAITING_REASONS[0][1], WAITING_REASONS[1][1])
    return refused[0] == 'waiting-for-quiet' and refused[1].startswith(work)


def forget(state):
    """Ends the wait for running work: after an install starts, for a new download, with automatic
    installs off and once a snapshot finds the service idle. automaticPausedAt stays: it limits
    drains per version. Returns None, so a caller may chain it."""
    state['automaticWaitSince'] = state['automaticPauseAt'] = state['automaticLastBusyAt'] = None


def pause_at(config, since):
    """When an automatic install waiting since `since` pauses running work: the first scheduled pass
    (since + k * START_INTERVAL, k >= 1) at or after the grace, and never before a "Later" postpones
    it to. See the module's clock."""
    due = since + datetime.timedelta(minutes=_grace(config))
    postponed = update_request._time(config.get('automaticPausePostponedUntil'))
    target = max(due, postponed) if postponed is not None else due
    passes = -((since - target) // START_INTERVAL)  # Whole passes, rounded up.
    return since + max(1, passes) * START_INTERVAL


def _grace(config):
    grace = config.get('pauseWorkAfterMinutes')
    return grace if type(grace) is int and 1 <= grace <= GRACE_MAX_MINUTES else 10


def due(config, since, started, now):
    """True when this pass pauses: the grace started in an earlier pass and now has reached
    pause_at, which already counts any "Later". No allowance before it: a pass started by the desktop
    looks like a scheduled one (see the module's clock)."""
    return since < started and now >= pause_at(config, since)


def clock(moment):
    """The local wall-clock time a person reads in the status line, e.g. 14:41."""
    return moment.astimezone().strftime('%H:%M')


def supported(agent):
    """True when the service's state folder (installation.json `stateDir`, else <home>/userdata)
    holds CLI_CREDENTIAL. Only stats the file; an unreadable installation.json is not proof."""
    try:
        own, receipt = service_hold.ServiceHold(agent.identity, agent.home).receipt()
    except service_hold.HoldUnavailable:
        return False
    state = receipt.get('stateDir') if isinstance(receipt, dict) else None
    folder = pathlib.Path(state) if isinstance(state, str) and os.path.isabs(state) else own / 'userdata'
    return folder.joinpath(*CLI_CREDENTIAL).is_file()


def drained_recently(ua, state, version, now):
    """True when an automatic drain for `version` ran within DRAIN_EVERY."""
    paused = state.get('automaticPausedAt')
    at = ua.parse_time(paused.get('at')) if isinstance(paused, dict) else None
    return at is not None and paused.get('version') == version and now - DRAIN_EVERY < at <= now + CLOCK_SKEW


def after_refusal(agent, verified, refused):
    """Ends an automatic pass whose snapshot was refused. For running work: keep waiting until
    automaticPauseAt, then drain, hold and ask for a forced install; anything else ends as before."""
    ua, state = _ua(agent), agent.state
    if not running_work(refused):
        state['automaticPauseAt'] = None  # Not waiting on work now; the grace starts again.
        return agent.finish(*refused)
    if not supported(agent):  # Its drain would open the live database read-write: wait for quiet as before.
        forget(state)
        return agent.finish(*refused)
    now = ua.utcnow()
    started = getattr(agent, 'pass_started', None) or now
    try:  # The snapshot took minutes: a "Later" pressed meanwhile counts.
        config = ua.load_config(agent.updates, agent.home)
    except ua.AgentError:
        config = agent.config
    since, last = ua.parse_time(state.get('automaticWaitSince')), ua.parse_time(state.get('automaticLastBusyAt'))
    if since is None or since > now + CLOCK_SKEW or last is None or last < started - 2 * START_INTERVAL \
            or state.get('automaticPauseAt') is None:
        since = started
        state['automaticWaitSince'] = ua.iso(started)
    state['automaticLastBusyAt'] = ua.iso(now)
    if drained_recently(ua, state, verified['version'], now):  # The last drain did not install it.
        state['automaticPauseAt'] = None
        return agent.finish('waiting-for-quiet', NOT_PAUSED % refused[1])
    state['automaticPauseAt'] = ua.iso(pause_at(config, since))
    if not due(config, since, started, now):
        return agent.finish('waiting-for-quiet', WILL_PAUSE % (refused[1], clock(pause_at(config, since))))
    return _pause_and_request(agent, verified, refused)


def _background_run(ua):
    """subprocess.run for the service CLI, out of the agent's darwin background throttling: a person
    waits on the drain, and the CLI's own call allows 150 seconds."""
    def run(argv, **options):
        return subprocess.run(argv, preexec_fn=ua.leave_background_io, **options)
    return run


def _describe(reply):
    counts = [(reply.get('stoppedThreads'), 'thread'), (reply.get('interruptedRuns'), 'turn'),
              (reply.get('openTerminals'), 'terminal')]
    return ', '.join('%d %s%s' % (count, noun, '' if count == 1 else 's')
                     for count, noun in counts if type(count) is int) or 'nothing reported'


def _release(agent, hold):
    """Best effort: lets work start again after a drain that wrote no forced request."""
    ua = _ua(agent)
    try:
        # `--release-hold` ends the hold (ServiceUpdatePreparation prepare: hold.release("cancelled")),
        # which counts in ServiceUpdateHold's releaseCount; serverRuntimeStartup.resumeAfterHoldReleases
        # then continues the turns the drain stopped, once no drain runs and no install request is open.
        # It counts only a hold that existed: turns a drain stopped without holding (held: false) are
        # not continued by it, and a drain still running past HOLD_TIMEOUT may hold after this release.
        hold.release()
    except Exception as error:  # Never fails the pass: the hold lapses by itself.
        why = '%s: %s' % (type(error).__name__, error) if isinstance(error, service_hold.HoldUnavailable) \
            else type(error).__name__
        agent.out(ua.redact('update-agent %s: could not release the service hold (%s)' % (agent.identity, why))[:400])


def _keep_waiting(agent, refused, why, hold=None):
    """The drain or the request failed: release the hold, say why in agent.log and wait; no drain
    runs again for this version inside DRAIN_EVERY."""
    if hold is not None:
        _release(agent, hold)
    agent.out(_ua(agent).redact('update-agent %s: could not pause running work (%s); waiting' % (agent.identity, why))[:400])
    agent.state['automaticPauseAt'] = None
    return agent.finish('waiting-for-quiet', NOT_PAUSED % refused[1])


def _newer_update_now(agent):
    """True when an explicit forced request replaced this pass's settings during the drain: it
    serves the service's hold itself (run_once's second iteration), so the hold stays."""
    ua = _ua(agent)
    try:
        current = ua.load_config(agent.updates, agent.home)
    except ua.AgentError:
        return False
    return current['installMode'] == 'force' and current['installRequestedAt'] not in (None, agent.config['installRequestedAt']) \
        and not ua.install_cancelled(current)


def _pause_and_request(agent, verified, refused):
    """Update now's drain and hold, then one forced request for the downloaded version, in that order:
    the hold inserts a session row, which would fail the guarded prestate of a request written first.
    The request is served by run_once's second iteration, which installs it inside this pass's lock."""
    ua, version = _ua(agent), verified['version']
    if ua.recovery.automatic_superseded(agent):
        return agent.finish('downloaded', ua.recovery.SETTINGS_CHANGED)
    agent.state['automaticPausedAt'] = {'version': version, 'at': ua.iso(ua.utcnow())}
    agent.state['automaticPauseAt'] = None  # The drain starts: the desktop offers no Later from here (set_status saves it).
    agent.set_status('waiting-for-quiet', PAUSING % version)  # The service holds only for a pending update.
    hold = HOLD(agent.identity, agent.home, run=_background_run(ua))
    try:
        reply = hold.prepare()
    except service_hold.HoldUnsupported as error:  # Its CLI has no such command: nothing was held.
        return _keep_waiting(agent, refused, '%s: %s' % (type(error).__name__, error))
    except service_hold.HoldUnavailable as error:  # A timeout too: the drain may still have held it.
        return _keep_waiting(agent, refused, '%s: %s' % (type(error).__name__, error), hold)
    if not isinstance(reply, dict) or reply.get('held') is not True:
        return _keep_waiting(agent, refused, 'the service did not hold: ' + _describe(reply if isinstance(reply, dict) else {}), hold)
    if ua.recovery.automatic_superseded(agent):  # Installs turned off, or Update now pressed, during the drain.
        if not _newer_update_now(agent):
            _release(agent, hold)
        return agent.finish('downloaded', ua.recovery.SETTINGS_CHANGED)
    try:
        written = update_request.write_request(agent.home, agent.identity, version, force=True,
                                               hold_minutes=update_request.HOLD_MAX_MINUTES, now=ua.utcnow())
    except (update_request.RequestError, OSError) as error:
        return _keep_waiting(agent, refused, 'no install request: %s' % type(error).__name__, hold)
    forget(agent.state)  # A failed install waits DRAIN_EVERY, then a new grace, before work is paused again.
    agent.out('update-agent %s: paused running work for SpecWithCode %s (%s); asked for a forced install at %s'
              % (agent.identity, version, _describe(reply), written['installRequestedAt']))
    return agent.finish('waiting-for-quiet', PAUSED % version)
