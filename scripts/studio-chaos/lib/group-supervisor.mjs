#!/usr/bin/env node
/**
 * 1465: leads the scratch server's process group and stays alive until that
 * group is gone, so the group id can never be reused while the rig might still
 * signal it. The rig signals only this process (its own live child).
 *
 *   group-supervisor.mjs <command> [args...]
 *
 * - SIGTERM or SIGINT: stop the command (SIGTERM, then SIGKILL after 15 s),
 *   then kill the whole group, this process included.
 * - SIGHUP: kill the whole group at once.
 * - The command exiting on its own: kill whatever else is left in the group
 *   (orphaned agents), this process included.
 */
import * as NodeChildProcess from "node:child_process";

const [command, ...args] = process.argv.slice(2);
const child = NodeChildProcess.spawn(command, args, { stdio: "inherit" });
const endGroup = () => process.kill(0, "SIGKILL");
child.once("exit", endGroup);
child.once("error", endGroup);
// Handlers stay installed (`on`, not `once`): a repeated signal must never fall
// through to the default action and leave the group behind.
let stopping = false;
process.on("SIGHUP", endGroup);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    if (child.exitCode !== null || child.signalCode !== null) return endGroup();
    if (stopping) return;
    stopping = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 15_000).unref();
  });
