"""Settings continuity for owned Studio updates, proven without storing settings content.

A new release may rewrite `userdata/settings.json` when it starts: it decodes the file and
writes it back sparsely (values equal to its defaults left out) whenever a one-time migration
changes the settings. The bytes then differ although every setting the user made is kept.
This module compares the parsed settings instead.

`settings_proof` maps each JSON pointer of the file to `<kind>:<sha256>` of the canonical JSON
of its value (`o` for a non-empty object, `v` for every other value), so snapshots and
receipts carry key paths and hashes, never values. `assert_settings_preserved` requires every
value present before to be present and equal after. Keys a release adds are allowed. Anything
else must be explained by one of the documented migrations below, or the update fails and
rolls back.

Documented migrations (keep in sync with apps/server/src/serverSettings.ts loadSettingsFromDisk):

- `project-settings-simplified` (SpecWithCode 1.0.30, `simplifyProjectSettingsOverrides` in
  packages/shared/src/serverSettings.ts). Runs once, marked by `projectSettingsSimplified: true`,
  so it applies only to the update that adds the marker. Per project-scoped key, overrides equal
  to the app value are dropped, and a value every live project overrides identically becomes
  the app value. Verified here: the dropped overrides of a key all hold one value and no
  remaining override holds it, the app value after the update is that value as the server
  stores it (only its non-default parts), and the legacy per-project maps follow the overrides
  that remain. An override still present must be unchanged. The file leaves out app values
  equal to the release default and this helper does not know the defaults, so when neither file
  stores the app value (or the update removes it), an override dropped as equal to the default
  is accepted on the migration's own rule; that allowance ends with the update adding the marker.
- `secret-moved-to-store` (`moveInlineBitbucketTokens`): a Bitbucket or GitHub token typed
  into the file moves to the secret store and the file keeps the redaction placeholder.
"""
if not __debug__:
    raise RuntimeError('Optimized Python is unsupported for settings preservation checks')

import hashlib
import json

# More pointers than this and the file is compared byte for byte instead.
PROOF_LIMIT = 20000
# packages/contracts/src/settings.ts PROJECT_SCOPED_SERVER_SETTING_KEYS.
# Storage values are scoped within one machine's settings file. Including them
# here verifies same-machine update continuity; it never copies paths to a peer.
PROJECT_SCOPED_KEYS = frozenset((
    'agentInstructions', 'claudeWorkflowMode', 'responseStyle', 'worktreeCleanup', 'defaultModelSelection',
    'worktreeLocationMode', 'worktreesDirectory',
    'defaultModelProviders',
    'defaultRuntimeMode', 'defaultThreadEnvMode', 'newWorktreesStartFromOrigin', 'worktreeSubmodules',
    'defaultAutoPull', 'defaultProjectScripts', 'enableAgentBrowserAccess', 'agentBrowserProfileId',
    'enableAgentDeviceAccess', 'textGenerationModelSelection', 'sourceControlWriterModelSelection',
    'sourceControlWritingStyle', 'removeAgentCreditsOnMerge', 'branchNamingMode', 'branchNamePrefix',
    'branchNameInstructions', 'pullRequestMergeMethod', 'threadFinishAction', 'sidebarAutoSettleOnMerge',
    'sidebarAutoSettleAfterDays', 'continueThreadsAfterServerUpdate', 'responseStreamingMode',
    'providerLimitAction', 'providerLimitFallbackModelSelection', 'providerLimitFallbackModels', 'providerLimitFallbackListOnly', 'providerLimitExcludedModels',
    'providerLimitSwitchAtPercent',
    'providerLimitWaitUnderMinutes', 'providerLimitRedeemResets', 'autoApproveSubscriptionChange',
    'providerLimitSpendCredits',
    'providerLimitUseApiCredits', 'providerLimitMachineTargets', 'providerLimitTargetOrder',
    'providerLimitUnknownUsageEligible', 'taskRouting', 'modelLanes', 'learnedModelPreferences',
    'keepActiveThreadsPerProject'))
OVERRIDES = 'projectSettingsOverrides'
SIMPLIFIED_MARKER = '/projectSettingsSimplified'
# packages/shared/src/serverSettings.ts deriveLegacyProjectOverrides: legacy map -> override key.
LEGACY_PROJECT_MAPS = {'projectAgentBrowserAccessOverrides': 'enableAgentBrowserAccess',
                       'projectAutoPullOverrides': 'defaultAutoPull',
                       'projectScriptOverrides': 'defaultProjectScripts'}
# packages/contracts/src/settings.ts REDACTED_SECRET_MARKER (the server's SECRET_REDACTED)
# and apps/server/src/serverSettings.ts BITBUCKET_SECRET_FIELDS.
SECRET_REDACTED = '•' * 6
BITBUCKET_SECRET_FIELDS = ('accessToken', 'apiToken')


def _canonical_number(value):
    # JSON.stringify writes 1 for 1.0; both spellings are the same setting.
    if isinstance(value, float) and value.is_integer() and abs(value) < 2 ** 53:
        return int(value)
    return value


def _normalized(value):
    if isinstance(value, dict):
        return {key: _normalized(child) for key, child in value.items()}
    if isinstance(value, list):
        return [_normalized(child) for child in value]
    return _canonical_number(value)


def _node(value):
    kind = 'o' if isinstance(value, dict) and value else 'v'
    text = json.dumps(_normalized(value), sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    return kind + ':' + hashlib.sha256(text.encode('utf-8')).hexdigest()


def escape(key):
    return key.replace('~', '~0').replace('/', '~1')


def pointer(*parts):
    return ''.join('/' + escape(part) for part in parts)


def split(path):
    return [part.replace('~1', '/').replace('~0', '~') for part in path.split('/')[1:]]


TRUE_NODE = _node(True)
REDACTED_NODE = _node(SECRET_REDACTED)


def settings_proof(data):
    """Pointer -> node hash for every value in the settings file, or None when the file is not
    a JSON object (or too large); such a file is compared byte for byte."""
    try:
        value = json.loads(data)
        if not isinstance(value, dict):
            return None
        nodes, pending = {}, [('', value)]
        while pending:
            path, current = pending.pop()
            nodes[path] = _node(current)
            if len(nodes) > PROOF_LIMIT:
                return None
            if isinstance(current, dict):
                pending.extend((path + '/' + escape(key), child) for key, child in current.items())
        return nodes
    except (ValueError, TypeError, RecursionError, UnicodeDecodeError):
        return None


def _valid(proof):
    return (isinstance(proof, dict) and '' in proof
            and all(isinstance(key, str) and isinstance(value, str) and value[:2] in ('o:', 'v:')
                    for key, value in proof.items()))


def _subtree(proof, base):
    """Leaves at or under `base`, keyed by their path relative to it."""
    return {path[len(base):]: value for path, value in proof.items()
            if value.startswith('v:') and (path == base or path.startswith(base + '/'))}


def _sparse_encoding_of(after, app, before, override):
    """Whether the app value after the update is `override` as the server stores it: absent
    (the release default), or only parts that equal the same parts of the override."""
    if app not in after:
        # These storage defaults are known: the directory defaults to empty,
        # while the optional placement mode has no encoded default. An absent
        # app value cannot explain losing an explicit local path or mode.
        if app == pointer('worktreesDirectory'):
            return before.get(override) == _node('')
        if app == pointer('worktreeLocationMode'):
            return False
        return True
    return all(before.get(override + rel) == value for rel, value in _subtree(after, app).items())


class _Simplified:
    """The `project-settings-simplified` migration, active only in the update adding its marker."""

    def __init__(self, before, after):
        self.active = after.get(SIMPLIFIED_MARKER) == TRUE_NODE and before.get(SIMPLIFIED_MARKER) != TRUE_NODE
        self.dropped = {}  # key -> {project: override node} dropped by this update
        if not self.active:
            return
        for path, value in before.items():
            parts = split(path)
            if len(parts) == 3 and parts[0] == OVERRIDES and parts[2] in PROJECT_SCOPED_KEYS and path not in after:
                self.dropped.setdefault(parts[2], {})[parts[1]] = value
        remaining = {}  # key -> override nodes still present after the update
        for path, value in after.items():
            parts = split(path)
            if len(parts) == 3 and parts[0] == OVERRIDES:
                remaining.setdefault(parts[2], set()).add(value)
        self.keys = {}
        for key, overrides in self.dropped.items():
            values = set(overrides.values())
            project = sorted(overrides)[0]
            # One value V was the app value: every override equal to it goes, none other does.
            self.keys[key] = (len(values) == 1 and not values & remaining.get(key, set())
                              and _sparse_encoding_of(after, pointer(key), before, pointer(OVERRIDES, project, key)))
        self.after = after

    def explains(self, parts):
        if not self.active or not parts:
            return False
        if parts[0] == OVERRIDES and len(parts) >= 3 and parts[2] in self.dropped:
            return parts[1] in self.dropped[parts[2]] and self.keys[parts[2]]
        if parts[0] in PROJECT_SCOPED_KEYS:
            # The app value moved only to a value every dropped override held.
            return self.keys.get(parts[0], False)
        if parts[0] in LEGACY_PROJECT_MAPS and len(parts) >= 2:
            # Derived from the remaining overrides: gone together with the override it mirrored.
            key = LEGACY_PROJECT_MAPS[parts[0]]
            return (pointer(parts[0], parts[1]) not in self.after
                    and pointer(OVERRIDES, parts[1], key) not in self.after)
        return False

    def report(self):
        return {'droppedOverrides': sum(len(value) for value in self.dropped.values()),
                'keys': sorted(self.dropped)}


def _secret_moved(parts, after, path):
    return (after.get(path) == REDACTED_NODE
            and ((len(parts) == 2 and parts[0] == 'bitbucket' and parts[1] in BITBUCKET_SECRET_FIELDS)
                 or (len(parts) == 3 and parts[:2] == ['github', 'tokens'])))


def assert_settings_preserved(before, after):
    """Every setting value present before is present and equal after, except as a documented
    migration explains. Returns a content-free report; raises AssertionError naming the
    changed key paths (never their values)."""
    assert _valid(before) and _valid(after), 'Settings proof is malformed'
    lost = sorted(path for path, value in before.items() if value.startswith('v:') and after.get(path) != value)
    simplified = _Simplified(before, after)
    migrations, unexplained, secrets = {}, [], 0
    for path in lost:
        parts = split(path)
        if _secret_moved(parts, after, path):
            secrets += 1
        elif not simplified.explains(parts):
            unexplained.append(path)
    if unexplained:
        shown = ', '.join(unexplained[:8]) + (' (+%d more)' % (len(unexplained) - 8) if len(unexplained) > 8 else '')
        raise AssertionError('User settings changed or disappeared after restart: ' + shown)
    if simplified.active:
        migrations['project-settings-simplified'] = simplified.report()
    if secrets:
        migrations['secret-moved-to-store'] = {'values': secrets}
    added = sum(1 for path, value in after.items() if value.startswith('v:') and path not in before)
    return {'result': 'preserved', 'changedValues': len(lost), 'addedValues': added, 'migrations': migrations}
