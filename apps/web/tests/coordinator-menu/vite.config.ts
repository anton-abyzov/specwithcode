import { defineConfig, type Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const app = (path: string) => NodeURL.fileURLToPath(new URL(`../../src/${path}`, import.meta.url));
const here = (path: string) => NodeURL.fileURLToPath(new URL(`./${path}`, import.meta.url));
const composer = (path: string) =>
  NodeURL.fileURLToPath(new URL(`../composer-host-status/${path}`, import.meta.url));
// The switcher and the message box alone: commands, machine colors, the fleet and uploads
// are fixture stand-ins (the message box's are the composer fixture's own).
const LINK_MACHINES = "\0coordinator-menu-link-machines";
const stubs = new Map([
  [app("state/use-atom-command.ts"), here("commands.ts")],
  [app("studio/machineIdentity.ts"), here("machineIdentity.ts")],
  [app("state/use-orchestration-command.ts"), composer("commands.ts")],
  [app("lib/attachmentUploadQueue.ts"), composer("uploads.ts")],
  [app("state/environments.ts"), composer("environments.ts")],
  [app("lib/machineLastSeen.ts"), composer("machineLastSeen.ts")],
  // The Fix dialog's fleet readiness (connections and grants), without a fleet; `?problem=`
  // gives m1 a link problem (the real sentence from `linkMachineProblem`).
  [app("components/studio/useLinkMachines.ts"), LINK_MACHINES],
]);
const linkMachinesSource = `
import { useLinkMachines as ready } from ${JSON.stringify(here("linkMachines.ts"))};
import { linkMachineProblem } from ${JSON.stringify(app("studio/projectLink.ts"))};
export * from ${JSON.stringify(here("linkMachines.ts"))};
export function useLinkMachines() {
  const machines = ready();
  const state = new URLSearchParams(location.search).get("problem");
  if (!state) return machines;
  return {
    ...machines,
    state: (id) => (id === "m1" ? state : "ready"),
    problem: (id) => (id === "m1" ? linkMachineProblem(state, machines.label(id)) : null),
  };
}
`;
const fixtureHost: Plugin = {
  name: "coordinator-menu-host",
  enforce: "pre",
  async resolveId(source, importer, options) {
    if (source === LINK_MACHINES) return LINK_MACHINES;
    // A stand-in imports the module it stands in for.
    if (!importer || [...stubs.values(), here("linkMachines.ts")].includes(importer)) return null;
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    return resolved ? (stubs.get(resolved.id) ?? null) : null;
  },
  load(id) {
    return id === LINK_MACHINES ? linkMachinesSource : null;
  },
};

export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [fixtureHost, react(), tailwindcss()],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/coordinator-menu/site",
    emptyOutDir: true,
  },
});
