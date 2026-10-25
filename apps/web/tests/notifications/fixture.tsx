import { createRoot } from "react-dom/client";
import { NotificationSettings } from "../../src/components/settings/NotificationSettings";
import "./fixture.css";

// Deterministic transport boundary, never an OS permission bypass. The production UI is real.
const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "browser";
const events: unknown[] = [];
let permission: NotificationPermission = scenario === "denied" ? "denied" : "default";
class FixtureNotification extends EventTarget {
  static get permission() {
    return permission;
  }
  static async requestPermission() {
    events.push("permission-request");
    permission = scenario === "denied" ? "denied" : "granted";
    return permission;
  }
  constructor(title: string, options: NotificationOptions) {
    super();
    events.push({ title, options });
  }
  close() {
    events.push("closed");
  }
}
Object.defineProperty(window, "Notification", {
  configurable: true,
  value: scenario === "unsupported" ? undefined : FixtureNotification,
});
if (scenario.startsWith("native"))
  Object.assign(window, {
    desktopBridge: {
      showThreadNotification: async (input: unknown) => {
        events.push(input);
        return scenario !== "native-refused";
      },
      closeThreadNotification: async (tag: string) => {
        events.push({ close: tag });
      },
    },
  });
Object.assign(window, {
  notificationFixture: {
    events,
    revoke() {
      permission = "denied";
      window.dispatchEvent(new Event("focus"));
    },
  },
});
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-3xl space-y-8 p-6 sm:p-10">
    <header>
      <h1 className="text-xl font-semibold">Notifications</h1>
      <p className="mt-2 text-sm text-muted-foreground">This device</p>
    </header>
    <NotificationSettings />
  </main>,
);
