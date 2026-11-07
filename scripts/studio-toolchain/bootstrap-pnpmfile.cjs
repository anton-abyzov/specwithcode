// Vite+ 1.0.0 installs an unlocked vp-global wrapper before the repository lock.
// npm advertises @types/estree 1.0.10 but its tarball returns 404 (2026-10-29).
// Reuse the repository-reviewed 1.0.9 only for that bootstrap dependency edge.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

function isPinnedBootstrap() {
  try {
    const root = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    return root.name === "vp-global" && root.version === "1.0.0" &&
      root.dependencies?.["vite-plus"] === "1.0.0";
  } catch {
    return false;
  }
}

const bootstrap = isPinnedBootstrap();
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (bootstrap && pkg.name === "estree-walker" && pkg.version === "3.0.3" &&
          pkg.dependencies?.["@types/estree"] === "^1.0.0") {
        pkg.dependencies["@types/estree"] = "1.0.9";
      }
      return pkg;
    },
  },
};
