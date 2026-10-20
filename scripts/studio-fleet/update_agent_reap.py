"""Update now's fallback for update_agent.py: stop the processes a held service left behind.

"Update now" drains and holds the service, then the agent snapshots every RETRY_SECONDS
until update.py accepts it. A provider that never answers its interrupt, or a command left
running beneath a closed terminal, keeps every snapshot refusing until the hold ends. Once a
forced request has been refused for running work or leftover processes for REAP_AFTER, the
agent asks the verified helper (`update.py --reap`) to stop the processes it can prove belong
to the service (quiescence.reap_descendants), at most REAP_LIMIT times a request, REAP_AFTER
apart: each pass, and each newer request a pass takes on, starts a fresh count. Only refusals
a process can cause count: leftover processes, or running tasks and active sessions; open
questions and finishing steps do not. A request cancelled meanwhile is
never reaped for, and the helper itself refuses unless the running service is still held for
this very request (update.py assert_held). The agent itself still signals nothing, and
update.py's checks are unchanged: the next snapshot decides as before. A helper without `--reap` (an older release) fails the call,
which is ignored.

update_agent.py is at its file-size cap, so this lives beside it: install_launch_agent and
the desktop build (scripts/build-desktop-artifact.ts) copy it with the agent. Stdlib only,
Python 3.9 compatible, and it never imports update_agent (which runs as __main__ under
launchd): it reaches the agent's helpers through the module that defined the Agent.
"""
import datetime
import os
import pathlib
import re
import sys
import uuid

REAP_AFTER = datetime.timedelta(minutes=2)
REAP_LIMIT = 2
REAP_TIMEOUT = 120
REAPING = 'Stopping agent processes that did not finish, so the update can install'
COMPANIONS = ('update_agent_reap.py',)


def _agent_module(agent):
    return sys.modules[type(agent).__module__]


# Native-work counts a stopped process can clear: its run fails, its provider session ends.
PROCESS_WORK = re.compile(r'\b\d{1,6} (?:running task|active session)s?\b')


def _process_refusal(host, message):
    """True for a refusal a leftover process can cause. A timeout or a busy database has no
    process to stop; open questions and finishing steps wait on the person or the service."""
    work, descendants = host.WAITING_REASONS[0][1], host.WAITING_REASONS[1][1]
    if message.startswith(descendants):
        return True
    return message.startswith(work) and PROCESS_WORK.search(message[len(work):]) is not None


def held(agent):
    """True while updates/hold.json, which the service keeps while it holds itself for an update,
    has not expired. Only an update_agent.py from 1.0.60 or earlier calls it (it retried a forced
    apply refused for a process only then); kept because this module is written before the agent
    script it sits beside. update.py --reap checks the hold in full (assert_held)."""
    host = _agent_module(agent)
    try:
        hold = host.read_json(agent.updates / 'hold.json', agent.home)
    except (host.AgentError, OSError):
        return False
    ends = host.parse_time(hold.get('expiresAt')) if isinstance(hold, dict) else None
    return ends is not None and host.utcnow() < ends


def reset(agent, request, since=None):
    """A fresh reap budget for `request`, counted from `since` (else the pass's start). Runs at
    the start of every pass, since one Agent serves a second pass for a request that arrived
    while the first held the lock."""
    agent.reap_count, agent.reaped_at, agent.reap_request, agent.reap_since = 0, None, request, since


def _due(agent, host, refused, started):
    if agent.config.get('installMode') != 'force' or refused[0] != 'waiting-for-quiet':
        return False
    if not agent.config.get('installRequestedAt') or not _process_refusal(host, refused[1]):
        return False
    since = getattr(agent, 'reaped_at', None) or getattr(agent, 'reap_since', None) or started
    now = host.utcnow()
    # A reap never runs the pass past its retry window, which the service's hold is sized by.
    return (getattr(agent, 'reap_count', 0) < REAP_LIMIT and now - since >= REAP_AFTER
            and now + datetime.timedelta(seconds=REAP_TIMEOUT) < agent.retry_deadline(started))


def before_retry(agent, helper_dir, refused, started):
    """Runs before the next snapshot of a pending install request; returns how long to wait
    first. In a forced request that kept refusing for REAP_AFTER, it first has the verified
    helper stop the leftover processes; the helper's record is kept with the update receipts."""
    host = _agent_module(agent)
    # The caller has already ended the pass for a cancel written while the last snapshot ran.
    request = agent.config.get('installRequestedAt')
    if getattr(agent, 'reap_request', request) != request:  # A newer request this pass took on.
        reset(agent, request, host.utcnow())
    if _due(agent, host, refused, started):
        agent.reap_count = getattr(agent, 'reap_count', 0) + 1
        agent.reaped_at = host.utcnow()
        agent.set_status('waiting-for-quiet', REAPING)
        receipts = host.ensure_dir(agent.updates / 'receipts', agent.home)
        record = receipts / ('reap-%s-%s.json' % (host.stamp(), uuid.uuid4().hex[:8]))
        host.run_helper_process(agent.helper_command(helper_dir, ['--identity', agent.identity, '--reap', record,
                                                                    '--request', agent.config['installRequestedAt']]),
                                str(helper_dir), agent.helper_env(), REAP_TIMEOUT,
                                log_path=record.with_suffix('.log'), home=agent.home)
    return host.RETRY_SECONDS


def install_beside(script, home, same, write):
    """Write the companion modules beside the installed agent script, before the script, so an
    installed agent never runs without them. True when one was written."""
    written = False
    for name in COMPANIONS:
        source = pathlib.Path(os.path.abspath(__file__)).with_name(name).read_bytes()
        target = script.with_name(name)
        if not same(target, source):
            write(target, source, home, 0o600)
            written = True
    return written
