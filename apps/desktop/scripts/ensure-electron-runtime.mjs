import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";

const require = NodeModule.createRequire(import.meta.url);
// oxlint-disable-next-line studio/no-global-process-runtime -- Standalone repair script has no Effect runtime.
const hostPlatform = NodeOS.platform();
// oxlint-disable-next-line studio/no-global-process-runtime -- Standalone repair script has no Effect runtime.
const hostArch = NodeOS.arch();

function getPlatformPath() {
  switch (hostPlatform) {
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "freebsd":
    case "openbsd":
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(`Electron builds are not available on platform: ${hostPlatform}`);
  }
}

function ensureExecutable(filePath) {
  if (hostPlatform !== "win32") {
    NodeFS.chmodSync(filePath, 0o755);
  }
}

function repairPathFile(electronDir, platformPath) {
  const pathFile = NodePath.join(electronDir, "path.txt");
  const currentPath = NodeFS.existsSync(pathFile)
    ? NodeFS.readFileSync(pathFile, "utf8")
    : undefined;

  if (currentPath !== platformPath) {
    NodeFS.writeFileSync(pathFile, platformPath);
  }
}

function getRequiredRuntimePaths(electronDir, platformPath) {
  const paths = [NodePath.join(electronDir, "dist", platformPath)];

  if (hostPlatform === "darwin") {
    paths.push(
      NodePath.join(electronDir, "dist", "Electron.app", "Contents", "Info.plist"),
      NodePath.join(
        electronDir,
        "dist",
        "Electron.app",
        "Contents",
        "Frameworks",
        "Electron Framework.framework",
        "Electron Framework",
      ),
    );
  }

  return paths;
}

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const LC_SEGMENT_64 = 0x19;

// dyld refuses to load a Mach-O whose segments end past the end of the file, and the
// launch then dies with a macOS "quit unexpectedly" dialog. An interrupted download or
// extraction leaves exactly that: a valid header over a truncated body, which `file`
// still reports as Mach-O. Walk the segment table so a partial runtime is caught here.
export function machOProblem(filePath) {
  let fd;
  try {
    fd = NodeFS.openSync(filePath, "r");
  } catch {
    return "missing";
  }

  try {
    const fileSize = NodeFS.fstatSync(fd).size;
    const read = (position, length) => {
      const buffer = Buffer.alloc(length);
      return NodeFS.readSync(fd, buffer, 0, length, position) === length ? buffer : null;
    };

    const checkSlice = (base, end) => {
      const magic = read(base, 4);
      if (!magic || magic.readUInt32LE(0) !== MH_MAGIC_64) return "not a 64-bit Mach-O";
      const header = read(base, 32);
      if (!header) return "header is truncated";

      const commandCount = header.readUInt32LE(16);
      let offset = base + 32;
      for (let index = 0; index < commandCount; index += 1) {
        const command = read(offset, 8);
        if (!command) return "load commands are truncated";
        const commandSize = command.readUInt32LE(4);
        if (commandSize < 8) return "load command is malformed";
        if (command.readUInt32LE(0) === LC_SEGMENT_64) {
          const segment = read(offset, 72);
          if (!segment) return "segment command is truncated";
          const segmentEnd = Number(segment.readBigUInt64LE(40) + segment.readBigUInt64LE(48));
          if (base + segmentEnd > end) {
            const name = segment.toString("latin1", 8, 24).replace(/\0+$/, "");
            return `segment ${name} ends past the end of the file`;
          }
        }
        offset += commandSize;
      }
      return null;
    };

    const fatHeader = read(0, 8);
    if (!fatHeader || fatHeader.readUInt32BE(0) !== FAT_MAGIC) return checkSlice(0, fileSize);

    const archCount = fatHeader.readUInt32BE(4);
    for (let index = 0; index < archCount; index += 1) {
      const arch = read(8 + index * 20, 20);
      if (!arch) return "fat header is truncated";
      const sliceOffset = arch.readUInt32BE(8);
      const sliceEnd = sliceOffset + arch.readUInt32BE(12);
      if (sliceEnd > fileSize) return "fat slice ends past the end of the file";
      const problem = checkSlice(sliceOffset, sliceEnd);
      if (problem) return problem;
    }
    return null;
  } finally {
    NodeFS.closeSync(fd);
  }
}

function missingRuntimePaths(electronDir, platformPath) {
  return getRequiredRuntimePaths(electronDir, platformPath).filter((runtimePath) => {
    return !NodeFS.existsSync(runtimePath);
  });
}

function invalidRuntimePaths(electronDir, platformPath) {
  if (hostPlatform !== "darwin") {
    return [];
  }

  return [
    NodePath.join(electronDir, "dist", platformPath),
    NodePath.join(
      electronDir,
      "dist",
      "Electron.app",
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Electron Framework",
    ),
  ].filter((runtimePath) => NodeFS.existsSync(runtimePath) && machOProblem(runtimePath) !== null);
}

function runChecked(command, args) {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    stdio: "inherit",
  });

  if (result.status === 0) {
    return;
  }

  throw new Error(
    `${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`,
  );
}

function installElectronRuntime(electronDir, version) {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-electron-"));
  const zipPath = NodePath.join(tempDir, `electron-v${version}-${hostPlatform}-${hostArch}.zip`);

  try {
    runChecked("curl", [
      "-fsSL",
      `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-${hostPlatform}-${hostArch}.zip`,
      "-o",
      zipPath,
    ]);
    if (hostPlatform === "darwin") {
      runChecked("ditto", ["-x", "-k", zipPath, NodePath.join(electronDir, "dist")]);
    } else {
      runChecked("python3", [
        "-c",
        "import os, sys, zipfile; os.makedirs(sys.argv[2], exist_ok=True); zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
        zipPath,
        NodePath.join(electronDir, "dist"),
      ]);
    }
  } finally {
    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function ensureElectronRuntime() {
  const electronDir = resolveElectronDir();
  const electronPackageJson = JSON.parse(
    NodeFS.readFileSync(NodePath.join(electronDir, "package.json"), "utf8"),
  );
  const platformPath = getPlatformPath();
  const electronPath = NodePath.join(electronDir, "dist", platformPath);
  const missingBeforeInstall = missingRuntimePaths(electronDir, platformPath);
  const invalidBeforeInstall = invalidRuntimePaths(electronDir, platformPath);

  if (missingBeforeInstall.length > 0 || invalidBeforeInstall.length > 0) {
    if (NodeFS.existsSync(NodePath.join(electronDir, "dist"))) {
      NodeFS.rmSync(NodePath.join(electronDir, "dist"), { recursive: true, force: true });
    }
    NodeFS.rmSync(NodePath.join(electronDir, "path.txt"), { force: true });
    installElectronRuntime(electronDir, electronPackageJson.version);
  }

  const missingAfterInstall = missingRuntimePaths(electronDir, platformPath);
  const invalidAfterInstall = invalidRuntimePaths(electronDir, platformPath);
  if (missingAfterInstall.length > 0 || invalidAfterInstall.length > 0) {
    throw new Error(
      `Electron runtime is incomplete after install.\nMissing:\n${missingAfterInstall
        .map((runtimePath) => `- ${runtimePath}`)
        .join("\n")}\nInvalid:\n${invalidAfterInstall
        .map((runtimePath) => `- ${runtimePath}`)
        .join("\n")}`,
    );
  }

  ensureExecutable(electronPath);
  repairPathFile(electronDir, platformPath);

  return electronPath;
}

function resolveElectronDir() {
  return NodePath.dirname(require.resolve("electron/package.json"));
}

// Reports what is wrong with the downloaded runtime without repairing it, so callers
// such as tests can skip launching Electron instead of tripping a crash dialog.
export function electronRuntimeProblems() {
  const electronDir = resolveElectronDir();
  const platformPath = getPlatformPath();
  return [
    ...missingRuntimePaths(electronDir, platformPath).map(
      (runtimePath) => `missing: ${runtimePath}`,
    ),
    ...invalidRuntimePaths(electronDir, platformPath).map(
      (runtimePath) => `invalid (${machOProblem(runtimePath)}): ${runtimePath}`,
    ),
  ];
}

// `file://${argv[1]}` never matches on Windows (drive letters need `file:///C:/`).
if (process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.includes("--check")) {
    const problems = electronRuntimeProblems();
    if (problems.length > 0) {
      process.stderr.write(`${problems.join("\n")}\n`);
      process.exitCode = 1;
    }
  } else {
    const electronPath = ensureElectronRuntime();
    process.stdout.write(`${electronPath}\n`);
  }
}
