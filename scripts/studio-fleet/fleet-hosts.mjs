// Fleet worker inventory, read at runtime from a file kept outside the repository.
// Shape: {"m1": {"host": ..., "user": ..., "home": ...}, ...}. Path: $STUDIO_FLEET_HOSTS,
// else ~/.local/share/specweave/fleet/hosts.json.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const FLEET_HOSTS_ENV = 'STUDIO_FLEET_HOSTS';

export function fleetHostsPath() {
  const configured = process.env[FLEET_HOSTS_ENV];
  if (!configured) return join(homedir(), '.local/share/specweave/fleet/hosts.json');
  return configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured;
}

export function loadFleetHosts(identities = ['m1', 'm3']) {
  const path = fleetHostsPath();
  let hosts;
  try { hosts = JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    throw new Error(error?.code === 'ENOENT' ? `Fleet inventory not found at ${path}; create it or set ${FLEET_HOSTS_ENV}`
      : `Fleet inventory at ${path} is unreadable or not JSON`);
  }
  for (const id of identities) {
    const entry = hosts?.[id];
    if (!entry || typeof entry.host !== 'string' || !entry.host || typeof entry.user !== 'string' || !entry.user)
      throw new Error(`Fleet inventory at ${path} lacks host and user for ${id}`);
  }
  return hosts;
}

// user@host SSH destination for each worker identity.
export function fleetSshTargets(identities = ['m1', 'm3']) {
  const hosts = loadFleetHosts(identities);
  return Object.fromEntries(identities.map(id => [id, hosts[id].user + '@' + hosts[id].host]));
}
