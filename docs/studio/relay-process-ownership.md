# Relay ownership during updates

The service can run its Connect relay from the pinned managed tools directory,
PATH, or an explicit executable override. A running relay is infrastructure, but
its name and parent PID alone cannot distinguish it from work in a user terminal.

After its own successful spawn, `ManagedEndpointRuntime` records that exact child
through a trusted local helper. The private `userdata/relay-process.json` record
contains a version, installation home, lifecycle generation, service and child
kernel identities, executable paths and fixed relay arguments. It contains no
environment, connector token, authentication material or database payload.

On macOS, the identities include kernel birth time with microsecond precision,
UID, parent PID and executable path. Both processes must have no controlling
terminal: `e_tdev == NODEV`, no `PROC_FLAG_CTTY` or `PROC_FLAG_CONTROLT`, and no
terminal foreground process group. A terminal child that execs the same command
therefore does not become an owned relay.

The updater accepts a PATH or override relay only when the record and fresh kernel
observations agree. It verifies direct parentage, the owning UID, exact arguments,
no child processes, and at most one relay; it rereads both identities and the
record. Its existing process inventories bracket this check. Missing, stale,
ambiguous, aliased, writable or inconsistent proof leaves the update refused.
An unrelated daemon or user process receives no exemption and is never selected
for a signal by this protocol. The existing service restart owns the connector's
ordinary lifecycle.

Publication and generation-matched cleanup use atomic replacement and a private,
nonblocking writer lock. The local helper has a three-second execution limit.
Failure preserves the running connector and leaves admission fail closed. There
is no startup download, account change or connector restart. Non-macOS hosts do
not use this macOS update proof.

## First upgrade from an older runtime

The original managed-path proof remains supported. An older runtime already using
its own managed executable can update normally without a new receipt. An older
runtime running a PATH fallback cannot retroactively attest that child; it still
refuses without the original managed-path proof. Downloading newer updater helpers
does not fabricate ownership for the old runtime.

The generic relay installer currently returns an already available PATH executable
without reinstalling the managed asset. This ownership fix does not change that
selection policy. Once the new runtime runs, its actual PATH or override child can
be proved without a network repair or manual process intervention. The receipt is
local process ownership evidence within the application's existing same-user trust
boundary, not protection against an attacker who can rewrite the application and
all of its private files.
