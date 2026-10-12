import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  mkdtempSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { serverRpc } from "./native-proof.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const req = createRequire(join(root, "apps/web/package.json"));
const babel = createRequire(req.resolve("@rolldown/plugin-babel"));
const { parse } = createRequire(babel.resolve("@babel/core"))("@babel/parser");

/** Extract unchanged production function bodies for an isolated transport fixture. */
export function extractFunction(source, name) {
  const file = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const declaration = file.program.body.find(
    (node) => node.type === "FunctionDeclaration" && node.id?.name === name,
  );
  assert.ok(declaration, `Missing production function ${name}`);
  return source.slice(declaration.start, declaration.end);
}

export function assertPrivateLoopbackUrl(value) {
  const url = new URL(value);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  return url;
}

function sourceIdentity() {
  const paths = [
    "apps/web/src/components/ChatView.tsx",
    "apps/web/src/hooks/useHandleNewThread.ts",
    "apps/web/src/lib/newThreadWorkspaceDefault.ts",
    "apps/web/src/lib/threadLifecycleShortcut.ts",
    "apps/web/src/components/threadActionMenu.logic.ts",
    "packages/shared/src/threadLifecycleLabels.ts",
    "packages/client-runtime/src/state/threadSettled.ts",
    "scripts/studio-verify/lifecycle-controls.mjs",
  ];
  return {
    source: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(),
    sourceDirty:
      spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim()
        .length > 0,
    sourceHashes: Object.fromEntries(
      paths.map((path) => [
        path,
        createHash("sha256")
          .update(readFileSync(join(root, path)))
          .digest("hex"),
      ]),
    ),
  };
}

function artifactTreeHash(directory) {
  const hash = createHash("sha256");
  function visit(current, prefix = "") {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(current, entry.name);
      const relative = prefix + entry.name;
      if (entry.isDirectory()) visit(path, relative + "/");
      else if (entry.isFile()) hash.update(relative + "\0").update(readFileSync(path));
    }
  }
  visit(directory);
  return hash.digest("hex");
}

export async function runLifecycleControls(reportDir) {
  assert.match(process.versions.node, /^22\./);
  process.umask(0o077);
  process.env.PWDEBUG = "0";
  process.env.PLAYWRIGHT_HTML_OPEN = "never";
  mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  chmodSync(reportDir, 0o700);
  const fixtureDir = join(reportDir, "fixture");
  mkdirSync(fixtureDir, { mode: 0o700 });
  symlinkSync(join(root, "apps/web/node_modules"), join(fixtureDir, "node_modules"), "dir");
  const put = (name, data) => {
    const path = join(fixtureDir, name);
    writeFileSync(path, data, { mode: 0o600 });
    return path;
  };
  const web = join(root, "apps/web/src");
  const imp = (path) => JSON.stringify(join(web, path));
  const rowSource = readFileSync(join(web, "components/settings/ConnectionsSettings.tsx"), "utf8");
  const rowBody =
    extractFunction(rowSource, "savedBackendStatus") +
    "\n" +
    extractFunction(rowSource, "SavedBackendListRow");
  put(
    "connections.tsx",
    `import React, {useState,useCallback} from 'react';
import * as Option from 'effect/Option';
import {ChevronRightIcon,EllipsisIcon,RouteIcon} from 'lucide-react';
import {resolveEnvironmentMachineKind} from '@specweave-studio/contracts';
import {connectionRoutes,connectionStatusText,environmentMcpUrl} from '@specweave-studio/client-runtime/connection';
import {EnvironmentRow,environmentTransportLabel} from ${imp("components/settings/EnvironmentRow.tsx")};
import {cn} from ${imp("lib/utils.ts")};
import {Button} from ${imp("components/ui/button.tsx")};
import {Switch} from ${imp("components/ui/switch.tsx")};
import {Menu,MenuTrigger,MenuPopup,MenuItem,MenuSeparator} from ${imp("components/ui/menu.tsx")};
import {Tooltip,TooltipTrigger,TooltipPopup} from ${imp("components/ui/tooltip.tsx")};
const useCopyToClipboard=()=>({copyToClipboard:()=>{}});
const toastManager={add:()=>{}},stackedThreadToast=x=>x;
const resolveServerConfigVersionMismatch=()=>null;
const serverEnvironment={updateStateAtom:()=>null},useAtomValue=()=>({status:'idle'});
const useRelayEnvironmentDiscovery=()=>({environments:new Map()});
const usePreparedConnection=()=>Option.none();
const EnvironmentIconMenu=()=>null, EnvironmentRoutesList=()=>null;
const ServerUpdateProgress=()=>null,OutdatedServerUpdateAction=()=>null,ServerUpdateAction=()=>null;
const APP_VERSION='fixture',resolveServerSelfUpdateCapability=()=>null,supportsDesktopAppUpdate=()=>false,supportsServerUpdateThreadContinuation=()=>false;
${rowBody}
export { SavedBackendListRow };`,
  );
  put("fixture.css", `@import ${imp("index.css")};\n@source ${JSON.stringify(web)};`);
  put(
    "index.html",
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Studio workflow fixture</title></head><body><div id="root"></div><script type="module" src="/app.tsx"></script></body></html>',
  );
  put(
    "app.tsx",
    `import React,{useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import * as Option from 'effect/Option';
import './fixture.css';
import {SavedBackendListRow} from './connections';
import {BranchToolbarEnvironmentSelector} from ${imp("components/BranchToolbarEnvironmentSelector.tsx")};
import {TooltipProvider} from ${imp("components/ui/tooltip.tsx")};
import {Button} from ${imp("components/ui/button.tsx")};
import {buildThreadActionMenuItems} from ${imp("components/threadActionMenu.logic.ts")};
import {showContextMenuFallback} from ${imp("contextMenuFallback.ts")};
import {runThreadLifecycleShortcut} from ${imp("lib/threadLifecycleShortcut.ts")};
import {resolveSnoozePresets,effectiveSnoozed} from '@specweave-studio/client-runtime/state/thread-settled';
import {THREAD_LIFECYCLE_LABELS as labels} from '@specweave-studio/shared/threadLifecycleLabels';
const now=new Date('2026-10-08T13:00:00.000Z');
window.fixture={commands:[],connectionActions:[],sourceFixture:true};
const base={canOperate:true,branch:null,projectFilter:null,isPinned:false,autoSettleEnabled:true,canSnoozeNow:true,isRegeneratingTitle:false,isRunning:false,supports:{settlement:true,autoSettleOptOut:true,snooze:true,pinning:true,titleRegeneration:true},snoozePresets:resolveSnoozePresets(now)};
const env=(id,label,phase='connected',enabled=true)=>({environmentId:id,label,connection:{phase,error:null},entry:{enabled,target:{_tag:'PrimaryConnectionTarget'},profile:Option.none()},serverConfig:null,displayUrl:null});
function App(){
 const [resolved,setResolved]=useState(false),[snoozed,setSnoozed]=useState(null),[host,setHost]=useState('worker-a'),[modal,setModal]=useState(false);
 const [environments,setEnvironments]=useState([env('worker-a','Worker A'),env('worker-b','Worker B','offline')]);
 const act=async action=>{window.fixture.commands.push({action,host}); if(window.fixture.hold)await new Promise(r=>window.fixture.release=r);if(action==='settle')setResolved(true);if(action==='unsettle')setResolved(false);if(action.startsWith('snooze:')){const until=base.snoozePresets.find(p=>'snooze:'+p.id===action).snoozedUntil;localStorage.setItem('fixture-snooze',until);setSnoozed(until);} };
 useEffect(()=>{const handler=e=>{if(e.key.toLowerCase()==='s'&&(e.metaKey||e.ctrlKey)&&e.shiftKey)void runThreadLifecycleShortcut(e,{threadKey:host+':thread',context:{},run:()=>act(resolved?'unsettle':'settle')});};window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);},[resolved,host]);
 window.fixture.state={resolved,snoozed,host,environments};
 window.fixture.showModal=()=>setModal(true);
 const menu=async e=>{const rect=e.currentTarget.getBoundingClientRect();const action=await showContextMenuFallback(buildThreadActionMenuItems({...base,isSettled:resolved,isSnoozed:!!snoozed}),{x:Math.min(rect.left,window.innerWidth-245),y:rect.bottom});if(action)await act(action)};
 return <TooltipProvider><main className="mx-auto max-w-3xl space-y-6 p-5 text-foreground"><header className="space-y-2"><p className="text-xs text-muted-foreground">SpecWithCode · isolated source fixture</p><h1 className="text-2xl font-semibold">Thread controls</h1></header><section className="space-y-4 rounded-xl border p-4"><div className="flex items-center justify-between"><h2 className="font-medium">Release review</h2><span data-testid="status">{resolved?labels.resolved:snoozed?'Snoozed':'Active'}</span></div><div className="flex flex-wrap gap-3"><Button onClick={menu}>Thread actions</Button><Button variant="outline" onClick={()=>act(resolved?'unsettle':'settle')}>{resolved?labels.reopen:labels.resolve}</Button></div><p className="text-sm text-muted-foreground">Resolve marks completion. Snooze hides waiting work temporarily.</p><textarea aria-label="Draft" className="min-h-20 w-full rounded-md border p-3" placeholder="Write a message…"/><div className="xterm rounded-md border p-3" contentEditable suppressContentEditableWarning role="textbox" aria-label="Terminal">terminal focus</div><BranchToolbarEnvironmentSelector envLocked={false} environmentId={host} availableEnvironments={[{environmentId:'worker-a',label:'Worker A',machine:'server'},{environmentId:'worker-b',label:'Worker B',machine:'server'}]} onEnvironmentChange={setHost}/></section><section className="overflow-hidden rounded-xl border"><h2 className="p-4 font-medium">Connections</h2>{environments.map(environment=><SavedBackendListRow key={environment.environmentId} environment={environment} removingEnvironmentId={null} onSetEnabled={(id,enabled)=>{window.fixture.connectionActions.push({type:'enabled',id,enabled});setEnvironments(es=>es.map(e=>e.environmentId===id?{...e,entry:{...e.entry,enabled}}:e));}} onRemove={e=>{window.fixture.connectionActions.push({type:'remove-request',id:e.environmentId});}} onAddRoute={()=>{}}/>)}</section>{modal&&<div role="dialog" aria-modal="true" className="fixed inset-5 z-50 rounded-xl border bg-background p-5"><p>Modal shortcut boundary</p><Button onClick={()=>setModal(false)}>Close modal</Button></div>}</main></TooltipProvider>
}
createRoot(document.getElementById('root')).render(<App/>);`,
  );
  const { createServer } = await import(req.resolve("vite"));
  const { default: tailwind } = await import(req.resolve("@tailwindcss/vite"));
  const server = await createServer({
    configFile: false,
    root: fixtureDir,
    plugins: [tailwind()],
    resolve: { alias: { "~": web } },
    optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime"] },
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: true,
      fs: { allow: [root, fixtureDir, resolve(root, "../specweave-studio")] },
    },
    oxc: { jsx: { runtime: "automatic" } },
    css: { devSourcemap: false },
  });
  let browser;
  const receipt = {
    ...sourceIdentity(),
    proofScope:
      "actual imported lifecycle/host controls plus exact AST-extracted Connections row bodies; fixture callbacks/transport, not full Connections page or installed/native acceptance",
    providerTurns: 0,
    liveServicesChanged: false,
    headless: true,
    PWDEBUG: "0",
    PLAYWRIGHT_HTML_OPEN: "never",
    reporterOpen: "never",
    connectionsFunctionHash: createHash("sha256").update(rowBody).digest("hex"),
    checks: [],
    screenshots: [],
  };
  try {
    await server.listen();
    const origin = "http://127.0.0.1:" + server.httpServer.address().port;
    assertPrivateLoopbackUrl(origin);
    const { chromium } = createRequire(import.meta.url)(
      join(
        process.env.STUDIO_BROWSER_DEPS ??
          join(
            process.env.HOME,
            ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules",
          ),
        "playwright",
      ),
    );
    browser = await chromium.launch({ headless: true });
    for (const [width, colorScheme] of [
      [1440, "dark"],
      [390, "light"],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        colorScheme,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(origin, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "Thread controls" }).waitFor();
      await page.evaluate(
        (theme) => document.documentElement.classList.toggle("dark", theme === "dark"),
        colorScheme,
      );
      await page.getByRole("button", { name: "Thread actions", exact: true }).click();
      await page.getByRole("button", { name: "Resolve thread", exact: true }).click();
      await page.getByTestId("status").getByText("Resolved", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Thread actions", exact: true }).click();
      await page.getByRole("button", { name: "Reopen thread", exact: true }).click();
      await page.getByTestId("status").getByText("Active", { exact: true }).waitFor();
      await page.evaluate(() => {
        window.fixture.commands = [];
        window.fixture.hold = true;
        document.activeElement?.blur();
      });
      await page.keyboard.down("Control");
      await page.keyboard.down("Shift");
      await page.keyboard.down("s");
      await page.keyboard.down("s");
      await page.keyboard.down("s");
      assert.equal(await page.evaluate(() => window.fixture.commands.length), 1);
      await page.evaluate(() => {
        window.fixture.hold = false;
        window.fixture.release();
      });
      await page.getByTestId("status").getByText("Resolved", { exact: true }).waitFor();
      await page.keyboard.down("s");
      assert.equal(await page.evaluate(() => window.fixture.commands.length), 1);
      await page.keyboard.up("s");
      await page.keyboard.up("Shift");
      await page.keyboard.up("Control");
      await page.keyboard.press("Control+Shift+s");
      await page.getByTestId("status").getByText("Active", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.fixture.commands.length), 2);
      for (const label of ["Draft", "Terminal"]) {
        await page.getByRole("textbox", { name: label, exact: true }).focus();
        await page.keyboard.press("Control+Shift+s");
      }
      assert.equal(await page.evaluate(() => window.fixture.commands.length), 2);
      await page.evaluate(() => window.fixture.showModal());
      await page.getByRole("dialog").waitFor();
      await page.keyboard.press("Control+Shift+s");
      assert.equal(await page.evaluate(() => window.fixture.commands.length), 2);
      await page.getByRole("button", { name: "Close modal" }).click();
      await page.getByRole("combobox", { name: "Run on", exact: true }).click();
      await page.getByRole("option", { name: "Worker B", exact: true }).click();
      assert.equal(await page.evaluate(() => window.fixture.state.host), "worker-b");
      await page.getByRole("switch", { name: "Switch off Worker A", exact: true }).click();
      await page.getByRole("switch", { name: "Switch on Worker A", exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.fixture.state.environments.length), 2);
      await page.getByRole("button", { name: "More actions for Worker A", exact: true }).click();
      await page.getByRole("menuitem", { name: "Remove from this device…", exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.fixture.connectionActions), [
        { type: "enabled", id: "worker-a", enabled: false },
        { type: "remove-request", id: "worker-a" },
      ]);
      await page.getByRole("button", { name: "Thread actions", exact: true }).click();
      await page.getByRole("button", { name: "Snooze", exact: true }).hover();
      await page.getByRole("button", { name: /^In 3 days/ }).click();
      await page.getByTestId("status").getByText("Snoozed", { exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => localStorage.getItem("fixture-snooze")),
        await page.evaluate(() => window.fixture.state.snoozed),
      );
      assert.deepEqual(errors, []);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
        false,
      );
      const path = join(reportDir, `controls-${width}-${colorScheme}.png`);
      await page.screenshot({ path, fullPage: true });
      chmodSync(path, 0o600);
      receipt.screenshots.push(path);
      receipt.checks.push({
        width,
        colorScheme,
        resolveReopen: true,
        heldShortcutExactlyOnce: true,
        separateReopen: true,
        focusAndModalPreserved: true,
        selectedHostRetained: true,
        switchOffPreservesSavedMachine: true,
        removeIsDistinct: true,
        threeDaySnoozeStored: true,
      });
      await context.close();
    }
    receipt.result = "passed";
  } catch (error) {
    receipt.result = "failed";
    receipt.error = String(error);
    throw error;
  } finally {
    await browser?.close();
    await server.close();
    writeFileSync(
      join(reportDir, "browser-receipt.json"),
      JSON.stringify(receipt, null, 2) + "\n",
      { mode: 0o600 },
    );
  }
  return receipt;
}
/** A new home, new server and synthetic ACP process; no installed service or native account. */
export async function runBackgroundControls(reportDir) {
  assert.match(process.versions.node, /^22\./);
  process.umask(0o077);
  process.env.PWDEBUG = "0";
  process.env.PLAYWRIGHT_HTML_OPEN = "never";
  mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  chmodSync(reportDir, 0o700);
  const testHome = mkdtempSync(join(reportDir, "owned-home-"));
  const stateDir = join(testHome, "state");
  const projectRoot = join(testHome, "project");
  for (const dir of [stateDir, join(stateDir, "userdata"), projectRoot, join(testHome, "tmp")])
    mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(projectRoot, "README.md"), "# T27 synthetic provider fixture\n", {
    mode: 0o600,
  });
  const env = {
    HOME: testHome,
    USER: "studio-fixture",
    LOGNAME: "studio-fixture",
    PATH: dirname(process.execPath) + ":/usr/bin:/bin",
    TMPDIR: join(testHome, "tmp"),
    PWDEBUG: "0",
    PLAYWRIGHT_HTML_OPEN: "never",
    GIT_CONFIG_NOSYSTEM: "1",
    STUDIO_ACP_PROMPT_RESPONSE_TEXT: "Synthetic T27 response. No native provider was invoked.",
  };
  for (const args of [
    ["init", "-b", "main"],
    ["add", "README.md"],
    [
      "-c",
      "user.name=Studio fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Owned fixture baseline",
    ],
  ]) {
    assert.equal(
      spawnSync("/usr/bin/git", args, { cwd: projectRoot, env, encoding: "utf8" }).status,
      0,
    );
  }
  const nativeDrivers = ["codex", "claudeAgent", "cursor", "grok", "pi", "opencode", "antigravity"];
  const modelSelection = { instanceId: "fixture", model: "default" };
  const settings = {
    newWorktreesStartFromOrigin: false,
    defaultModelSelection: modelSelection,
    textGenerationModelSelection: modelSelection,
    providers: Object.fromEntries(nativeDrivers.map((driver) => [driver, { enabled: false }])),
    providerInstances: {
      ...Object.fromEntries(
        nativeDrivers.map((driver) => [driver, { driver, enabled: false, config: {} }]),
      ),
      fixture: {
        driver: "acpRegistry",
        enabled: true,
        displayName: "T27 synthetic provider",
        config: {
          source: "local",
          commandPath: process.execPath,
          commandArgs: [join(root, "apps/server/scripts/acp-mock-agent.ts")],
          customModels: ["default"],
        },
      },
    },
  };
  writeFileSync(join(stateDir, "userdata/settings.json"), JSON.stringify(settings), {
    mode: 0o600,
  });
  const port = await new Promise((done, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const port = socket.address().port;
      socket.close(() => done(port));
    });
  });
  const origin = "http://127.0.0.1:" + port;
  assertPrivateLoopbackUrl(origin);
  const entrypoint = join(root, "apps/server/dist/bin.mjs");
  const receipt = {
    proofScope:
      "own production bundle and new isolated server; synthetic ACP only; not installed/native proof",
    ...sourceIdentity(),
    artifactSha256: createHash("sha256").update(readFileSync(entrypoint)).digest("hex"),
    webArtifactTreeSha256: artifactTreeHash(join(root, "apps/server/dist/client")),
    testHome,
    stateDir,
    port,
    headless: true,
    PWDEBUG: "0",
    PLAYWRIGHT_HTML_OPEN: "never",
    reporterOpen: "never",
    nativeTurns: 0,
    liveServicesChanged: false,
    steps: [],
    screenshots: [],
  };
  const save = () =>
    writeFileSync(
      join(reportDir, "background-receipt.json"),
      JSON.stringify(receipt, null, 2) + "\n",
      { mode: 0o600 },
    );
  const step = (name, data = {}) => {
    receipt.steps.push({ name, ...data });
    save();
    console.log(JSON.stringify({ name, ...data }));
  };
  const child = spawn(
    process.execPath,
    [
      entrypoint,
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      stateDir,
      "--no-browser",
    ],
    { cwd: stateDir, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  receipt.ownedPid = child.pid;
  let browser, admin, context, page, pairing;
  let startup = "";
  const delay = (ms) => new Promise((done) => setTimeout(done, ms));
  try {
    const credential = await new Promise((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Owned server startup timeout; private output withheld")),
        45000,
      );
      const inspect = (chunk) => {
        startup += chunk.toString();
        const match = startup.match(/(?:^|\n)Token: (\S+)/);
        if (match) {
          clearTimeout(timer);
          done(match[1]);
        }
      };
      child.stdout.on("data", inspect);
      child.stderr.on("data", inspect);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error("Owned server exited: " + code));
      });
    });
    const { chromium } = createRequire(import.meta.url)(
      join(
        process.env.STUDIO_BROWSER_DEPS ??
          join(
            process.env.HOME,
            ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules",
          ),
        "playwright",
      ),
    );
    browser = await chromium.launch({ headless: true });
    admin = await browser.newContext();
    assert.equal(
      (
        await admin.request.post(origin + "/api/auth/browser-session", {
          headers: { Origin: origin },
          data: { credential },
        })
      ).status(),
      200,
    );
    const issued = await admin.request.post(origin + "/api/auth/pairing-token", {
      headers: { Origin: origin },
      data: { label: "T27 owned ephemeral browser" },
    });
    assert.equal(issued.status(), 200);
    pairing = await issued.json();
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      colorScheme: "dark",
      reducedMotion: "reduce",
    });
    assert.equal(
      (
        await context.request.post(origin + "/api/auth/browser-session", {
          headers: { Origin: origin },
          data: { credential: pairing.credential },
        })
      ).status(),
      200,
    );
    pairing.credential = "";
    step("owned-server-authenticated", { nativeDriversDisabled: nativeDrivers });
    let config;
    for (let n = 0; n < 30; n++) {
      config = await serverRpc(context, origin, "server.getConfig");
      if (config.providers.find((p) => p.instanceId === "fixture")?.status === "ready") break;
      await delay(500);
    }
    const provider = config.providers.find((p) => p.instanceId === "fixture");
    step("synthetic-provider", {
      status: provider?.status,
      enabled: provider?.enabled,
      modelCount: provider?.models.length,
    });
    assert.equal(provider?.status, "ready");
    assert.equal(config.providers.filter((p) => p.enabled && p.instanceId !== "fixture").length, 0);
    const projectId = randomUUID();
    const created = await context.request.post(origin + "/api/projects/mutate", {
      headers: { Origin: origin },
      data: {
        type: "project.create",
        commandId: randomUUID(),
        projectId,
        title: "T27 workflow fixture",
        workspaceRoot: projectRoot,
        defaultModelSelection: modelSelection,
      },
    });
    assert.equal(created.status(), 200);
    let rejectNext = false;
    const launches = [];
    const requests = [];
    receipt.rpcRequests = requests;
    page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.routeWebSocket("**/ws?*", (route) => {
      const upstream = route.connectToServer();
      route.onMessage((message) => {
        let frames;
        try {
          const parsed = JSON.parse(String(message));
          frames = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          upstream.send(message);
          return;
        }
        let changed = false;
        for (const frame of frames) {
          if (frame._tag === "Request") {
            requests.push({ tag: frame.tag, id: frame.id });
            save();
          }
          if (frame._tag === "Request" && frame.tag === "orchestration.launchThread") {
            assert.equal(frame.payload.projectId, projectId);
            launches.push({
              threadId: frame.payload.threadId,
              modelSelection: frame.payload.modelSelection,
              workspaceStrategy: { ...frame.payload.workspaceStrategy },
              rejected: rejectNext,
            });
            if (rejectNext) {
              rejectNext = false;
              frame.payload.projectId = "t27-missing-fixture-project";
              changed = true;
            }
          }
        }
        upstream.send(
          changed
            ? JSON.stringify(Array.isArray(JSON.parse(String(message))) ? frames : frames[0])
            : message,
        );
      });
    });
    await page.goto(origin, { waitUntil: "networkidle", timeout: 45000 });
    for (let n = 0; n < 2; n++) {
      const next = page.getByRole("button", { name: "Continue", exact: true });
      if (await next.count()) {
        await next.click();
        await delay(300);
      }
    }
    const skip = page.getByRole("button", { name: "Do not import projects", exact: true });
    if (await skip.count()) await skip.click();
    await page.locator(".studio-desk").waitFor();
    step("overview-ready", { buttons: await page.getByRole("button").allTextContents() });
    await page.getByRole("button", { name: "New session", exact: true }).first().click();
    const projectOption = (
      await page
        .locator("#studio-project option")
        .evaluateAll((nodes) => nodes.map((n) => ({ value: n.value, label: n.textContent })))
    ).find((o) => o.value.endsWith(":" + projectId));
    assert.ok(projectOption);
    await page.locator("#studio-project").selectOption(projectOption.value);
    await page
      .locator(".studio-draft-chooser")
      .getByRole("button", { name: "Open native draft", exact: true })
      .click();
    const composer = page.locator("[contenteditable=true]").first();
    await composer.waitFor();
    step("new-git-draft", { path: new URL(page.url()).pathname });
    const initialPath = new URL(page.url()).pathname;
    const draftState = async (draftId = new URL(page.url()).pathname.split("/").at(-1)) => {
      await page.waitForFunction(
        (id) =>
          Boolean(
            JSON.parse(localStorage.getItem("studio:composer-drafts:v1") ?? "null")?.state
              ?.draftThreadsByThreadKey?.[id],
          ),
        draftId,
      );
      return page.evaluate((id) => {
        const state = JSON.parse(localStorage.getItem("studio:composer-drafts:v1")).state;
        const draft = state.draftThreadsByThreadKey[id];
        return {
          draftId: id,
          environmentId: draft.environmentId,
          projectId: draft.projectId,
          envMode: draft.envMode,
          branch: draft.branch,
          startFromOrigin: draft.startFromOrigin,
          activeProvider: state.draftsByThreadKey[id]?.activeProvider,
        };
      }, draftId);
    };
    const initialDraft = await draftState();
    receipt.initialDraft = initialDraft;
    assert.equal(initialDraft.envMode, "worktree");
    assert.equal(initialDraft.environmentId, projectOption.value.slice(0, -projectId.length - 1));
    save();
    // The existing worktree flow requires a deliberate base-ref choice.
    await page
      .getByRole("combobox")
      .filter({ hasText: /From main/ })
      .first()
      .click();
    await page.getByRole("option").filter({ hasText: "main" }).first().click();
    await composer.fill("T27 accepted background fixture");
    await page.getByRole("button", { name: "Submit message", exact: true }).waitFor();
    await page.keyboard.down("Meta");
    await page.keyboard.down("Enter");
    await page.keyboard.down("Enter");
    await page.keyboard.down("Enter");
    await page.waitForFunction((path) => location.pathname !== path, initialPath);
    await page.keyboard.up("Enter");
    await page.keyboard.up("Meta");
    await page.getByText("Started in background", { exact: true }).waitFor();
    assert.equal(launches.length, 1);
    assert.equal(launches[0].workspaceStrategy.type, "worktree");
    assert.equal(launches[0].modelSelection.instanceId, "fixture");
    const freshPath = new URL(page.url()).pathname;
    assert.match(freshPath, /^\/draft\//);
    assert.equal((await composer.innerText()).trim(), "");
    step("background-accepted", { launches: launches.slice(), freshPath });
    const protocol = { "x-studio-orchestration-protocol": "2" };
    let projection;
    for (let attempt = 0; attempt < 40; attempt++) {
      const detail = await context.request.get(
        origin + "/api/orchestration/threads/" + launches[0].threadId,
        { headers: protocol },
      );
      if (detail.ok()) {
        projection = (await detail.json()).projection;
        if (["completed", "failed", "cancelled"].includes(projection.runs.at(-1)?.status)) break;
      }
      await delay(250);
    }
    assert.equal(projection?.runs.at(-1)?.status, "completed");
    assert.equal(projection.thread.modelSelection.instanceId, "fixture");
    assert.ok(projection.thread.worktreePath.startsWith(testHome + "/"));
    assert.equal(
      readFileSync(join(projectRoot, "README.md"), "utf8"),
      "# T27 synthetic provider fixture\n",
    );
    step("server-accepted-readback", {
      runStatus: projection.runs.at(-1).status,
      instanceId: projection.thread.modelSelection.instanceId,
      worktreePath: projection.thread.worktreePath,
      host: "same owned loopback connection",
    });
    const freshDraft = await draftState();
    receipt.freshDraft = freshDraft;
    assert.equal(freshDraft.environmentId, initialDraft.environmentId);
    assert.equal(freshDraft.activeProvider, "fixture");
    save();
    rejectNext = true;
    await composer.fill("T27 failed background fixture preserved");
    await page.keyboard.press("Meta+Enter");
    await page.waitForFunction((path) => location.pathname !== path, freshPath);
    await page.getByText("Background task failed", { exact: true }).waitFor();
    assert.equal(launches.length, 2);
    const retryDraft = await draftState(freshPath.split("/").at(-1));
    receipt.retryDraft = retryDraft;
    save();
    await page.getByRole("button", { name: "Open draft", exact: true }).click();
    await page.waitForFunction((path) => location.pathname === path, freshPath);
    assert.equal((await composer.innerText()).trim(), "T27 failed background fixture preserved");
    step("background-failure-restored", {
      launchCount: launches.length,
      promptRestored: true,
      routeRestored: true,
    });
    const shell = await context.request.get(origin + "/api/orchestration/shell", {
      headers: protocol,
    });
    assert.equal(
      (await shell.json()).threads.filter((thread) => thread.projectId === projectId).length,
      1,
    );
    assert.deepEqual(pageErrors, []);
    for (const [width, scheme] of [
      [1440, "dark"],
      [390, "light"],
    ]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: scheme });
      const path = join(reportDir, `background-restored-${width}-${scheme}.png`);
      await page.screenshot({ path, fullPage: true });
      chmodSync(path, 0o600);
      receipt.screenshots.push(path);
    }
    const nonGitRoot = join(testHome, "non-git-folder");
    mkdirSync(nonGitRoot, { mode: 0o700 });
    const nonGitId = randomUUID();
    const nonGitCreated = await context.request.post(origin + "/api/projects/mutate", {
      headers: { Origin: origin },
      data: {
        type: "project.create",
        commandId: randomUUID(),
        projectId: nonGitId,
        title: "T27 non-Git fixture",
        workspaceRoot: nonGitRoot,
        defaultModelSelection: modelSelection,
      },
    });
    assert.equal(nonGitCreated.status(), 200);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "New session", exact: true }).first().click();
    const nonGitOption = (
      await page
        .locator("#studio-project option")
        .evaluateAll((nodes) => nodes.map((node) => node.value))
    ).find((value) => value.endsWith(":" + nonGitId));
    assert.ok(nonGitOption);
    await page.locator("#studio-project").selectOption(nonGitOption);
    await page
      .locator(".studio-draft-chooser")
      .getByRole("button", { name: "Open native draft", exact: true })
      .click();
    await page.locator("[contenteditable=true]").first().waitFor();
    await page.getByRole("button", { name: "Initialize Git", exact: true }).waitFor();
    const nonGitDraft = await draftState();
    assert.equal(nonGitDraft.projectId, nonGitId);
    assert.equal(nonGitDraft.envMode, "local");
    step("non-git-default", {
      mode: "local",
      authoritativeObservation: "non-Git folder",
      providerTurns: 0,
    });
    receipt.result = "passed";
  } catch (error) {
    receipt.result = "failed";
    receipt.error = String(error);
    if (page) {
      receipt.failedPage = {
        path: new URL(page.url()).pathname,
        buttons: await page
          .getByRole("button")
          .allTextContents()
          .catch(() => []),
      };
      const shot = join(reportDir, "failure.png");
      await page
        .screenshot({ path: shot, fullPage: true })
        .then(() => chmodSync(shot, 0o600))
        .catch(() => {});
    }
    throw error;
  } finally {
    try {
      if (admin && pairing) {
        const clients = await admin.request
          .get(origin + "/api/auth/clients")
          .then((r) => r.json())
          .catch(() => []);
        const ids = [];
        for (const client of clients) {
          if (client.client?.label === "T27 owned ephemeral browser") {
            const revoked = await admin.request.post(origin + "/api/auth/clients/revoke", {
              headers: { Origin: origin },
              data: { sessionId: client.sessionId },
            });
            assert.equal(revoked.status(), 200);
            ids.push(client.sessionId);
          }
        }
        const revoke = await admin.request.post(origin + "/api/auth/pairing-links/revoke", {
          headers: { Origin: origin },
          data: { id: pairing.id },
        });
        receipt.grantCleanup = { clientCount: ids.length, pairingRevokeStatus: revoke.status() };
      }
    } catch (error) {
      receipt.grantCleanupError = String(error);
    }
    await browser?.close().catch(() => {});
    startup = "";
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise((done) => child.once("exit", done)), delay(3000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise((done) => child.once("exit", done));
      }
    }
    receipt.serverStopped = child.exitCode !== null || child.signalCode !== null;
    save();
  }
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help"))
    console.log(
      "Node22 lifecycle-controls.mjs --report-dir /absolute/new/private/directory [--background]; headless source fixtures only, no native accounts or native turns",
    );
  else {
    const index = process.argv.indexOf("--report-dir");
    assert.ok(index >= 0);
    console.log(
      JSON.stringify(
        await (
          process.argv.includes("--background") ? runBackgroundControls : runLifecycleControls
        )(resolve(process.argv[index + 1])),
      ),
    );
  }
}
