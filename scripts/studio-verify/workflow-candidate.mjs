import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const installedBinary = NodePath.join(scriptDir, "bin.mjs");
const standalone = NodeFS.existsSync(installedBinary);
const root = standalone ? scriptDir : NodePath.resolve(scriptDir, "../..");
const binary = standalone ? installedBinary : NodePath.join(root, "apps/server/dist/bin.mjs");
if (!process.versions.node.startsWith("22.")) {
  console.error("Run the Studio workflow candidate with Node 22.");
  process.exit(1);
}
if (!NodeFS.existsSync(binary)) {
  console.error("Build the candidate web app and server before launching.");
  process.exit(1);
}
const args = process.argv.slice(2);
if (!args.length) args.push("serve");
if (["serve", "start"].includes(args[0])) {
  if (!args.some((arg) => arg === "--base-dir" || arg.startsWith("--base-dir="))) {
    args.push(
      "--base-dir",
      NodePath.join(NodeOS.homedir(), ".local/share/specweave-studio-workflow-candidate"),
    );
  }
  if (!args.includes("--no-browser")) args.push("--no-browser");
  if (!args.some((arg) => arg === "--host" || arg.startsWith("--host="))) {
    args.push("--host", "127.0.0.1");
  }
  if (!args.some((arg) => arg === "--port" || arg.startsWith("--port="))) {
    const port = await new Promise((resolvePort, reject) => {
      const socket = NodeNet.createServer();
      socket.once("error", () => reject(new Error("Could not allocate a candidate port.")));
      socket.listen(0, "127.0.0.1", () => {
        const address = socket.address();
        socket.close((error) => {
          if (error || !address || typeof address === "string") {
            reject(new Error("Could not allocate a candidate port."));
          } else resolvePort(address.port);
        });
      });
    });
    args.push("--port", String(port));
  }
}
const child = NodeChildProcess.spawn(process.execPath, [binary, ...args], {
  stdio: "inherit",
  cwd: root,
});
child.once("error", () => {
  console.error("Failed to launch the Studio workflow candidate.");
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}
