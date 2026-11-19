// What the toast says after this app saves another way to open a machine it
// already had. A route is window access only: worker grants decide what agents
// can do, so the toast says a route leaves them alone.

export const ROUTES_LEAVE_AGENTS_ALONE = "It doesn't change what agents can do.";

export function anotherRouteTitle(machine: string): string {
  return `Another way to reach ${machine}`;
}

// A Connect route is saved ahead of LAN, Tailscale and SSH routes
// (`insertRoute`), so it is never described as a backup.
export function connectRouteDescription(machine: string): string {
  return `This app can now also open ${machine} through SpecWithCode Connect. ${ROUTES_LEAVE_AGENTS_ALONE}`;
}
