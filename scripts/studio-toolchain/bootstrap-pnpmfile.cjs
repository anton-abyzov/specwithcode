// Vite+ installs an unlocked vp-global wrapper, then a frozen pnpm install.
// Vite+ 1.0.0 resolved estree-walker@3.0.3 to @types/estree ^1.0.0, and npm's
// 1.0.10 tarball 404'd (2026-10-29). Rewrite that one edge to the reviewed 1.0.9.
// Vite+ 1.6.0 ships an install lock that already pins @types/estree 1.0.10, and
// that tarball downloads. Exporting hooks for it makes pnpm 10.34.9 hash an
// empty pnpmfile set (a global pnpmfile is not part of the hash) and reject the
// frozen lock with a pnpmfileChecksum mismatch. Export hooks only for 1.0.0.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

function isLegacyBootstrap() {
  try {
    const root = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    return root.name === "vp-global" && root.version === "1.0.0" &&
      root.dependencies?.["vite-plus"] === "1.0.0";
  } catch {
    return false;
  }
}

if (!isLegacyBootstrap()) {
  module.exports = {};
} else {
  module.exports = {
    hooks: {
      readPackage(pkg) {
        if (pkg.name === "estree-walker" && pkg.version === "3.0.3" &&
            pkg.dependencies?.["@types/estree"] === "^1.0.0") {
          pkg.dependencies["@types/estree"] = "1.0.9";
        }
        return pkg;
      },
    },
  };
}
