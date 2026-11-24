/**
 * Two real servers and two apps: one question pops up on exactly one app, on
 * the thread's own machine while a person is at it (1436).
 * Run by scripts/studio-logical-projects/notify-active.mjs, which starts the
 * servers and passes them in STUDIO_NOTIFY_ACTIVE_PROOF; skipped otherwise.
 * Each app holds a socket to each server and reports activity as a desktop
 * window does, then applies the app's own delivery and raise rules to what
 * the server elected.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the proof writes its results for the runner.
import * as NodeFS from "node:fs";
import { raisesAttention } from "@specweave-studio/client-runtime/state/projectAttention";
import type { BackgroundPolicySnapshot, EnvironmentId } from "@specweave-studio/contracts";
import { afterAll, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./lib/backgroundActivityReporter", () => ({
  appClientId: (clientId: string) => clientId.split(":")[0],
}));

import {
  decideNotificationDelivery,
  isNotificationTarget,
  notificationTargetFromSnapshot,
} from "./notificationTarget";
import { ownerHoldsAlert } from "./notificationOwnerHold";

interface ProofHost {
  readonly label: string;
  readonly origin: string;
  readonly token: string;
  readonly environmentId: EnvironmentId;
}

const raw = process.env.STUDIO_NOTIFY_ACTIVE_PROOF;
const hosts: readonly ProofHost[] = raw ? JSON.parse(raw) : [];
const results: Array<Record<string, unknown>> = [];

class Socket {
  private next = 0;
  private readonly waiting = new Map<string, (exit: { _tag: string; value?: unknown }) => void>();
  private constructor(
    private readonly socket: WebSocket,
    readonly host: ProofHost,
  ) {
    socket.addEventListener("message", (event) => {
      const parsed = JSON.parse(String(event.data));
      for (const value of Array.isArray(parsed) ? parsed : [parsed]) {
        if (value._tag !== "Exit") continue;
        this.waiting.get(String(value.requestId))?.(value.exit);
        this.waiting.delete(String(value.requestId));
      }
    });
  }

  static async open(host: ProofHost): Promise<Socket> {
    const response = await fetch(`${host.origin}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: host.origin,
        Authorization: `Bearer ${host.token}`,
      },
    });
    expect(response.status).toBe(200);
    const { ticket } = (await response.json()) as { ticket: string };
    const url = new URL(host.origin);
    url.protocol = "ws:";
    url.pathname = "/ws";
    url.searchParams.set("wsTicket", ticket);
    url.searchParams.set("orchestrationProtocol", "2");
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error(`${host.label} socket failed`)), {
        once: true,
      });
    });
    return new Socket(socket, host);
  }

  rpc<A>(tag: string, payload: unknown): Promise<A> {
    this.next += 1;
    const id = String(this.next);
    return new Promise<A>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${this.host.label} ${tag} timed out`)),
        10_000,
      );
      this.waiting.set(id, (exit) => {
        clearTimeout(timer);
        if (exit._tag === "Success") resolve(exit.value as A);
        else reject(new Error(`${this.host.label} ${tag}: ${JSON.stringify(exit).slice(0, 500)}`));
      });
      this.socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  }

  close() {
    this.socket.close();
  }
}

/** One app: a desktop window connected to every machine, its primary on `home`. */
class App {
  readonly sockets = new Map<EnvironmentId, Socket>();
  lastInteractionAtMs: number | null = null;
  focused = false;
  ttlMs = 45_000;
  constructor(
    readonly clientId: string,
    readonly home: ProofHost,
  ) {}

  async connect() {
    for (const host of hosts) this.sockets.set(host.environmentId, await Socket.open(host));
  }

  async report() {
    const observedAt = new Date().toISOString();
    for (const [environmentId, socket] of this.sockets)
      await socket.rpc("server.reportClientActivity", {
        environmentId,
        clientId: this.clientId,
        clientKind: "desktop-renderer",
        visible: this.focused,
        focused: this.focused,
        recentlyInteracted: false,
        appState: this.focused ? "active" : "background",
        scopes: [],
        ttlMs: this.ttlMs,
        observedAt,
        hostEnvironmentId: this.home.environmentId,
        ...(this.lastInteractionAtMs === null
          ? {}
          : { lastInteractionAt: new Date(this.lastInteractionAtMs).toISOString() }),
      });
  }

  sleep() {
    for (const socket of this.sockets.values()) socket.close();
    this.sockets.clear();
  }
}

/** What each awake app does with one question on `serving`, owned there. */
async function ask(apps: readonly App[], serving: ProofHost, label: string) {
  const reader = await Socket.open(serving);
  const snapshot = await reader.rpc<BackgroundPolicySnapshot>("server.getBackgroundPolicy", {});
  reader.close();
  const read = notificationTargetFromSnapshot(serving.environmentId, snapshot);
  const outcome = Object.fromEntries(
    apps.map((app) => {
      const delivery = decideNotificationDelivery({
        read,
        ownClientId: app.clientId,
        ownEnvironmentId: app.home.environmentId,
        servingEnvironmentId: serving.environmentId,
        ownerMachineId: serving.environmentId,
        ownerReachable: true,
      });
      const counts = raisesAttention({
        ownEnvironmentId: app.home.environmentId,
        ownerMachineId: serving.environmentId,
        isTarget: isNotificationTarget(read, app.clientId),
        ownerReachable: true,
      });
      return [app.clientId, { delivery, counts }];
    }),
  );
  results.push({ scenario: label, target: snapshot.notificationTarget ?? "absent", outcome });
  return outcome;
}

const popups = (outcome: Record<string, { delivery: string }>) =>
  Object.entries(outcome)
    .filter(([, value]) => value.delivery === "post")
    .map(([clientId]) => clientId);

describe.skipIf(hosts.length !== 2)("one question, one popup, across two real servers", () => {
  afterAll(() => {
    const file = process.env.STUDIO_NOTIFY_ACTIVE_RESULTS;
    if (file) NodeFS.writeFileSync(file, JSON.stringify(results, null, 2) + "\n");
  });

  it("follows the device the person uses", async () => {
    const [desk, laptop] = hosts as [ProofHost, ProofHost];
    const deskApp = new App("app-desk", desk);
    const laptopApp = new App("app-laptop", laptop);
    await deskApp.connect();
    await laptopApp.connect();

    // Nobody has touched anything yet: the app on the thread's own machine.
    await deskApp.report();
    await laptopApp.report();
    let outcome = await ask([deskApp, laptopApp], desk, "no interaction yet");
    expect(popups(outcome)).toEqual(["app-desk"]);

    // He last typed on the desk machine.
    deskApp.lastInteractionAtMs = Date.now() - 5_000;
    await deskApp.report();
    outcome = await ask([deskApp, laptopApp], desk, "typed on the desk machine");
    expect(popups(outcome)).toEqual(["app-desk"]);
    expect(outcome["app-laptop"]).toEqual({ delivery: "none", counts: false });

    // He moves the mouse on the laptop: the next alert pops up there, the desk badges.
    laptopApp.lastInteractionAtMs = Date.now();
    await laptopApp.report();
    outcome = await ask([deskApp, laptopApp], desk, "moved the mouse on the laptop");
    expect(popups(outcome)).toEqual(["app-laptop"]);
    expect(outcome["app-desk"]).toEqual({ delivery: "badge", counts: true });
    expect(outcome["app-laptop"]).toEqual({ delivery: "post", counts: true });

    // A focused desk window wins over the laptop it was idle against.
    deskApp.focused = true;
    await deskApp.report();
    outcome = await ask([deskApp, laptopApp], desk, "desk window focused");
    expect(popups(outcome)).toEqual(["app-desk"]);
    deskApp.focused = false;
    await deskApp.report();

    // Both idle: the one used last.
    outcome = await ask([deskApp, laptopApp], desk, "both idle");
    expect(popups(outcome)).toEqual(["app-laptop"]);

    // A question on the laptop's own server, with the person on the laptop.
    outcome = await ask([deskApp, laptopApp], laptop, "question on the laptop server");
    expect(popups(outcome)).toEqual(["app-laptop"]);

    // The desk machine sleeps after he typed on it last: its lease runs out
    // (45 s in use; one second here) and the laptop pops up.
    deskApp.lastInteractionAtMs = Date.now();
    deskApp.ttlMs = 1_000;
    await deskApp.report();
    deskApp.sleep();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    outcome = await ask([laptopApp], desk, "desk machine asleep");
    expect(popups(outcome)).toEqual(["app-laptop"]);

    laptopApp.sleep();
  });

  it("shows on the owner machine while a person is at it, elsewhere once it is idle (1436)", async () => {
    const [desk, laptop] = hosts as [ProofHost, ProofHost];
    const deskApp = new App("app-desk-1436", desk);
    const laptopApp = new App("app-laptop-1436", laptop);
    await deskApp.connect();
    await laptopApp.connect();
    const deskPower = await Socket.open(desk);
    /** The desk machine's own idle reading, as its desktop shell reports it. */
    const deskInput = (idleSeconds: number, extra: Record<string, unknown> = {}) =>
      deskPower.rpc("server.reportHostPowerState", {
        source: "electron-main",
        idle: idleSeconds >= 60 ? "true" : "false",
        idleSeconds,
        locked: "false",
        suspended: false,
        onBattery: "false",
        lowPowerMode: "unknown",
        thermalState: "nominal",
        stale: false,
        updatedAt: new Date().toISOString(),
        ...extra,
      });

    /** What each app does, with the hold rule: the owner machine's server is `serving`'s. */
    async function askOwner(label: string) {
      const reader = await Socket.open(desk);
      const snapshot = await reader.rpc<BackgroundPolicySnapshot>("server.getBackgroundPolicy", {});
      reader.close();
      const read = notificationTargetFromSnapshot(desk.environmentId, snapshot);
      const outcome = Object.fromEntries(
        [deskApp, laptopApp].map((app) => {
          const hold = ownerHoldsAlert({
            ownEnvironmentId: app.home.environmentId,
            ownerMachineId: desk.environmentId,
            ownerReachable: true,
            ownerRead: read,
          });
          const delivery = hold.hold
            ? "held-back"
            : app.focused
              ? "toast"
              : decideNotificationDelivery({
                  read,
                  ownClientId: app.clientId,
                  ownEnvironmentId: app.home.environmentId,
                  servingEnvironmentId: desk.environmentId,
                  ownerMachineId: desk.environmentId,
                  ownerReachable: true,
                  ownerRead: app.home.environmentId === desk.environmentId ? read : undefined,
                });
          return [app.clientId, delivery];
        }),
      );
      results.push({
        scenario: label,
        target: snapshot.notificationTarget ?? "absent",
        ownerInUse: snapshot.ownerInUse ?? "absent",
        outcome,
      });
      return { outcome, ownerInUse: snapshot.ownerInUse };
    }
    const shown = (outcome: Record<string, string>) =>
      Object.entries(outcome)
        .filter(([, delivery]) => delivery === "post" || delivery === "toast")
        .map(([clientId]) => clientId);

    // He works in another program on the desk machine; the laptop's window is
    // in front and was clicked last, so the laptop is the elected target.
    deskApp.lastInteractionAtMs = Date.now() - 60_000;
    laptopApp.focused = true;
    laptopApp.lastInteractionAtMs = Date.now();
    await deskApp.report();
    await laptopApp.report();
    await deskInput(20);
    let result = await askOwner("desk in use (input 20 s ago), laptop window focused");
    expect(result.ownerInUse).toBe(true);
    expect(result.outcome).toEqual({ "app-desk-1436": "post", "app-laptop-1436": "held-back" });

    // The desk machine idle for ten minutes: the laptop toasts, the desk badges.
    await deskInput(600);
    result = await askOwner("desk idle 10 min, laptop window focused");
    expect(result.ownerInUse).toBe(false);
    expect(shown(result.outcome)).toEqual(["app-laptop-1436"]);
    expect(result.outcome["app-desk-1436"]).toBe("badge");

    // He switched to the laptop 121 s after his last input on the desk: the
    // desk's popup stops and the laptop shows it.
    await deskInput(121);
    result = await askOwner("121 s after the last desk input");
    expect(result.ownerInUse).toBe(false);
    expect(shown(result.outcome)).toEqual(["app-laptop-1436"]);

    // An agent drives the desk machine: its input does not count as a person.
    await deskInput(1, { lastAgentInputAtMs: Date.now() - 2_000 });
    result = await askOwner("agent-injected input on the desk 2 s ago");
    expect(result.ownerInUse).toBe(false);
    expect(shown(result.outcome)).toEqual(["app-laptop-1436"]);

    deskPower.close();
    deskApp.sleep();
    laptopApp.sleep();
  });
});
