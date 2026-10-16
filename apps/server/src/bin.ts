/**
 * Thin CLI entry.
 *
 * Every ACP agent spawns `specweave-studio acp-mcp-bridge` while opening its session, and
 * terminal-fallback agents run `specweave-studio acp-mcp-call` per tool call, so their
 * startup sits on first-message latency. Both dispatch here before the full
 * CLI module graph (seconds of evaluation) loads; everything else defers to
 * the real CLI in ./binCli.ts.
 */
import { isEntrypoint } from "./entrypoint.ts";
import { installLiveDatabaseGuard } from "./persistence/liveDatabaseGuard.ts";
import { ensureServerThreadPoolSize } from "./threadPool.ts";

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  const command = process.argv[2];
  if (command === "managed-agents") {
    const { runManagedAgentsCli } = await import("./provider/managedAgents/cli.ts");
    await runManagedAgentsCli(process.argv.slice(3));
  } else if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
    const { runAcpMcpCliFastPath } = await import("./mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpCliFastPath(command, process.argv.slice(3));
  } else {
    // Before the CLI graph loads: the pool is sized on its first job, and
    // Effect's file system captures node:fs at import.
    ensureServerThreadPoolSize();
    installLiveDatabaseGuard();
    const { runCli } = await import("./binCli.ts");
    runCli();
  }
}
