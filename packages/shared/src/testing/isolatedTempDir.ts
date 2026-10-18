// @effect-diagnostics nodeBuiltinImport:off - runs once at test setup, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll } from "vite-plus/test";

// Many tests make temp directories and never remove them, and a run that is
// killed skips every cleanup hook. Point the OS temp directory at one fresh
// directory per test file, so everything the file and its child processes
// create under os.tmpdir() goes away together when the file finishes. Node
// reads TMPDIR (TEMP/TMP on Windows) on every os.tmpdir() call. The prefix is
// short because macOS limits Unix socket paths to 104 bytes.
const parent = NodeOS.tmpdir();
const directory = NodeFS.mkdtempSync(NodePath.join(parent, "vt-"));
const previous = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };

process.env.TMPDIR = directory;
if (process.platform === "win32") {
  process.env.TEMP = directory;
  process.env.TMP = directory;
}

afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  NodeFS.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
});
