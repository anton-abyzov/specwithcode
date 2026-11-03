import { createRoot } from "react-dom/client";
import { ModPanes, ModStatusItems } from "../../src/mods/ModPanes";
import { useModsStore } from "../../src/mods/modsStore";
import { parseModStats } from "../../src/mods/protocol";
import { Sidebar, SidebarFooter, SidebarProvider } from "../../src/components/ui/sidebar";
import "./fixture.css";

// The real sidebar icons. Open with
// ?state=live|zero|text|large&theme=light|dark&width=<sidebar px>.
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const state = params.get("state") ?? "live";
const store = useModsStore.getState();
const noop = () => {};
const pressed = ((window as unknown as { pressed: string[] }).pressed = [] as string[]);
const channel = (mod: string) => ({
  runCommand: noop,
  press: noop,
  closePane: noop,
  pressStat: (handler: number) => {
    pressed.push(`${mod}:${handler}`);
    useModsStore.getState().openPane(mod, `list-${handler}`, `List ${handler}`);
  },
});
const standup = (blocked: number) =>
  parseModStats([
    {
      glyph: "blocked",
      count: blocked,
      label: "Blocked",
      detail: "Tasks in open increments marked blocked. Press to see each one and why.",
      onPress: 1,
    },
  ]);
const close = (verify: number) =>
  parseModStats([
    {
      glyph: "verify",
      count: verify,
      label: "To verify",
      detail: "Finished increments with no passing verify since. Press to see them.",
      onPress: 3,
    },
    { glyph: "ready", count: 0, label: "Ready to close", onPress: 4 },
  ]);
store.attach("increment-standup", channel("increment-standup"));
store.attach("ready-to-close", channel("ready-to-close"));
if (state === "live" || state === "text") {
  store.setStatus("increment-standup", null, standup(8));
  store.setStatus("ready-to-close", null, close(6));
}
if (state === "large") store.setStatus("increment-standup", null, standup(4000));
if (state === "zero") {
  store.setStatus("increment-standup", null, standup(0));
  store.setStatus("ready-to-close", null, close(0));
}
if (state === "text") store.setStatus("focus-timer", "Focus 25 min", null);

// Lets the check take counts to zero and back while the sidebar stays mounted.
Object.assign(window, {
  setCounts: (on: boolean) =>
    useModsStore.getState().setStatus("increment-standup", null, on ? standup(8) : null),
  clearVerify: () => useModsStore.getState().setStatus("ready-to-close", null, null),
});

const width = params.get("width") ?? "256";
createRoot(document.getElementById("root")!).render(
  <SidebarProvider style={{ "--sidebar-width": `${width}px` } as React.CSSProperties}>
    <Sidebar>
      <SidebarFooter className="mt-auto">
        <ModStatusItems />
      </SidebarFooter>
    </Sidebar>
    <ModPanes />
  </SidebarProvider>,
);
