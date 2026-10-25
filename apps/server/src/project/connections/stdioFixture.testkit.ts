import * as DateTime from "effect/DateTime";
// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { expect } from "vite-plus/test";
import type { ProjectConnectionConfig } from "@specweave-studio/contracts";

export const secretKey = "STUDIO_CONNECTION_TEST_SECRET";
export const excludedKey = "STUDIO_CONNECTION_TEST_UNSELECTED";
interface FixtureEvent {
  type: string;
  pid: number;
  method?: string;
}

/** A local JSON-RPC peer, never a provider executable, account or external service. */
const script = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const root = process.argv[2];
const record = (event) => fs.appendFileSync(path.join(root,'events.jsonl'),JSON.stringify({pid:process.pid,...event})+'\n');
record({type:'start'});
process.on('exit',() => record({type:'exit'}));
process.stdin.on('end',() => process.exit(0));
const reply = (id,result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
readline.createInterface({input:process.stdin}).on('line',line => {
  const request=JSON.parse(line);
  record({type:'request',method:request.method});
  if (!('id' in request)) return;
  const settings=JSON.parse(fs.readFileSync(path.join(root,'settings.json'),'utf8'));
  const secret=process.env.STUDIO_CONNECTION_TEST_SECRET;
  if (request.method === 'initialize') return reply(request.id,{protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'owned-fixture',version:'1'}});
  if (request.method === 'tools/list') return reply(request.id,{tools:[{
    name:settings.secretName ? secret : 'echo',
    description:'Synthetic echo '+settings.version+(secret ? ' '+secret : ''),
    inputSchema:{type:'object',properties:{value:{type:'string',description:secret ?? 'public'}},required:['value']}
  }]});
  if (request.method === 'tools/call') {
    if (settings.hang) return;
    return reply(request.id,{content:[{type:'text',text:secret ?? request.params.arguments.value}],structuredContent:{echo:request.params.arguments.value,secret:secret ?? null,unselected:process.env.STUDIO_CONNECTION_TEST_UNSELECTED ?? null}});
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Unknown synthetic method'}})+'\n');
});
`;

export async function stdioFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-connection-test-"));
  const filename = path.join(root, "fixture.mjs");
  await fs.writeFile(filename, script);
  const configure = (options: { version?: number; secretName?: boolean; hang?: boolean } = {}) =>
    fs.writeFile(path.join(root, "settings.json"), JSON.stringify({ version: 1, ...options }));
  await configure();
  const events = async (): Promise<FixtureEvent[]> => {
    try {
      return (await fs.readFile(path.join(root, "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  const waitUntil = async (predicate: () => Promise<boolean>) => {
    const deadline = DateTime.toEpochMillis(DateTime.nowUnsafe()) + 6_000;
    while (!(await predicate())) {
      if (DateTime.toEpochMillis(DateTime.nowUnsafe()) >= deadline)
        throw new Error("Owned fixture did not reach expected state");
      await delay(20);
    }
  };
  const stopped = async () => {
    await waitUntil(async () =>
      (await events()).filter((e) => e.type === "start").every((e) => !isAlive(e.pid)),
    );
    const log = await events();
    for (const { pid } of log.filter((e) => e.type === "start"))
      expect(log.some((e) => e.type === "exit" && e.pid === pid)).toBe(true);
  };
  const dispose = async () => {
    // Failure cleanup addresses only PIDs recorded by this owned fixture.
    for (const { pid } of (await events()).filter((e) => e.type === "start"))
      if (isAlive(pid)) process.kill(pid, "SIGKILL");
    await waitUntil(async () =>
      (await events()).filter((e) => e.type === "start").every((e) => !isAlive(e.pid)),
    );
    // Windows reports a process dead (exit code set) before it has closed its handles,
    // including its working directory (`root`), so removing it can briefly fail with
    // EBUSY. Node retries EBUSY/EPERM/ENOTEMPTY with a linear backoff (up to ~5.5 s).
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  const config: ProjectConnectionConfig = {
    name: "Owned synthetic MCP",
    command: process.execPath,
    args: [filename, root],
    envKeys: [],
  };
  return {
    root,
    config,
    configure,
    events,
    stopped,
    dispose,
    waitForCall: () =>
      waitUntil(async () => (await events()).some((e) => e.method === "tools/call")),
  };
}
