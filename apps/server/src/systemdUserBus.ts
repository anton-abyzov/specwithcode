/**
 * `systemctl --user` reaches the user manager through XDG_RUNTIME_DIR (and the
 * session bus in it). The installed launchers start from `env -i`, and a plain
 * SSH command may not get a login session, so both can be missing even though
 * the manager runs. These helpers add them back from /run/user/<uid>, and never
 * replace values that are already set.
 */

type Env = Readonly<Record<string, string | undefined>>;

const nonEmpty = (value: string | undefined) =>
  value !== undefined && value.length > 0 ? value : undefined;

function runtimeDirOf(env: Env, uid: number): string {
  return nonEmpty(env.XDG_RUNTIME_DIR) ?? `/run/user/${uid}`;
}

/** The files `userBusEnv` checks: the runtime folder and the bus socket in it. */
export function userBusCandidates(env: Env, uid: number | undefined): string[] {
  if (uid === undefined) return [];
  return [`/run/user/${uid}`, `${runtimeDirOf(env, uid)}/bus`];
}

/** The variables to add for a `systemctl --user` or `loginctl` call; empty when nothing is missing. */
export function userBusEnv(
  env: Env,
  uid: number | undefined,
  exists: (path: string) => boolean,
): Record<string, string> {
  if (uid === undefined) return {};
  const added: Record<string, string> = {};
  if (nonEmpty(env.XDG_RUNTIME_DIR) === undefined) {
    const fallback = `/run/user/${uid}`;
    if (!exists(fallback)) return added;
    added.XDG_RUNTIME_DIR = fallback;
  }
  const bus = `${runtimeDirOf(env, uid)}/bus`;
  if (nonEmpty(env.DBUS_SESSION_BUS_ADDRESS) === undefined && exists(bus))
    added.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`;
  return added;
}

/** systemctl's wording when it cannot reach the user manager at all. */
export function isUserBusError(output: string): boolean {
  return /Failed to connect to (user scope )?bus|\$DBUS_SESSION_BUS_ADDRESS and \$XDG_RUNTIME_DIR not defined/iu.test(
    output,
  );
}
