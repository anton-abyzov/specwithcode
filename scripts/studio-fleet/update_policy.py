"""Whether an update may pause a machine's running work: its owner's "Pause running work for updates".

The setting lives in the machine's own server settings (pauseWorkForUpdates, off by default), and
the service reports it in two answers: `service prepare-update --json` (service_hold.ServiceHold.look,
which stops and holds nothing) and a worker's fleet update status over SpecWithCode Connect. Only
the service knows it: settings.json leaves defaults out, so nothing here reads that file.

Three callers, one rule. The update agent's automatic pause (update_agent_pause.after_refusal)
asks before it starts or continues a grace; with the setting off it waits for quiet and publishes
no pause time. The rollout (fleet_rollout.py) holds M4 only when idle, and never forces a worker,
when the setting is off there. Such a host keeps its full deadline; it ends `deferred`, its owner's
choice and not a failure, only on its own evidence that running work kept it (busy) once
DEFER_SECONDS have passed and before its install started (deferral). A service too old to report
the setting predates it and is treated as before it existed (decision D-08), so the first rollout
after it ships still drains M4. M4 whose service did not answer is held only when idle, but is
never deferred: nothing says its owner chose that.

Stdlib only and Python 3.9 compatible; copied beside every installed agent (update_request.AGENT_FILES).
"""
import service_hold  # Shipped beside this file.

KEY = 'pauseWorkForUpdates'
SETTING = 'Pause running work for updates'
# How long a busy host whose setting is off is waited for before it is left for later: a Linux boot
# service waits as long for quiet itself, and a rollout should not sit an hour on a busy machine.
DEFER_SECONDS = 30 * 60
# The update agent's refusals for running work, which only a drain ends (update_agent_pause.running_work).
RUNNING_WORK = ('Waiting for running tasks, queued messages and open questions to finish',
                'Waiting for open SpecWithCode terminals and agent processes to close')

ON, OFF, LEGACY, UNKNOWN = 'on', 'off', 'legacy', 'unknown'
DEFERRED = 'deferred'  # A rollout row's result for a host its setting left on its version.
SSH_PLAIN = ('%s: reached over pinned SSH, where "' + SETTING + '" cannot be read, so it is asked without '
             'force and installs once it is quiet')
M4_LATER = 'not asked: M4 was left for later'  # The workers' rows behind a deferred M4.


def pauses_work(answer):
    """True or False as the service reports the setting; None when the answer has no boolean for it
    (a service older than the setting, a status read over pinned SSH, no answer at all)."""
    value = answer.get(KEY) if isinstance(answer, dict) else None
    return value if type(value) is bool else None


def over_ssh(host):
    """True for a host reached over pinned fleet SSH. update_request.py answers there, not the
    service, so the setting is unknown and a worker is never forced on that route: nothing is
    paused on a guess. A FallbackHost names its route once it answered; a plain Host by its command."""
    route = getattr(host, 'route', None)
    return route == 'ssh' if route else (getattr(host, 'command', None) or [None])[0] == '/usr/bin/ssh'


def left_for_later(results, required):
    """The required hosts of a finished rollout that ended deferred, for --require-all."""
    return [name for name in required if isinstance(results.get(name), dict)
            and results[name].get('result') == DEFERRED]


def require_all(later, version):
    """Why --require-all (release.sh before it finalizes a candidate) exits 1 on deferred hosts."""
    return ('%s left for later, and --require-all needs every required host on %s: run it again once '
            '%s quiet (the request stays in place). Its owner\'s setting, not a failure'
            % (' and '.join(later), version, 'it is' if len(later) == 1 else 'they are'))


def look(hold):
    """(policy, answer) from one look at the service through `hold` (service_hold.ServiceHold or a
    fake): 'on' or 'off' as it reports the setting, 'legacy' when it answered without it or its CLI
    predates `service prepare-update` (nothing is known, so the old behaviour stands), 'unknown' when
    it did not answer (nothing may be paused on a guess). `answer` is None unless it answered."""
    try:
        answer = hold.look()
    except service_hold.HoldUnsupported:
        return LEGACY, None
    except service_hold.HoldUnavailable:
        return UNKNOWN, None
    value = pauses_work(answer)
    return (LEGACY if value is None else ON if value else OFF), answer


def service_policy(hold):
    """'on', 'off', 'legacy' or 'unknown' for the service behind `hold`; see look."""
    return look(hold)[0]


def allows_pause(policy):
    """True when the policy lets an update pause running work: on, or a service that predates it."""
    return policy in (ON, LEGACY)


def agent_waiting(refusal, policy):
    """The update agent's status line while it waits for quiet without pausing. It starts with the
    refusal's own text, which update_agent_pause.running_work matches on."""
    if policy == OFF:
        return '%s; the update installs once running work finishes, because "%s" is off on this Mac' % (refusal, SETTING)
    return ('%s; the update installs once running work finishes, because the SpecWithCode service did not say '
            'whether "%s" is on' % (refusal, SETTING))


def m4_idle_only(policy, deadline_minutes):
    """The rollout's one line when M4 is held only when idle: off, or a service that did not answer."""
    if policy == OFF:
        return ('m4: "%s" is off on M4, so M4 is held only when idle and nothing is interrupted; it is left '
                'for later if it is still busy after %d min' % (SETTING, DEFER_SECONDS // 60))
    return ('m4: "%s" could not be read from M4\'s service, so M4 is held only when idle and nothing is '
            'interrupted; it fails as before if it has not installed within %d min' % (SETTING, deadline_minutes))


def describe_blockers(reply):
    """What keeps the service busy, as its prepare answer names it: each blocker by kind and thread,
    marked when it only waits on a person, then terminals and folder copies."""
    parts = []
    for blocker in reply.get('blockers') or []:
        if not isinstance(blocker, dict):
            continue
        parts.append('%s %s%s%s' % (
            blocker.get('count'), blocker.get('kind'),
            ' (%s)' % blocker['threadTitle'] if blocker.get('threadTitle') else '',
            ' waiting on a person' if blocker.get('waitsOnPerson') is True else ''))
    for key, one, many in (('openTerminals', 'open terminal', 'open terminals'),
                           ('folderCopies', 'folder copy', 'folder copies')):
        count = reply.get(key)
        if type(count) is int and count > 0:
            parts.append('%d %s' % (count, one if count == 1 else many))
    return ', '.join(parts) or 'nothing it names'


def busy(status, refused=None):
    """What running work keeps a host from installing, from the host's own answer, else None: M4's
    idle-only hold refused (`refused`, describe_blockers), a Mac agent waiting for quiet
    over running work (its message starts with RUNNING_WORK), or a Linux boot service that gave up
    busy. An error, a download, a folder copy or a check that timed out is no such evidence."""
    if refused:
        return refused
    if status.get('method') == 'boot-service':
        gave_up = status.get('phase') == 'failed' and status.get('lastErrorReason') == 'busy'
        return (status.get('lastError') or 'it stayed busy') if gave_up else None
    message = status.get('message') or ''
    return message if status.get('status') == 'waiting-for-quiet' and message.startswith(RUNNING_WORK) else None


def deferral(identity, version, status, allowed, elapsed, deadline, started, took=False, refused=None, asked=True):
    """Why the rollout leaves a host for later now, or None. Only with the setting off (`allowed`
    False), only while nothing started (`started`, a one-item list kept across polls: a hold taken,
    an install seen) and only on busy evidence: a Linux boot service's own give-up at once, anything
    else from DEFER_SECONDS (or the host's deadline, if shorter). Everything else waits for the
    host's full deadline and fails there as before. `asked` False: this rollout has not asked the
    host yet, so a Linux give-up it still shows is an earlier request's and no evidence."""
    linux = status.get('method') == 'boot-service'
    started[0] = started[0] or took or status.get('status') == 'installing' or (
        linux and status.get('phase') in ('draining', 'installing', 'handed-off'))
    why = busy(status, refused) if allowed is False and not started[0] and (asked or not linux) else None
    if why is None or (not linux and elapsed < min(deadline, DEFER_SECONDS)):
        return None
    return deferred_reason(identity, version, status.get('version'), why)


def deferred_reason(identity, version, current, busy=None):
    """Why a host ends `deferred`: it names the machine and the setting, says it stays on its version
    until it is quiet by its owner's choice, and that this is reported as a fact, not a blocker."""
    return ('%s is left on %s until it is quiet: "%s" is off on %s, so %s is not installed over its running '
            'work%s. This is its owner\'s setting, not a failure; report it as a fact, not a blocker'
            % (identity, current or 'its version', SETTING, identity, version, ' (%s)' % busy if busy else ''))


def deferred_row(identity, reason, route=None, app=False):
    """The rollout row of a deferred host. `app`: a Mac worker whose desktop app step would have
    run or been reported skipped; its app is left for later too, reported like any skipped app step
    (desktopApp {result: skipped, reason}), which run_record.py records as the host's `desktop`."""
    row = {'identity': identity, 'result': DEFERRED, 'reason': reason}
    if route:
        row['route'] = route
    if app:
        row['desktopApp'] = {'result': 'skipped', 'reason': 'deferred: its service stays on its version until it '
                                                             'is quiet, so its app is left for later too'}
    return row


def summary_result(results, otherwise):
    """'deferred' when every host not on the version was deferred, or not asked behind a deferred M4,
    and at least one was; `otherwise` (the run's result without deferral) when anything else is left."""
    left = [row for row in results.values() if isinstance(row, dict)
            and row.get('result') not in ('installed', 'already-installed')]
    if any(row.get('result') == DEFERRED for row in left) and \
            all(row.get('result') == DEFERRED or row.get('reason') == M4_LATER for row in left):
        return DEFERRED
    return otherwise
