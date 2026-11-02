// Packaged app entry. Enables the compile cache before the main bundle loads,
// so the cache also covers main.cjs itself.
const { restartWithoutNoNewPrivileges } = require("./linuxCleanRestart.cjs");

if (restartWithoutNoNewPrivileges()) {
  process.exit(0);
} else {
  require("./compileCache.cjs");
  require("./main.cjs");
}
