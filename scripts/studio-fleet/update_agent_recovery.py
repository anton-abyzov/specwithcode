"""Verified, bounded release-chain selection and non-mutating automatic retry policy.

Stdlib only; imported by update_agent and copied beside every installed agent. An
unsupported predecessor is the only reason to consider an older release. Receipt
text alone never authorizes another automatic apply. Also holds an automatic pass's quiet
decision and the agent's failed-install receipt readers and writer, moved here from
update_agent.py (file-size cap).
"""
import datetime
import json
import os
import pathlib
import stat
import sys

FEED_LIMIT = 30
MAX_ATTEMPTS = 3  # Initial apply and at most two later automatic retries.
BACKOFF_SECONDS = 600
RETRY_WINDOW_SECONDS = 86400
# update.py rollback outcomes that leave the previous release on its own pointers and state.
CLEAN_ROLLBACKS = ('restored-runtime-pointers-and-state', 'restored-exact-owned-runtime-pointers')


def _ua(agent):
    return sys.modules[type(agent).__module__]


def binding(agent, meta):
    return {'schemaVersion': 1, 'api': agent.api_base(), 'repository': agent.config['repository'],
            'identity': agent.identity, 'studioHome': str(agent.own),
            'installedVersion': agent.inst['version'], 'installedSourceCommit': agent.inst['sourceCommit'],
            'version': meta['version'], 'planSha256': meta.get('planSha256'), 'assets': meta['assets']}


def _metadata(agent, release):
    ua = _ua(agent)
    version = ua.tag_version(release['tag_name'])
    assets = {}
    raw_assets = release.get('assets')
    ua._refuse_if(not isinstance(raw_assets, list), 'Release assets are malformed')
    ids = set()
    for asset in raw_assets:
        ua._refuse_if(not isinstance(asset, dict) or not ua._safe_name(asset.get('name'))
                      or type(asset.get('id')) is not int or asset['id'] <= 0
                      or asset['name'] in assets or asset['id'] in ids,
                      'Release assets are malformed or ambiguous')
        size = asset.get('size')
        ua._refuse_if(size is not None and (type(size) is not int or size < 0), 'Release asset size is invalid')
        assets[asset['name']] = {'id': asset['id'], 'size': size}
        ids.add(asset['id'])
    meta = {'schemaVersion': 1, 'tag': release['tag_name'], 'version': version, 'assets': assets,
            'plan': None, 'planSha256': None, 'args': None, 'manual': None, 'rejected': None,
            'checkedAt': agent.state['checkedAt']}
    directory = ua.ensure_dir(agent.release_dir(version), agent.home)
    if ua.PLAN_ASSET not in assets:
        meta['manual'] = 'SpecWithCode %s needs a manual upgrade: the release has no update plan.' % version
    else:
        data = agent.fetch_bytes(agent.asset_url(assets[ua.PLAN_ASSET]), 'application/octet-stream',
                                 ua.LIMITS[ua.PLAN_ASSET])
        try:
            plan = json.loads(data.decode('utf-8'))
        except (UnicodeDecodeError, ValueError):
            raise ua.AgentError('Update plan was rejected: not valid JSON') from None
        ua.validate_plan(plan, version)
        for name in (plan['service']['runtime']['asset'], plan['service']['helpers']['asset'], ua.SUMS_ASSET):
            ua._refuse_if(name not in assets, 'Release %s is missing %s' % (release['tag_name'], name))
        # Verify the candidate's published checksum bindings before allowing predecessor
        # incompatibility to skip it. Actual archive bytes are verified before any apply.
        agent.download_asset(ua.SUMS_ASSET, assets[ua.SUMS_ASSET], directory / ua.SUMS_ASSET,
                             ua.LIMITS[ua.SUMS_ASSET])
        sums = ua.parse_sums(ua.read_owned(directory / ua.SUMS_ASSET, agent.home, ua.LIMITS[ua.SUMS_ASSET]))
        digest = ua.sha256_bytes(data)
        ua._refuse_if(ua.PLAN_ASSET in sums and sums[ua.PLAN_ASSET] != digest,
                      'Update plan checksum does not match the release')
        for entry in (plan['service']['runtime'], plan['service']['helpers']):
            ua._refuse_if(sums.get(entry['asset']) != entry['sha256'],
                          'Release archive checksum does not match its update plan')
        meta.update(plan=plan, planSha256=digest)
        ua.atomic_write(directory / ua.PLAN_ASSET, data, agent.home)
        try:
            meta['args'] = ua.select_upgrade(plan, agent.inst['sourceCommit'])
        except ua.ManualRequired as error:
            meta['manual'] = error.message
    meta['binding'] = binding(agent, meta)
    ua.write_json(directory / 'release.json', meta, agent.home)
    return meta


def check(agent):
    ua, repository = _ua(agent), agent.config['repository']
    try:
        body = agent.fetch_bytes('%s/repos/%s/releases?per_page=30' % (agent.api_base(), repository),
                                 'application/vnd.github+json', ua.LIMITS['list'])
    except ua.HttpFailure as error:
        if error.code in (401, 403, 404) and not agent.token():
            raise ua.AgentError(ua.SIGN_IN) from None
        raise ua.AgentError('GitHub refused access to %s releases (HTTP %d). Check that `gh auth login` '
                            'can read the repository.' % (repository, error.code)) from None
    try:
        releases = json.loads(body.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        raise ua.AgentError('GitHub returned an unreadable releases response') from None
    ua._refuse_if(not isinstance(releases, list) or len(releases) > FEED_LIMIT,
                  'GitHub returned an unexpected bounded releases response')
    ranked = []
    seen = set()
    installed = ua.version_tuple(agent.inst['version'])
    current_present = False
    for release in releases:
        if not isinstance(release, dict) or release.get('draft'):
            continue
        version = ua.tag_version(release.get('tag_name'))
        if version is None or ua.version_tuple(version) < installed:
            continue
        ua._refuse_if(version in seen, 'The release feed contains ambiguous duplicate versions')
        seen.add(version)
        if ua.version_tuple(version) == installed:
            current_present = True
        else:
            ranked.append((ua.version_tuple(version), release))
    ranked.sort(key=lambda item: item[0], reverse=True)
    agent.state['checkedAt'] = ua.iso(ua.utcnow())
    if not ranked:
        agent.clear_available()
        if len(releases) == FEED_LIMIT and not current_present:
            raise ua.ManualRequired('Discovery is limited to the newest 30 releases; no newer supported '
                                    'release was found. Check the release feed or upgrade manually.')
        return None
    selected, chosen = None, None
    for _, release in ranked:
        meta = _metadata(agent, release)  # Integrity/network failures propagate; never fall back.
        if selected is None:
            selected, chosen = meta, release
        if meta['plan'] is None:  # Missing plans do not prove a compatible chain.
            selected, chosen = meta, release
            break
        if meta['args'] is not None:
            selected, chosen = meta, release
            break
    if selected['manual'] and selected['plan'] is not None:
        selected['manual'] += (' No compatible intermediate was found in the newest 30 releases; '
                               'check the release feed or upgrade manually.')
        ua.write_json(agent.release_dir(selected['version']) / 'release.json', selected, agent.home)
    if agent.state.get('availableVersion') != selected['version']:
        agent.state['downloadedVersion'] = None
    notes, published = chosen.get('body'), chosen.get('published_at')
    agent.state.update(availableVersion=selected['version'], availableTag=selected['tag'],
                       availableNotes=notes[:ua.NOTES_LIMIT] if isinstance(notes, str) else None,
                       availablePublishedAt=published[:64] if isinstance(published, str) else None)
    return selected


def load_release(agent, version):
    ua = _ua(agent)
    if ua.version_tuple(version) is None:
        return None
    try:
        meta = ua.read_json(agent.release_dir(version) / 'release.json', agent.home)
        if (not isinstance(meta, dict) or meta.get('version') != version or not isinstance(meta.get('assets'), dict)
                or meta.get('binding') != binding(agent, meta)):
            return None
        if meta.get('plan') is not None:
            ua.validate_plan(meta['plan'], version)
            data = ua.read_owned(agent.release_dir(version) / ua.PLAN_ASSET, agent.home, ua.LIMITS[ua.PLAN_ASSET])
            if ua.sha256_bytes(data) != meta.get('planSha256') or json.loads(data) != meta['plan']:
                return None
            try:
                if meta.get('args') != ua.select_upgrade(meta['plan'], agent.inst['sourceCommit']):
                    return None
            except ua.ManualRequired:
                if not meta.get('manual') or meta.get('args') is not None:
                    return None
        return meta
    except (ua.AgentError, OSError, ValueError, KeyError, TypeError):
        return None


def verified_matches(agent, meta, verified):
    ua = _ua(agent)
    try:
        plan = meta['plan']
        return (meta.get('binding') == binding(agent, meta) and verified.get('binding') == meta['binding']
                and verified.get('sourceCommit') == plan['sourceCommit']
                and verified.get('entrypoint') == ua.ENTRYPOINT
                and verified.get('args') == ua.select_upgrade(plan, agent.inst['sourceCommit'])
                and verified.get('runtime') == plan['service']['runtime']
                and verified['helpers']['sha256'] == plan['service']['helpers']['sha256']
                and verified['helpers']['root'] == plan['service']['helpers']['root'])
    except (ua.AgentError, KeyError, TypeError):
        return False


def installation_fingerprint(agent):
    """Hash the exact installation record and every runtime pointer without following links."""
    ua = _ua(agent)
    paths = [agent.own / 'installation.json', agent.own / 'launch.sh',
             agent.home / '.local/bin/specweave-studio',
             agent.home / 'Library/LaunchAgents' / (agent.inst['label'] + '.plist')]
    result = {}
    try:
        current = ua.load_installation(agent.home, agent.identity)
        if current != agent.inst:
            return None
        for path in paths:
            data = ua.read_owned(path, agent.home, 1 << 20)  # Every primary pointer must exist.
            result[str(path.relative_to(agent.home))] = {'sha256': ua.sha256_bytes(data),
                                                        'mode': stat.S_IMODE(os.lstat(str(path)).st_mode)}
        alias = agent.home / '.local/bin/specwithcode'
        ua.owned(alias.parent, agent.home)
        if not os.path.lexists(str(alias)):
            result['alias'] = {'kind': 'missing'}
        elif alias.is_symlink():
            result['alias'] = {'kind': 'symlink', 'target': os.readlink(str(alias))}
        else:
            result['alias'] = {'kind': 'file', 'sha256': ua.sha256_bytes(ua.read_owned(alias, agent.home, 1 << 20)),
                               'mode': stat.S_IMODE(os.lstat(str(alias)).st_mode)}
        return result
    except (ua.AgentError, OSError):
        return None


def refused_before_restart(agent, receipt, version):
    """The helper stopped before restarting the service because work or a process beneath it
    changed after the snapshot, and every pointer is as it was: running it again is safe."""
    ua = _ua(agent)
    try:
        value = ua.read_json(receipt, agent.home, ua.LIMITS['receipt'])
        inst = ua.load_installation(agent.home, agent.identity)
    except ua.AgentError:
        return False
    error = value.get('error') if isinstance(value, dict) else None
    retryable = isinstance(error, str) and any(phrase in error for phrase in ua.RETRYABLE_REFUSALS + ua.PROCESS_REFUSALS)
    return (retryable and value.get('pointers') in ('unchanged', 'previous-release') and inst['version'] != version
            and not any(key in value for key in ('restartStartedAt', 'rollbackError', 'stateBackup')))


def refusal_proof(agent, receipt, before):
    ua = _ua(agent)
    try:
        path = ua.owned(pathlib.Path(receipt), agent.home)
        if path.parent != agent.updates / 'receipts':
            return None
        data = ua.read_owned(path, agent.home, ua.LIMITS['json'])
        value = json.loads(data)
        # Preflight is the only real helper phase with no pointer writes or rollback.
        # An explicit future refused_before_restart phase must carry the same proof.
        allowed = {'identity', 'phase', 'result', 'error', 'pointers'}
        if (not isinstance(value, dict) or set(value) - allowed or value.get('identity') != agent.identity
                or value.get('phase') not in ('preflight', 'refused_before_restart')
                or value.get('result') != 'update-failed' or value.get('pointers') != 'unchanged'
                or not isinstance(value.get('error'), str)
                or not any(value['error'].startswith('AssertionError: ' + reason)
                           for reason in ua.RETRYABLE_REFUSALS)
                or before is None or installation_fingerprint(agent) != before):
            return None
        return ua.sha256_bytes(data)
    except (ua.AgentError, OSError, ValueError, TypeError):
        return None


def record_refusal(agent, verified, receipt, before):
    ua, previous = _ua(agent), agent.state.get('automaticRetry')
    agent.state['automaticRetry'] = None  # An unknown failure never inherits prior permission.
    digest = refusal_proof(agent, receipt, before)
    if digest is None:
        return
    now = ua.utcnow()
    current = {'release': verified['binding'], 'installation': before}
    if previous is not None and (not isinstance(previous, dict) or previous.get('binding') != current
            or type(previous.get('attempts')) is not int or not 1 <= previous['attempts'] < MAX_ATTEMPTS
            or ua.parse_time(previous.get('firstAttemptAt')) is None):
        return  # Corrupt or mismatched persisted permission cannot start a fresh budget.
    previous = previous or {}
    attempts = previous.get('attempts', 0) + 1
    first = previous.get('firstAttemptAt', ua.iso(now))
    agent.state['automaticRetry'] = {
        'schemaVersion': 1, 'reason': 'refused_before_restart', 'binding': current,
        'attempts': attempts, 'firstAttemptAt': first,
        'nextAttemptAt': ua.iso(now + datetime.timedelta(seconds=BACKOFF_SECONDS * attempts)),
        'receipt': str(receipt), 'receiptSha256': digest, 'lastInstallAt': agent.state['lastInstall']['at'],
        'requestAt': agent.config['installRequestedAt'], 'cancelledAt': agent.config['installCancelledAt']}


def verified_transition(agent, last):
    """Only a positively verified target install can release an earlier failure hold."""
    return (last.get('version') == agent.inst['version']
            and last.get('sourceCommit') == agent.inst['sourceCommit']
            and not agent.failed_switch_stands(last))


def holds(agent, last):
    """A failed install that holds automatic installs until Install now. An install request the
    helper refused before the restart, with every pointer as it was, changed nothing: automatic
    installs go on, each needing its own quiet checks and bounded by record_refusal."""
    return (last.get('result') == 'failed' and last.get('refusedBeforeRestart') is not True
            and not verified_transition(agent, last))


def completion_proof(agent, receipt, source=None, previous_source=None):
    """Bind the persisted helper proof to the installation and attempted transition."""
    ua = _ua(agent)
    try:
        path = ua.owned(pathlib.Path(receipt), agent.home)
        if path.parent != agent.updates / 'receipts':
            return False
        value = ua.read_json(path, agent.home, ua.LIMITS['receipt'])
        installed = ua.read_json(agent.own / 'installation.json', agent.home)
        before, after = value.get('before'), value.get('after')
        return (value.get('phase') == 'verified' and value.get('result') != 'update-failed'
                and all(value.get(flag) is True for flag in ('preservedRowsAuthAndIdentity',
                        'originalServicesPreserved', 'onlyKnownOwnedServiceRestarted'))
                and isinstance(before, dict) and isinstance(after, dict)
                and all(part.get('schemaVersion') == 1 and part.get('identity') == agent.identity
                        and part.get('serviceLabel') == agent.inst['label'] for part in (before, after))
                and isinstance(before.get('artifactSourceCommit'), str)
                and ua.HEX40.fullmatch(before['artifactSourceCommit']) is not None
                and (previous_source is None or before['artifactSourceCommit'] == previous_source)
                and after.get('artifactSourceCommit') == (source or agent.inst['sourceCommit'])
                and after.get('artifactSourceCommit') == installed.get('sourceCommit')
                and isinstance(after.get('archiveSha256'), str)
                and ua.HEX64.fullmatch(after['archiveSha256']) is not None
                and after['archiveSha256'] == installed.get('archiveSha256'))
    except (ua.AgentError, OSError, ValueError, KeyError, TypeError, AttributeError):
        return False


def current_installation_matches(agent, verified):
    """Snapshots do not establish the plan's predecessor; check it again at execution."""
    ua = _ua(agent)
    try:
        return (ua.load_installation(agent.home, agent.identity) == agent.inst
                and verified['binding'] == binding(agent, verified['binding']))
    except (ua.AgentError, OSError, KeyError, TypeError):
        return False


def newer_release_after_rollback(agent, verified):
    """A failed install holds automatic installs of its version until Install now. A newer
    release ships its own helpers, which may fix what failed (1.0.30-1.0.32 stopped at a
    byte-exact settings.json check after a one-time settings migration), so it gets one
    automatic attempt; if that fails too, the hold moves to it. Only after a complete
    rollback: the helper receipt shows the previous release's pointers (and state) restored
    and no rollback error, and the installation is the one that attempt started from."""
    ua = _ua(agent)
    last = agent.state.get('lastInstall') or {}
    try:
        failed, offered = ua.version_tuple(last.get('version')), ua.version_tuple(verified['version'])
        if (last.get('result') != 'failed' or failed is None or offered is None or offered <= failed
                or last.get('previousSourceCommit') != agent.inst['sourceCommit']
                or verified['binding']['installedSourceCommit'] != agent.inst['sourceCommit']):
            return False
        path = ua.owned(pathlib.Path(last['receipt']), agent.home)
        if path.parent != agent.updates / 'receipts':
            return False
        value = ua.read_json(path, agent.home, ua.LIMITS['receipt'])
        if not isinstance(value, dict):
            return False
        # Preflight refusals (a busy service) keep their own bounded budget; see record_refusal.
        return (value.get('identity') == agent.identity and value.get('result') == 'update-failed'
                and value.get('pointers') == 'previous-release' and value.get('rollback') in CLEAN_ROLLBACKS
                and 'rollbackError' not in value and installation_fingerprint(agent) is not None)
    except (ua.AgentError, OSError, ValueError, KeyError, TypeError, AttributeError):
        return False


def automatic_retry(agent, verified):
    """None allows one fresh quiet/snapshot attempt; a message keeps the target held."""
    ua, record = _ua(agent), agent.state.get('automaticRetry')
    held = 'SpecWithCode %s did not install automatically; choose Install now to retry.' % verified['version']
    if newer_release_after_rollback(agent, verified):
        return None
    if not isinstance(record, dict):
        return held
    last = agent.state.get('lastInstall') or {}
    now, first, due = ua.utcnow(), ua.parse_time(record.get('firstAttemptAt')), ua.parse_time(record.get('nextAttemptAt'))
    attempts = record.get('attempts')
    fingerprint = installation_fingerprint(agent)
    digest = record.get('receiptSha256')
    valid = (record.get('schemaVersion') == 1 and record.get('reason') == 'refused_before_restart'
             and type(attempts) is int and 1 <= attempts < MAX_ATTEMPTS and first is not None and due is not None
             and first <= now and first <= due <= first + datetime.timedelta(seconds=RETRY_WINDOW_SECONDS)
             and now <= first + datetime.timedelta(seconds=RETRY_WINDOW_SECONDS)
             and record.get('requestAt') == agent.config['installRequestedAt']
             and record.get('cancelledAt') == agent.config['installCancelledAt']
             and fingerprint is not None and isinstance(digest, str) and ua.HEX64.fullmatch(digest) is not None
             and record.get('binding') == {'release': verified['binding'], 'installation': fingerprint}
             and record.get('receipt') == last.get('receipt') and record.get('lastInstallAt') == last.get('at')
             and refusal_proof(agent, record.get('receipt'), record['binding']['installation']) == record.get('receiptSha256'))
    if not valid:
        agent.state['automaticRetry'] = None
        return held
    if now < due:
        return 'A pre-restart refusal is held until %s before a fresh quiet check.' % record['nextAttemptAt']
    return None


def withdrawn(agent, version):
    """Re-reads the settings: the (status, message) ending the pass once the request is gone or changed.
    A newer request that may install `version` is taken on: agent.config becomes its settings, and a
    pass that owns no run claims the run that request names, so the pass ends that run too. It lapses
    by update_agent_run.ttl_until's clock, as at the start of a pass: a run's request at the run's deadline. One
    for a newer release than `version` (published after this pass checked) ends the pass and is not
    taken on (agent.newer_release names that release): the pass's run ends replaced, and run_once
    serves the request in a pass of its own, even after its last, whose fresh check finds that release."""
    ua = _ua(agent)
    try:
        config = ua.load_config(agent.updates, agent.home)
    except ua.AgentError:
        return None
    request = agent.config['installRequestedAt']
    if config['installRequestedAt'] not in (None, request) and not ua.install_cancelled(config) \
            and _for_a_newer_release(ua, config, version):
        agent.state['quietSince'] = None
        agent.newer_release = ua.update_request.bound(config)['version']
        return 'downloaded', None
    agent.config = config
    if config['installRequestedAt'] is not None and not ua.install_cancelled(config):
        agent.serving = config['installRequestedAt']  # Taken on or ended here: a failure from now on names it.
        if getattr(agent, 'run', None) is None:
            agent.run = ua.runs.claim(agent)  # Its run, if it names one: no later pass would claim it; this one
            if agent.run is not None:  # ends it, also when the request is turned down below.
                agent.run.mirror(agent.state['status'], agent.state['message'])
        return ua.update_request.replaced(request, config, agent.state, version, ua.utcnow(), ua.runs.ttl_until(agent))
    agent.state['handledInstallRequestAt'] = config['installRequestedAt'] or request
    agent.state['quietSince'] = None
    return 'downloaded', ua.CANCELLED


def _for_a_newer_release(ua, config, version):
    wanted = (ua.update_request.bound(config) or {}).get('version')
    return wanted is not None and (ua.version_tuple(wanted) or ()) > (ua.version_tuple(version) or ())


def asked_again(agent, version, serving):
    """True when the settings now hold a newer request than `serving` that may install `version`:
    Update now asked again while a snapshot for `serving` refused it, as a window does once it
    holds the work for a request whose stop held nothing. agent.config becomes its settings, so
    the pass serves it instead of writing that refusal, which the window and the service's hold
    would time against the newer request and take as its answer. A Cancel, a request for another
    version or one of a run (claimed afresh by run_once) changes nothing."""
    ua = _ua(agent)
    try:
        config = ua.load_config(agent.updates, agent.home)
    except ua.AgentError:
        return False
    if config['installRequestedAt'] in (None, serving) or ua.install_cancelled(config):
        return False
    if config.get('installRunId') or getattr(agent, 'run', None) is not None:
        return False
    # A copy of the state: replaced() settles a request it turns down, which is the next pass's to do.
    if ua.update_request.replaced(serving, config, dict(agent.state), version, ua.utcnow()) is not None:
        return False
    agent.config = config
    return True


SETTINGS_CHANGED = 'Automatic installation stopped because update settings changed.'


def _automatic_consent_changed(agent, current):
    return (not current['installAutomatically']
            or current['repository'] != agent.config['repository']
            or current['installRequestedAt'] != agent.config['installRequestedAt']
            or current['installCancelledAt'] != agent.config['installCancelledAt'])


def automatic_superseded(agent):
    """True when the settings on disk already end this automatic pass (automatic_withdrawn's
    settings check): a newer install request, a cancellation, installs turned off or another
    repository. Checked before the pass's snapshot, a full read of minutes on M4, so a request
    written meanwhile is served next (run_once) instead of after it. Changes no state; settings
    that do not load leave the decision to automatic_withdrawn after the snapshot."""
    ua = _ua(agent)
    try:
        return _automatic_consent_changed(agent, ua.load_config(agent.updates, agent.home))
    except ua.AgentError:
        return False


def automatic_withdrawn(agent, verified):
    """Re-read mutable consent immediately after snapshots and immediately before apply."""
    ua = _ua(agent)
    current = ua.load_config(agent.updates, agent.home)
    if _automatic_consent_changed(agent, current):
        agent.state['automaticRetry'] = None
        return 'downloaded', SETTINGS_CHANGED
    last = agent.state.get('lastInstall') or {}
    if holds(agent, last):
        held = automatic_retry(agent, verified)  # A slow snapshot can outlive the bounded retry window.
        if held:
            return 'error', held
    return None


def install_when_quiet(agent, verified, helper_dir, newest, snapshot, baseline_path, install_request):
    """An automatic pass's snapshot `newest`: apply once the kept baseline shows the same service and
    work for quietMinutes; otherwise keep the older matching baseline (or this one) and wait."""
    ua = _ua(agent)
    baseline = agent.read_snapshot(baseline_path) if os.path.lexists(str(baseline_path)) else None
    now = ua.utcnow()
    quiet = False
    same = (baseline is not None and baseline['servicePid'] == snapshot['servicePid']
            and ua.work_counts(baseline['rows']['counts']) == ua.work_counts(snapshot['rows']['counts']))
    if same:
        since = ua.parse_time(baseline['observedAt'])
        if since <= now + datetime.timedelta(minutes=5):
            quiet = now - since >= datetime.timedelta(minutes=agent.config['quietMinutes'])
        else:
            same = False  # A future-dated baseline cannot prove quiet time.
    if quiet:
        return agent.apply(verified, helper_dir, newest, baseline_path, install_request)
    if same:
        ua.remove_path(newest, agent.home)  # Keep the older matching baseline so quiet time accrues.
    else:
        os.replace(str(newest), str(baseline_path))
        baseline = snapshot
    agent.state['quietSince'] = baseline['observedAt']
    return agent.finish('waiting-for-quiet', 'Waiting for a quiet moment before installing SpecWithCode %s' % verified['version'])


def settle_interrupted(agent):
    """A pass that died while installing left a marker; record its outcome without retrying."""
    ua = _ua(agent)
    try:
        marker = ua.read_json(agent.marker_path, agent.home)
    except ua.AgentError:
        marker = None
    if not isinstance(marker, dict) or ua.version_tuple(marker.get('version')) is None:
        return None
    version = marker['version']
    outcome = 'ok' if agent.inst['version'] == version else 'interrupted'
    return agent.complete_install(version, marker.get('receipt'), outcome, marker.get('sourceCommit'),
                                  marker.get('previousSourceCommit'))


def disk_refusal(agent, receipt):
    """The apply's own refusal when the disk had no room for its pre-update backup: it
    stops in preflight with every pointer unchanged. None for any other failure."""
    ua = _ua(agent)
    try:
        value = ua.read_json(ua.owned(pathlib.Path(receipt), agent.home), agent.home) if receipt else None
    except (ua.AgentError, OSError):
        return None
    if not isinstance(value, dict) or value.get('phase') != 'preflight' or value.get('pointers') != 'unchanged':
        return None
    error = value.get('error')
    prefix = 'AssertionError: '
    if not isinstance(error, str) or not error.startswith(prefix + ua.DISK_REFUSAL):
        return None
    return error[len(prefix):].splitlines()[0][:200]


def ensure_failure_receipt(agent, version, receipt, current):
    """A helper that failed before writing its receipt still leaves one with its cause."""
    ua = _ua(agent)
    if not receipt:
        return
    try:
        path = ua.owned(pathlib.Path(receipt), agent.home)
        if os.path.lexists(str(path)):
            return
        log = ua.helper_log_path(path)
        ua.write_json(path, {'identity': agent.identity, 'version': version, 'result': 'update-failed',
                             'phase': 'preflight', 'exitOutcome': 'failed', 'stayedOn': current,
                             'helperLog': str(log) if os.path.lexists(str(log)) else None,
                             'stderrTail': ua.redact(ua.read_tail(log, agent.home))}, agent.home)
    except (OSError, ua.AgentError) as error:
        print(ua.runs.stamp('update-agent %s: could not write the failed-install receipt (%s)'
                            % (agent.identity, type(error).__name__)), file=sys.stderr)
