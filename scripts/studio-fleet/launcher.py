"""Exact CLI launcher format: clean credentials, deliberate bootstrap preference only."""
import os
import pathlib
import shlex
import uuid

# Second launcher name for the same CLI entry (docs/studio/naming.md). The
# `specweave-studio` wrapper stays the identity the receipts and services use.
CLI_ALIAS = 'specwithcode'


def legacy_runtime_path(home, node):
    return ':'.join([str(node.parent), str(home / '.local/share/specweave/providers/bin'),
                     '/usr/bin', '/bin', '/usr/sbin', '/sbin'])


def runtime_path(home, node):
    """Explicit local toolchains for Git hooks and agent tools; never inherit PATH."""
    assert home.is_absolute() and node.is_absolute()
    assert all(':' not in str(path) and '\n' not in str(path) and '\r' not in str(path) for path in (home, node)), 'Toolchain path cannot contain PATH delimiters'
    return ':'.join(dict.fromkeys([str(node.parent), str(home / '.local/share/specweave/providers/bin'),
                                  str(home / '.local/bin'), '/opt/homebrew/bin', '/opt/homebrew/sbin',
                                  '/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']))


def migrate_runtime_path(prefix, home, node):
    """Only migrate the two known owned-service templates, never a custom PATH."""
    assert prefix[:2] == ['/usr/bin/env', '-i'] and prefix[-2] == str(node)
    indices = [index for index, part in enumerate(prefix[:-2]) if part.startswith('PATH=')]
    assert len(indices) == 1, 'Owned launcher must contain exactly one PATH'
    index = indices[0]
    assert prefix[index][5:] in {legacy_runtime_path(home, node), runtime_path(home, node)}, 'Custom launcher PATH requires operator review'
    result = list(prefix)
    result[index] = 'PATH=' + runtime_path(home, node)
    return result


# The wrapper passes the name it was run as, so `specwithcode --version` says
# specwithcode. Both launchers keep byte-identical text; the CLI accepts only the two names.
CLI_NAME_ARGUMENT = '"STUDIO_CLI_NAME=${0##*/}"'
_CLI_NAME_TOKEN = 'STUDIO_CLI_NAME=${0##*/}'


def _render_cli(prefix, name):
    assert prefix[:2] == ['/usr/bin/env', '-i']
    environment = [part for part in prefix[:-2] if not part.startswith('STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=')]
    command = prefix[-2:]
    plain = ' '.join(shlex.quote(part) for part in environment) + name + ' ' + ' '.join(shlex.quote(part) for part in command)
    deliberate = ' '.join(shlex.quote(part) for part in environment) + ' "STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=$STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD"' + name + ' ' + ' '.join(shlex.quote(part) for part in command)
    return '#!/bin/sh\nset -eu\numask 077\n' + \
        'if [ "${STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD+x}" = x ]; then\n' + \
        '  case "$STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD" in true|false) ;; *) exit 2 ;; esac\n' + \
        '  exec ' + deliberate + ' "$@"\nfi\nexec ' + plain + ' "$@"\n'


def render_cli(prefix):
    return _render_cli(prefix, ' ' + CLI_NAME_ARGUMENT)


def render_unnamed_cli(prefix):
    """The wrapper text Studio 0.2.7 and earlier wrote: recognised as ours, never written."""
    return _render_cli(prefix, '')


def render_legacy_cli(prefix):
    """The first wrapper format, without the bootstrap preference: recognised, never written."""
    return '#!/bin/sh\nset -eu\numask 077\nexec ' + ' '.join(shlex.quote(part) for part in prefix) + ' "$@"\n'


def is_studio_wrapper(value, home):
    """True for any wrapper text a Studio installer or update wrote (any of the three formats)
    that runs a release under this home's releases directory. Such a launcher may still name
    an older, possibly deleted release, and an update may replace it."""
    try:
        text = value.decode()
        lines = text.split('\n')
        if len(lines) < 5 or lines[-1] != '' or lines[:3] != ['#!/bin/sh', 'set -eu', 'umask 077']:
            return False
        last = lines[-2]
        if not (last.startswith('exec ') and last.endswith(' "$@"')):
            return False
        prefix = [part for part in shlex.split(last[len('exec '):-len(' "$@"')]) if part != _CLI_NAME_TOKEN]
    except (UnicodeDecodeError, ValueError):
        return False
    if len(prefix) < 4 or prefix[:2] != ['/usr/bin/env', '-i']:
        return False
    if not all('=' in part and not part.startswith('=') for part in prefix[2:-2]):
        return False
    node, entry = pathlib.PurePosixPath(prefix[-2]), pathlib.PurePosixPath(prefix[-1])
    releases = pathlib.PurePosixPath(str(home)) / '.local/share/specweave-studio/releases'
    if not node.is_absolute() or entry.name != 'bin.mjs' or entry.parent.parent != releases \
            or entry.parent.name in {'', '.', '..'}:
        return False
    return text in {render_cli(prefix), render_unnamed_cli(prefix), render_legacy_cli(prefix)}


def _owned_value(path, owned):
    """The bytes at `path` when it is a regular file (never a link) whose text `owned`
    accepts; None otherwise. `owned` is a collection of exact texts or a predicate."""
    try:
        if path.is_symlink() or not path.is_file():
            return None
        value = path.read_bytes()
    except OSError:  # An unreadable file is not ours either.
        return None
    accepted = owned(value) if callable(owned) else value in owned
    return value if accepted else None


def cli_alias_state(alias, owned):
    """('absent', None), ('owned', bytes) when the alias holds a text `owned` accepts (a
    collection of exact texts or a predicate), or ('foreign', None) for anything else,
    which is never touched."""
    try:
        if not alias.is_symlink() and not alias.exists():
            return 'absent', None
    except OSError:
        return 'foreign', None
    value = _owned_value(alias, owned)
    return ('owned', value) if value is not None else ('foreign', None)


def swap_cli_alias(alias, content, owned, *, create=True, report=None):
    """Put `content` (bytes, or None to remove) at `alias` only if the entry actually
    replaced is absent or holds a text `owned` accepts. Ownership is decided on that very
    entry, not on an earlier look: whatever is at the name is first moved aside to a private
    name in the same directory (rename never follows a link), checked there, and put back
    as the same file when it is not ours. Nothing foreign is written through, replaced or
    deleted. With create=False an absent alias stays absent.

    Returns (outcome, previous): outcome is 'created', 'replaced', 'removed', 'absent',
    'foreign' or 'foreign-kept-aside' (the put-back lost a race; the entry waits at the path
    stored as report['keptAside'] when a `report` dict is given); previous is the replaced
    owned bytes, when there were any."""
    token = uuid.uuid4().hex
    staged = alias.with_name('.' + alias.name + '.studio-new-' + token)
    aside = alias.with_name('.' + alias.name + '.studio-old-' + token)

    def link_new():
        os.link(str(staged), str(alias), follow_symlinks=False)  # Fails if anything is there.

    def discard_aside():
        # The decision is made; a leftover second link is untidy, not a failure.
        try:
            os.unlink(str(aside))
        except OSError:
            pass

    def put_back():
        """Return the moved-aside entry to the name as the same file; never over anything."""
        try:
            os.link(str(aside), str(alias), follow_symlinks=False)
        except FileExistsError:
            return False
        except OSError:  # A directory cannot be hard-linked; move it back while the name is free.
            if os.path.lexists(str(alias)):
                return False
            os.rename(str(aside), str(alias))
            return True
        discard_aside()
        return True

    def kept_aside():
        if report is not None:
            report['keptAside'] = str(aside)
        return 'foreign-kept-aside', None

    try:
        if content is not None:
            # Inside the try: a failed write or chmod still removes the staged file.
            descriptor = os.open(str(staged), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700)
            with os.fdopen(descriptor, 'wb') as handle:
                handle.write(content)
            os.chmod(str(staged), 0o700)
        if content is not None and create:
            try:
                link_new()
                return 'created', None
            except FileExistsError:
                pass
        try:
            if os.path.isdir(str(alias)) and not os.path.islink(str(alias)):
                return 'foreign', None  # Never move a directory, even briefly.
            os.rename(str(alias), str(aside))
        except FileNotFoundError:
            if content is None or not create:
                return 'absent', None
            try:
                link_new()
                return 'created', None
            except FileExistsError:
                return 'foreign', None
        try:
            previous = _owned_value(aside, owned)
            if previous is None:
                return ('foreign', None) if put_back() else kept_aside()
            if content is None:
                discard_aside()
                return 'removed', previous
            try:
                link_new()
            except FileExistsError:
                # Another tool took the name meanwhile: theirs stays. Ours is in the backup.
                discard_aside()
                return 'foreign', previous
        except BaseException:
            # Whatever failed, the entry that was there goes back if the name is still free.
            if os.path.lexists(str(aside)):
                try:
                    put_back()
                except OSError:
                    pass
            raise
        discard_aside()
        return 'replaced', previous
    finally:
        if os.path.lexists(str(staged)):
            os.unlink(str(staged))
