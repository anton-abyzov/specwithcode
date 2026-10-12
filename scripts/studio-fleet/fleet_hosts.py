"""Fleet worker inventory, read at runtime from a file kept outside the repository.

The inventory maps each worker identity to {"host": ..., "user": ..., "home": ...}.
Its path is $STUDIO_FLEET_HOSTS, else ~/.local/share/specweave/fleet/hosts.json.
"""
import json
import os
import pathlib

ENV = 'STUDIO_FLEET_HOSTS'
DEFAULT = '~/.local/share/specweave/fleet/hosts.json'
# Owned loopback tunnel port and private HTTPS port for each worker identity.
PORTS = {'m1': (18319, 8443), 'm3': (28319, 8444)}


def inventory_path():
    return pathlib.Path(os.path.expanduser(os.environ.get(ENV) or DEFAULT))


def load_hosts():
    path = inventory_path()
    try:
        hosts = json.loads(path.read_text())
    except FileNotFoundError:
        raise SystemExit('Fleet inventory not found at ' + str(path) + '; create it or set ' + ENV) from None
    except (OSError, ValueError):
        raise SystemExit('Fleet inventory at ' + str(path) + ' is unreadable or not JSON') from None
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
