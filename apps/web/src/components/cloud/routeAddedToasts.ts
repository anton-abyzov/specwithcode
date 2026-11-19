// What the toast says after this app saves another way to open a machine it
// already had. A route is window access only: worker grants decide what agents
// can do, so the toast says a route leaves them alone.

export const ROUTES_LEAVE_AGENTS_ALONE = "It doesn't change what agents can do.";

export function anotherRouteTitle(machine: string): string {
  return `Another way to reach ${machine}`;
}

export function connectBackupRouteDescription(machine: string): string {
  return `When this app can't reach ${machine} the usual way, it opens it through SpecWithCode Connect. ${ROUTES_LEAVE_AGENTS_ALONE}`;
}
