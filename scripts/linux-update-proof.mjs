#!/usr/bin/env node
// Proves the Linux .deb update path on a clean machine with the real updater, pkexec and relaunch.
// Runs only on a throwaway CI machine: it installs packages and rewrites the installed feed config.
//
//   node scripts/linux-update-proof.mjs --previous old.deb --candidate new.deb --evidence dir \
//     [--phases update,retry,replaced]
//
// update:   the previous release updates itself to the candidate from a local feed.
// retry:    the candidate meets a package dpkg refuses, reports why, and Retry responds.
// replaced: a package replaces the running binary; the install relaunches without the updater.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
};

const previousDeb = arg("previous");
const candidateDeb = arg("candidate");
const evidence = arg("evidence");
const KNOWN_PHASES = ["update", "retry", "replaced"];
const requestedPhases = arg("phases", KNOWN_PHASES.join(",")).split(",");
const unknownPhase = requestedPhases.find((phase) => !KNOWN_PHASES.includes(phase));
if (unknownPhase) throw new Error(`Unknown phase ${unknownPhase}`);
// Retry and the replaced-binary relaunch shipped in 1.0.153; a repair of an older release can
// only prove its update.
const FIRST_WITH_RETRY = [1, 0, 153];
const APP = "/opt/SpecWithCode/specweave-studio-desktop";
const FEED_CONFIG = "/opt/SpecWithCode/resources/app-update.yml";
const FEED_PORT = 8599;
const CDP_PORT = 9333;
const DISPLAY = ":99";

mkdirSync(evidence, { recursive: true });
const log = (message) => console.log(`[proof] ${message}`);
const fail = (message) => {
  throw new Error(message);
};
const sudo = (...args) => execFileSync("sudo", ["-n", ...args], { encoding: "utf8" });
const debVersion = (file) =>
  execFileSync("dpkg-deb", ["-f", file, "Version"], { encoding: "utf8" }).trim();
const installedVersion = () =>
  spawnSync("dpkg-query", ["-W", "-f=${Version}", "studio"], { encoding: "utf8" }).stdout.trim();

const until = async (what, timeoutMs, read) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (last) return last;
    } catch (error) {
      last = String(error);
    }
    await sleep(1_000);
  }
  return fail(`Timed out after ${timeoutMs / 1000}s waiting for ${what}. Last: ${String(last)}`);
};

// Feed: what electron-updater's generic provider reads, the same manifest shape a release carries.
let feed = { version: "0.0.0", file: null };
const sha512 = (file) => createHash("sha512").update(readFileSync(file)).digest("base64");
const setFeed = (version, file) => {
  feed = { version, file, name: `SpecWithCode-${version}-amd64.deb`, sha: sha512(file) };
};
const server = createServer((request, response) => {
  const name = basename(new URL(request.url, "http://x").pathname);
  log(`feed ${request.method} ${name}`);
  if (name === "latest-linux.yml") {
    response.end(
      [
        `version: ${feed.version}`,
        "files:",
        `  - url: ${feed.name}`,
        `    sha512: ${feed.sha}`,
        `    size: ${statSync(feed.file).size}`,
        `path: ${feed.name}`,
        `sha512: ${feed.sha}`,
        `releaseDate: '${new Date().toISOString()}'`,
        "",
      ].join("\n"),
    );
  } else if (name === feed.name) {
    response.setHeader("content-length", statSync(feed.file).size);
    createReadStream(feed.file).pipe(response);
  } else {
    response.statusCode = 404;
    response.end();
  }
});
const pointInstallAtFeed = () => {
  const yml = `provider: generic\nurl: http://127.0.0.1:${FEED_PORT}\nupdaterCacheDirName: studio-updater\n`;
  writeFileSync(join(evidence, "app-update.yml"), yml);
  sudo("cp", join(evidence, "app-update.yml"), FEED_CONFIG);
};

const appPid = () => {
  const out = spawnSync("pgrep", ["-f", `^${APP}( --remote-debugging-port=${CDP_PORT})?$`], {
    encoding: "utf8",
  }).stdout.trim();
  return out === "" ? null : Number(out.split("\n")[0]);
};
/** As a desktop session does, the app's output goes to the journal, where the failure review reads it. */
const SESSION_ENV = {
  DISPLAY,
  XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid()}/bus`,
};
const launch = () => {
  const child = spawn(
    "systemd-cat",
    ["-t", "specweave-studio-desktop.desktop", APP, `--remote-debugging-port=${CDP_PORT}`],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ...SESSION_ENV },
    },
  );
  child.unref();
};
const quitApp = async () => {
  // Repeated: a running update can relaunch the app after the first signal.
  await until("the app to quit", 60_000, () => {
    const pid = appPid();
    if (pid === null) return true;
    spawnSync("kill", [String(pid)]);
    return false;
  });
};

/** Evaluates in the app's window over the DevTools protocol. Rejects when the app goes away. */
const evaluate = async (expression, timeoutMs = 60_000) => {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const page = targets.find((target) => target.type === "page");
  if (!page) fail("no window yet");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  return new Promise((resolve, reject) => {
    if (timeoutMs !== null) {
      setTimeout(() => {
        socket.close();
        reject(new Error(`no answer within ${timeoutMs / 1000}s`));
      }, timeoutMs).unref();
    }
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      socket.close();
      if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.text));
      else resolve(message.result?.result?.value);
    };
    socket.onerror = () => reject(new Error("window connection failed"));
    socket.onclose = () => reject(new Error("window connection closed"));
  });
};
const updateState = () => evaluate("window.desktopBridge.getUpdateState()");
const waitForApp = async (version) => {
  const state = await until(`the app at ${version}`, 180_000, async () => {
    const current = await updateState();
    return current?.currentVersion === version ? current : false;
  });
  const pid = await until("the app process", 30_000, appPid);
  const link = readlinkSync(`/proc/${pid}/exe`);
  if (link !== APP) fail(`The app runs ${link}, expected ${APP}`);
  log(`app ${version} is up, pid ${pid}`);
  return { state, pid };
};
const downloadOffered = async (version) => {
  await evaluate("window.desktopBridge.checkForUpdate()");
  await until(`download of ${version}`, 300_000, async () => {
    const state = await updateState();
    if (state.downloadedVersion === version) return true;
    if (state.status === "available" && state.availableVersion === version) {
      await evaluate("window.desktopBridge.downloadUpdate()").catch(() => undefined);
    }
    return false;
  });
  log(`downloaded ${version}`);
};
/** Starts the install; a quit takes the window with it, so the reply may never come. */
const install = () =>
  until("the install to be accepted", 120_000, async () => {
    const outcome = await evaluate("window.desktopBridge.installUpdate()", null).catch((error) => ({
      accepted: true,
      closed: String(error),
    }));
    log(`install answered: ${JSON.stringify({ ...outcome, state: undefined })}`);
    return outcome.accepted ? outcome : false;
  });
const pkexecRuns = () =>
  spawnSync("journalctl", ["-t", "pkexec", "--no-pager", "-q", "-o", "cat"], {
    encoding: "utf8",
  })
    .stdout.split("\n")
    .filter((line) => line.includes("COMMAND=/bin/bash")).length;

const candidate = debVersion(candidateDeb);
const candidateParts = candidate.split(".").map(Number);
const firstDifference = candidateParts.findIndex((part, index) => part !== FIRST_WITH_RETRY[index]);
const hasRetry =
  firstDifference === -1 || candidateParts[firstDifference] > FIRST_WITH_RETRY[firstDifference];
const phases = hasRetry ? requestedPhases : requestedPhases.filter((phase) => phase === "update");
const previous = debVersion(previousDeb);
const parts = candidate.split(".");
const next = [parts[0], parts[1], Number(parts[2]) + 1].join(".");
log(`previous ${previous}, candidate ${candidate}, phases ${phases.join(" ")}`);

/**
 * The app reads its feed config at launch, and each package install restores the real one. A
 * launch like a desktop's also keeps the output the updater's own relaunch loses.
 */
const noNewPrivileges = (pid) =>
  /^NoNewPrivs:\s*1\s*$/m.test(readFileSync(`/proc/${pid}/status`, "utf8"));
const relaunchOnFeed = async (version) => {
  await quitApp();
  pointInstallAtFeed();
  launch();
  await waitForApp(version);
};

const prove = async () => {
  // Real pkexec, no password: the rule stands in for the person at the prompt.
  if (existsSync("/etc/polkit-1/rules.d")) {
    writeFileSync(
      join(evidence, "49-proof.rules"),
      'polkit.addRule(function(a,s){if(a.id=="org.freedesktop.policykit.exec"&&s.user=="' +
        `${process.env.USER}"){return polkit.Result.YES;}});\n`,
    );
    sudo("cp", join(evidence, "49-proof.rules"), "/etc/polkit-1/rules.d/49-proof.rules");
  } else {
    // Ubuntu 22.04's polkit 0.105 reads no .rules files.
    writeFileSync(
      join(evidence, "49-proof.pkla"),
      `[proof]\nIdentity=unix-user:${process.env.USER}\nAction=org.freedesktop.policykit.exec\n` +
        "ResultAny=yes\nResultInactive=yes\nResultActive=yes\n",
    );
    sudo("mkdir", "-p", "/etc/polkit-1/localauthority/50-local.d");
    sudo(
      "cp",
      join(evidence, "49-proof.pkla"),
      "/etc/polkit-1/localauthority/50-local.d/49-proof.pkla",
    );
  }
  sudo("systemctl", "restart", "polkit");
  spawn("Xvfb", [DISPLAY, "-screen", "0", "1280x800x24"], {
    detached: true,
    stdio: "ignore",
  }).unref();
  await new Promise((resolve) => server.listen(FEED_PORT, "127.0.0.1", resolve));

  if (phases.includes("update")) {
    log("== update: previous to candidate through the updater");
    sudo("apt-get", "install", "-y", previousDeb);
    if (installedVersion() !== previous) fail(`Installed ${installedVersion()}, not ${previous}`);
    pointInstallAtFeed();
    setFeed(candidate, candidateDeb);
    launch();
    const before = await waitForApp(previous);
    await downloadOffered(candidate);
    const runs = pkexecRuns();
    await install();
    await until("dpkg to hold the candidate", 180_000, () => installedVersion() === candidate);
    const after = await waitForApp(candidate);
    if (after.pid === before.pid) fail("The app did not restart into the candidate");
    if (pkexecRuns() <= runs) fail("The install never ran through pkexec");
    const updated = await until("the updated app", 30_000, appPid);
    if (noNewPrivileges(updated))
      fail(`App ${updated} runs under no_new_privs after the update, so its next install fails`);
    const runtimeDir = SESSION_ENV.XDG_RUNTIME_DIR;
    const leftover = readdirSync(runtimeDir).filter((name) =>
      name.startsWith("specwithcode-clean-restart-"),
    );
    if (leftover.length > 0) fail(`The clean restart left its environment file: ${leftover}`);
    log("update: passed");
  } else {
    sudo("apt-get", "install", "-y", candidateDeb);
  }

  if (phases.includes("retry")) {
    log("== retry: a package dpkg refuses, then Retry");
    writeFileSync(join(evidence, "refused.deb"), "this is not a Debian package\n");
    setFeed(next, join(evidence, "refused.deb"));
    await relaunchOnFeed(candidate);
    await downloadOffered(next);
    const before = await until("the app process", 30_000, appPid);
    await install();
    const failed = await until("the reason for the failed install", 180_000, async () => {
      const state = await updateState();
      return state.lastInstallFailure?.targetVersion === next ? state.lastInstallFailure : false;
    });
    log(`failure recorded: ${failed.reason}`);
    if (!/Debian format|dpkg/i.test(failed.reason)) fail(`Unhelpful reason: ${failed.reason}`);
    if (installedVersion() !== candidate) fail(`dpkg holds ${installedVersion()}`);
    await downloadOffered(next);
    const retryFrom = await until("the app process", 30_000, appPid);
    log(`retry from pid ${retryFrom} (first attempt from ${before})`);
    const beforeClick = await updateState();
    if (beforeClick.status === "error")
      fail(`Already in error before Retry: ${beforeClick.message}`);
    const installsBefore = pkexecRuns();
    // The window may still be loading: wait for the button instead of reading once.
    await until("the Retry update button", 60_000, () =>
      evaluate(
        `(() => { const b = [...document.querySelectorAll("button")].find((x) => /Retry update/.test(x.textContent)); if (!b) return false; b.click(); return true; })()`,
      ).catch(() => false),
    ).catch(async (error) => {
      const buttons = await evaluate(
        `[...document.querySelectorAll("button")].map((x) => x.textContent.trim()).filter(Boolean).join(" | ")`,
      ).catch(() => "unreadable");
      fail(`${error.message}. Buttons: ${buttons}`);
    });
    log("clicked Retry update");
    // A new pid or error is not enough: pkexec refused under no_new_privs does both.
    await until("Retry to reach dpkg", 120_000, () => pkexecRuns() > installsBefore);
    // It reported this attempt too, from the process it relaunched into.
    await until("the relaunch after Retry", 120_000, () => {
      const pid = appPid();
      return pid !== null && pid !== retryFrom;
    });
    await waitForApp(candidate);
    log("retry: passed");
  }

  if (phases.includes("replaced")) {
    log("== replaced: a package replaces the running binary");
    const installed = installedVersion();
    writeFileSync(join(evidence, "refused.deb"), "this is not a Debian package\n");
    setFeed(next, join(evidence, "refused.deb"));
    await relaunchOnFeed(installed);
    await downloadOffered(next);
    const before = await until("the app process", 30_000, appPid);
    sudo("apt-get", "install", "-y", "--allow-downgrades", previousDeb);
    const link = readlinkSync(`/proc/${before}/exe`);
    if (!link.endsWith(" (deleted)")) fail(`Binary not replaced: ${link}`);
    const runs = pkexecRuns();
    await install();
    const after = await waitForApp(previous);
    if (after.pid === before) fail("The app did not relaunch");
    if (pkexecRuns() !== runs) fail("The relaunch ran the updater's install");
    log(`replaced: passed, ${installed} relaunched into ${previous}`);
  }
};

const collect = () => {
  const home = process.env.HOME;
  for (const command of [
    `cp -r ${home}/.specwithcode/userdata/logs ${evidence}/logs 2>/dev/null`,
    `journalctl --no-pager -S "-60min" > ${evidence}/journal.txt 2>/dev/null`,
    `cp /var/log/dpkg.log ${evidence}/dpkg.log 2>/dev/null`,
    `rm -f ${evidence}/refused.deb`,
  ]) {
    spawnSync("bash", ["-c", command]);
  }
};

let code = 0;
try {
  await prove();
  log(`PASSED ${phases.join(" ")}`);
} catch (error) {
  console.error(`::error::Linux update proof failed: ${error.message}`);
  code = 1;
}
collect();
const pid = appPid();
if (pid !== null) spawnSync("kill", [String(pid)]);
process.exit(code);
