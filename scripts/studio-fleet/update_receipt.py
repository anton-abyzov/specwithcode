#!/usr/bin/env python3
"""The receipt update.py leaves when an update fails before it writes its own (phase 'preflight'),
and the bounded error text every failure receipt carries. Moved out of update.py, which
re-exports both names. Stdlib only."""
import json
import os


def describe_error(error):
    """Type and message of a failed proof, bounded; messages here never carry row content."""
    message = str(error)
    if len(message) > 2000:
        message = message[:2000] + '...'
    return type(error).__name__ + (': ' + message if message else '')

def write_preflight_failure(output, identity, error):
    """apply() writes its own receipt from phase 'prepared' on. A failure before that point
    (snapshot, prestate checks, staging, version gate, publish) leaves one here, so the
    updater's "See the update receipt" always names a real file. Never overwrites. Exactly
    these five keys, no timings: installed update agents (refusal_proof) refuse any other."""
    if output.exists() or output.is_symlink():
        return
    failure = {'identity': identity, 'phase': 'preflight', 'result': 'update-failed',
               'error': describe_error(error),
               'pointers': 'unchanged'}
    try:
        fd = os.open(str(output), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as handle:
            handle.write(json.dumps(failure, indent=2) + '\n')
    except OSError:
        pass  # The original error is what the caller needs; it is re-raised.
