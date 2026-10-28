"""Fleet worker inventory, read at runtime from a file kept outside the repository.

The inventory maps each worker identity to {"host": ..., "user": ..., "home": ...}.
Its path is $STUDIO_FLEET_HOSTS, else ~/.local/share/specweave/fleet/hosts.json.

A Linux worker (linux_rollout.py) is an entry with "os": "linux", plus "studioHome" (its absolute
STUDIO_HOME), "user" and "host" for the pinned fleet SSH key, or "sshConfig": true to reach "host"
as an alias of the M4's own ~/.ssh/config, and optionally "unit", which may only be studio.service:
the one unit `specweave-studio update` rewrites and restarts (cloud/bootService.ts). The
Mac rollout reads only the identities in PORTS and ignores every other entry.
"""
import json
import os
import pathlib
import re

ENV = 'STUDIO_FLEET_HOSTS'
DEFAULT = '~/.local/share/specweave/fleet/hosts.json'
# Owned loopback tunnel port and private HTTPS port for each worker identity.
PORTS = {'m1': (18319, 8443), 'm3': (28319, 8444)}


def inventory_path():
    return pathlib.Path(os.path.expanduser(os.environ.get(ENV) or DEFAULT))


LINUX_IDENTITY = re.compile(r'[a-z0-9][a-z0-9-]{0,31}')
SAFE_TEXT = re.compile(r'[A-Za-z0-9._@:/+-]{1,255}')


def read_inventory():
    path = inventory_path()
    try:
        hosts = json.loads(path.read_text())
    except FileNotFoundError:
        raise SystemExit('Fleet inventory not found at ' + str(path) + '; create it or set ' + ENV) from None
    except (OSError, ValueError):
        raise SystemExit('Fleet inventory at ' + str(path) + ' is unreadable or not JSON') from None
    return path, hosts


def load_hosts():
    path, hosts = read_inventory()
    for identity in PORTS:
        entry = hosts.get(identity) if isinstance(hosts, dict) else None
        if not isinstance(entry, dict) or not all(isinstance(entry.get(k), str) and entry[k] for k in ('host', 'user')):
            raise SystemExit('Fleet inventory at ' + str(path) + ' lacks host and user for ' + identity)
    return hosts


def worker_plans():
    """[(identity, user, host, tunnel_port, https_port)] in identity order."""
    hosts = load_hosts()
    return [(identity, hosts[identity]['user'], hosts[identity]['host'], tunnel, https)
            for identity, (tunnel, https) in PORTS.items()]


def linux_workers():
    """[(identity, entry)] for every entry with "os": "linux", in identity order. An inventory with
    none gives []; a Linux entry without what linux_rollout needs stops with its name."""
    path, hosts = read_inventory()
    if not isinstance(hosts, dict):
        raise SystemExit('Fleet inventory at ' + str(path) + ' is not a JSON object')
    workers = []
    for identity in sorted(hosts):
        entry = hosts[identity]
        if not isinstance(entry, dict) or entry.get('os') != 'linux':
            continue
        problem = None
        if not LINUX_IDENTITY.fullmatch(identity) or identity in PORTS:
            problem = 'its identity must be lowercase letters, digits and dashes, and not a Mac worker'
        elif not isinstance(entry.get('host'), str) or not SAFE_TEXT.fullmatch(entry['host']):
            problem = 'it needs a host'
        elif entry.get('sshConfig') is not True and (
                not isinstance(entry.get('user'), str) or not SAFE_TEXT.fullmatch(entry['user'])):
            problem = 'it needs a user, or "sshConfig": true'
        elif not isinstance(entry.get('studioHome'), str) or not entry['studioHome'].startswith('/') \
                or not SAFE_TEXT.fullmatch(entry['studioHome']) or '..' in entry['studioHome'].split('/'):
            problem = 'it needs an absolute studioHome'
        elif entry.get('unit', 'studio.service') != 'studio.service':
            problem = 'its unit must be studio.service, the only unit specweave-studio update manages'
        if problem:
            raise SystemExit('Fleet inventory at %s: Linux worker %r: %s' % (path, identity, problem))
        workers.append((identity, entry))
    return workers
