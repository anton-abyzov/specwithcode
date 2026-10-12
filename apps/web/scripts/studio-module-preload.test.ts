import { describe, expect, it } from "vite-plus/test";

import studioConfig from "../vite.config";

async function resolvePreloads(hostType: "html" | "js", dependencies: string[]) {
  const config = await (typeof studioConfig === "function"
    ? studioConfig({ command: "build", mode: "production" })
    : studioConfig);
  const preload = config.build?.modulePreload;
  if (!preload || typeof preload !== "object" || !preload.resolveDependencies) {
    throw new Error("The actual Studio production config must bound speculative preloads");
  }
  return preload.resolveDependencies("assets/main.js", dependencies, {
    hostId: hostType === "html" ? "index.html" : "assets/bootstrap.js",
    hostType,
  });
}

describe("Studio production module preloads", () => {
  it("removes the cold dynamic-import JavaScript fanout while keeping required CSS", async () => {
    const optionalModules = Array.from({ length: 147 }, (_, index) => `assets/chunk-${index}.js`);
    expect(await resolvePreloads("js", [...optionalModules, "assets/main.css"])).toEqual([
      "assets/main.css",
    ]);
  });

  it("keeps CSS for entry HTML without speculative JavaScript hints", async () => {
    expect(await resolvePreloads("html", ["assets/main.js", "assets/theme.css"])).toEqual([
      "assets/theme.css",
    ]);
  });

  it("preserves non-JavaScript dependencies and their order", async () => {
    expect(
      await resolvePreloads("js", ["assets/a.css", "assets/font.woff2", "assets/a.js", "assets/b.css"]),
    ).toEqual(["assets/a.css", "assets/font.woff2", "assets/b.css"]);
  });

  it("does not mutate the bundler dependency array", async () => {
    const dependencies = ["assets/main.js", "assets/main.css"];
    await resolvePreloads("js", dependencies);
    expect(dependencies).toEqual(["assets/main.js", "assets/main.css"]);
  });
});
