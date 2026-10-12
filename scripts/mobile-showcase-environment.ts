// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - This host-side fixture creates an isolated local Studio environment.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export const SHOWCASE_PROJECT_ID = "studio";
export const SHOWCASE_THREAD_ID = "remote-command-center";
export const SHOWCASE_TERMINAL_ID = "term-1";

export const SHOWCASE_SCENES = [
  "threads",
  "thread",
  "terminal",
  "review",
  "environments",
  "agent-activity",
] as const;
export type ShowcaseScene = (typeof SHOWCASE_SCENES)[number];

const PROJECTOR_NAMES = [
  "projection.projects",
  "projection.threads",
  "projection.thread-messages",
  "projection.thread-proposed-plans",
  "projection.thread-activities",
  "projection.thread-sessions",
  "projection.thread-turns",
  "projection.checkpoints",
  "projection.pending-approvals",
] as const;

const MODEL_SELECTION = JSON.stringify({ instanceId: "codex", model: "gpt-5.4" });
const PROJECT_SCRIPTS = JSON.stringify([
  {
    id: "dev",
    name: "Dev",
    command: "pnpm dev",
    icon: "play",
    runOnWorktreeCreate: false,
  },
  {
    id: "test",
    name: "Tests",
    command: "pnpm test",
    icon: "test",
    runOnWorktreeCreate: false,
  },
]);

const SHOWCASE_TERMINAL_PROMPT =
  "\u001b[1;32m→\u001b[0m \u001b[1;36mstudio\u001b[0m \u001b[1;34mgit:(\u001b[1;31mfeat/remote-command-center\u001b[1;34m)\u001b[0m \u001b[1;33m✗\u001b[0m ";

// A dev-server startup mirroring the web settings' terminal font preview:
// zsh-style prompt, brand line, addresses, the thread's 612-test summary,
// and a READY badge, so the scene exercises bold, dim, underline, the six
// accent colors, and a background cell.
export const SHOWCASE_TERMINAL_BUFFER = [
  `${SHOWCASE_TERMINAL_PROMPT}vpr dev`,
  "",
  "  \u001b[1;32mVITE\u001b[0m \u001b[32mv7.1.1\u001b[0m  \u001b[2mready in\u001b[0m \u001b[1m1.24s\u001b[0m",
  "",
  "  \u001b[32m→\u001b[0m  \u001b[2mLocal:\u001b[0m    \u001b[4;36mhttp://127.0.0.1:5173/\u001b[0m",
  "  \u001b[32m→\u001b[0m  \u001b[2mNetwork:\u001b[0m  \u001b[4;36mhttp://192.168.1.24:5173/\u001b[0m",
  "  \u001b[32m→\u001b[0m  \u001b[2mProject:\u001b[0m  \u001b[1mstudio\u001b[0m \u001b[2m— ~/Code/studio\u001b[0m",
  "",
  "  \u001b[32m✓ 612 passed\u001b[0m   \u001b[33m△ 2 warnings\u001b[0m   \u001b[31m✗ 0 failed\u001b[0m",
  "",
  "  \u001b[42;30m READY \u001b[0m \u001b[2mwatching for changes — press\u001b[0m \u001b[1mq\u001b[0m \u001b[2mto quit\u001b[0m",
  "",
  SHOWCASE_TERMINAL_PROMPT,
].join("\r\n");

const BASE_ENVIRONMENT_PRESENCE = `export function environmentLabel(count: number): string {
  return \`${"${count}"} environments\`;
}
`;

const UPDATED_ENVIRONMENT_PRESENCE = `const PULSE = ["✦", "✧", "·", "✧"] as const;

export function environmentLabel(connected: number, total: number, frame: number): string {
  const pulse = PULSE[frame % PULSE.length];
  return \`${"${pulse} ${connected}/${total}"} ready\`;
}
`;

const REMOTE_HANDOFF_CARD = `import { View, Text } from "react-native";

export function RemoteHandoffCard(props: { machine: string; latencyMs: number }) {
  return (
    <View className="rounded-2xl bg-surface-2 p-4">
      <Text className="font-semibold">Ready on {props.machine}</Text>
      <Text className="text-success">Handoff in {props.latencyMs}ms</Text>
    </View>
  );
}
`;

const PROJECT_FAVICONS = {
  studio: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><title>SpecWithCode</title><rect width="64" height="64" rx="14.4" fill="#0B1020"/><svg x="7.68" y="7.68" width="48.64" height="48.64" viewBox="89.8 83.6 332.8 332.8"><defs><linearGradient id="g0" gradientUnits="userSpaceOnUse" x1="152.9" y1="134.3" x2="355.6" y2="126.6"><stop offset="0.00" stop-color="#4f5ff8"/><stop offset="0.20" stop-color="#4c69f6"/><stop offset="0.40" stop-color="#408fec"/><stop offset="0.60" stop-color="#3bb1dc"/><stop offset="0.80" stop-color="#3bcfc9"/><stop offset="1.00" stop-color="#3bd9c3"/></linearGradient><linearGradient id="g1" gradientUnits="userSpaceOnUse" x1="164.3" y1="236.8" x2="375.1" y2="242.1"><stop offset="0.00" stop-color="#4056ed"/><stop offset="0.20" stop-color="#4473f1"/><stop offset="0.40" stop-color="#3d9fe6"/><stop offset="0.60" stop-color="#3bbed4"/><stop offset="0.80" stop-color="#3bd7c5"/><stop offset="1.00" stop-color="#3bd9c3"/></linearGradient><linearGradient id="g2" gradientUnits="userSpaceOnUse" x1="260.4" y1="175.7" x2="345.9" y2="187.4"><stop offset="0.00" stop-color="#2e9ed7"/><stop offset="0.20" stop-color="#2ea5d3"/><stop offset="0.40" stop-color="#2aafcd"/><stop offset="0.60" stop-color="#23b5c7"/><stop offset="0.80" stop-color="#1eb8c3"/><stop offset="1.00" stop-color="#20bcc2"/></linearGradient><linearGradient id="g3" gradientUnits="userSpaceOnUse" x1="156.3" y1="297.6" x2="272.8" y2="276.7"><stop offset="0.00" stop-color="#3f4dec"/><stop offset="0.20" stop-color="#4560ee"/><stop offset="0.40" stop-color="#437aeb"/><stop offset="0.60" stop-color="#3c92df"/><stop offset="0.80" stop-color="#36a5d7"/><stop offset="1.00" stop-color="#33b6ce"/></linearGradient><linearGradient id="g4" gradientUnits="userSpaceOnUse" x1="152.7" y1="301.0" x2="314.4" y2="412.8"><stop offset="0.00" stop-color="#505ef7"/><stop offset="0.20" stop-color="#5060f8"/><stop offset="0.40" stop-color="#4b6ff5"/><stop offset="0.60" stop-color="#4197e9"/><stop offset="0.80" stop-color="#33b9d1"/><stop offset="1.00" stop-color="#28c3c5"/></linearGradient></defs><path fill="url(#g2)" fill-rule="evenodd" d="M349.8 185.5 349.2 183.2 349.2 179.8 347.5 174.5 345.0 170.5 340.5 165.8 335.2 161.8 329.5 158.2 323.5 155.2 323.0 155.2 322.0 154.5 315.0 151.8 314.2 151.8 313.5 152.8 292.2 164.5 251.8 184.8 251.8 185.2 260.5 189.5 261.0 189.5 264.8 191.5 265.2 191.5 268.0 193.0 276.8 196.8 279.5 198.2 288.2 202.0 291.5 203.8 292.0 203.8 307.5 211.0 309.0 210.8 319.2 205.8 319.8 205.8 333.5 198.5 341.8 193.0 346.2 189.2Z"/><path fill="url(#g3)" fill-rule="evenodd" d="M282.5 277.5 278.2 275.2 277.8 275.2 268.5 270.8 257.8 266.2 256.0 265.2 249.0 262.5 242.5 259.5 240.8 259.0 237.8 257.5 228.0 253.8 226.8 253.0 224.8 252.5 206.8 260.2 205.0 260.8 202.8 262.0 200.5 262.8 197.8 264.2 191.2 267.0 181.0 272.2 169.2 279.5 164.8 282.8 159.0 287.5 153.0 293.5 153.8 300.8 154.5 303.8 156.2 308.0 158.8 312.2 162.5 317.2 167.2 322.2 171.0 325.5 177.2 330.0 178.0 331.0 178.8 331.5 179.8 331.5 179.2 331.0 188.2 323.8 197.5 317.8 208.0 312.0 208.5 312.0 209.0 311.5 209.5 311.5 223.2 304.8 223.8 304.8 239.8 297.2 240.2 297.2 250.2 292.5 252.5 291.8 255.2 290.2 255.8 290.2 265.8 285.5 271.2 283.2 282.2 278.0Z"/><path fill="url(#g0)" fill-rule="evenodd" d="M358.2 141.8 355.8 134.8 352.2 128.0 347.2 121.2 342.5 116.5 337.8 112.8 331.5 108.8 323.5 104.8 314.5 101.2 304.5 98.2 294.2 96.0 286.8 95.0 286.5 94.8 285.0 94.8 284.8 94.5 282.8 94.5 282.5 94.2 278.2 94.0 278.0 93.8 275.2 93.8 275.0 93.5 272.0 93.5 271.8 93.2 267.0 93.2 266.8 93.0 249.0 93.2 248.8 93.5 240.8 94.0 240.5 94.2 236.8 94.5 236.5 94.8 229.0 95.8 218.8 98.0 211.0 100.5 210.2 100.5 209.5 101.0 208.8 101.0 208.0 101.5 204.0 102.8 195.2 106.5 188.0 110.2 179.8 115.5 174.0 120.0 168.2 125.5 162.5 132.5 158.5 138.8 155.2 145.5 153.2 151.2 151.8 157.2 151.2 162.0 151.0 162.2 151.0 164.8 150.8 165.0 150.8 171.8 151.0 172.0 151.0 175.2 151.2 175.5 151.8 180.2 153.0 185.8 154.5 190.5 158.0 198.2 158.5 198.2 159.0 196.2 159.2 192.0 161.0 186.0 164.2 179.0 166.8 175.0 170.2 170.5 175.5 165.0 180.8 160.5 190.5 154.0 193.0 153.0 195.5 151.2 202.2 148.2 210.2 145.5 215.8 144.2 216.8 143.8 217.8 143.8 224.0 142.2 225.2 142.2 228.5 141.5 230.2 141.5 230.5 141.2 232.2 141.2 232.5 141.0 234.5 141.0 234.8 140.8 240.5 140.5 240.8 140.2 246.2 140.2 246.5 140.0 255.5 140.0 255.8 140.2 261.2 140.2 261.5 140.5 270.2 141.0 270.5 141.2 277.8 142.0 289.8 144.2 304.8 148.2 314.0 151.5 314.2 152.0 315.2 152.5 316.8 152.8 318.5 153.8 321.5 154.8 322.5 155.5 323.0 155.5 329.0 158.5 334.8 162.0 340.0 166.0 343.8 169.8 346.0 172.8 348.0 176.8 349.0 180.2 349.0 183.8 349.5 185.8 352.2 182.5 355.2 178.0 358.5 171.0 360.0 165.0 360.2 161.0 360.5 160.8 360.5 155.2 360.2 155.0 360.0 150.0Z"/><path fill="url(#g4)" fill-rule="evenodd" d="M135.8 327.2 135.5 331.5 135.2 331.8 135.5 339.5 135.8 339.8 136.0 343.0 136.8 346.5 139.5 354.5 142.8 361.0 145.5 365.2 150.0 371.0 156.8 377.8 162.2 382.2 170.5 387.8 184.2 394.8 194.0 398.5 202.2 401.0 211.5 403.2 219.5 404.8 221.0 404.8 221.2 405.0 222.8 405.0 226.5 405.8 228.5 405.8 228.8 406.0 231.0 406.0 231.2 406.2 237.5 406.5 237.8 406.8 242.2 406.8 242.5 407.0 260.0 406.8 260.2 406.5 263.8 406.5 264.0 406.2 271.2 405.8 271.5 405.5 273.2 405.5 273.5 405.2 281.2 404.2 297.8 400.2 308.5 396.5 315.0 393.8 322.5 390.0 330.2 385.5 337.5 380.5 343.8 375.5 354.0 365.5 356.0 363.0 356.0 360.2 356.5 359.0 356.5 357.0 356.8 356.8 356.8 347.5 356.5 347.2 356.5 345.0 355.2 338.5 352.2 329.8 349.0 323.0 344.8 316.2 342.0 313.0 337.2 318.2 332.2 323.0 322.2 330.8 312.8 336.5 304.0 340.8 297.8 343.2 289.2 346.0 283.2 347.5 275.2 349.0 274.0 349.0 273.8 349.2 270.0 349.5 269.8 349.8 264.0 350.0 263.8 350.2 246.8 350.2 246.5 350.0 242.8 350.0 242.5 349.8 237.2 349.5 237.0 349.2 235.0 349.2 234.8 349.0 227.8 348.2 227.5 348.0 226.2 348.0 218.2 346.5 203.5 342.5 196.5 340.0 189.0 336.5 188.5 336.5 183.2 333.8 178.5 330.8 177.8 329.8 172.8 326.2 167.8 322.0 162.8 316.8 159.0 311.8 156.5 307.5 154.5 302.5 153.8 298.5 153.8 296.0 153.5 295.8 153.2 293.2 150.0 296.8 146.5 301.2 142.0 308.5 138.8 315.8 137.0 321.2Z"/><path fill="url(#g1)" fill-rule="evenodd" d="M177.5 162.5 172.2 167.5 166.0 175.2 161.8 183.0 160.0 187.8 159.0 191.5 158.8 195.8 158.0 198.2 162.0 204.8 166.5 210.2 171.2 215.0 178.2 220.8 185.8 225.8 193.5 230.2 213.5 240.2 214.0 240.2 218.5 242.5 231.2 248.0 234.2 249.0 240.2 251.8 257.5 258.8 259.2 259.8 261.0 260.2 263.2 261.5 265.5 262.2 276.5 267.5 277.0 267.5 292.2 275.0 302.8 280.8 310.5 285.5 318.5 291.0 325.2 296.2 331.8 302.0 335.8 306.0 341.5 312.5 341.8 313.8 344.5 316.8 346.5 319.8 351.0 328.0 354.5 337.2 356.2 345.5 356.5 356.2 356.2 356.5 356.2 358.5 355.8 359.8 355.8 363.2 357.8 361.0 364.0 352.2 367.2 346.8 371.0 339.0 374.0 330.8 375.5 325.0 376.2 319.8 376.5 319.5 376.8 315.5 377.0 315.2 377.0 312.0 377.2 311.8 377.0 296.2 376.8 296.0 376.8 294.0 376.5 293.8 375.8 287.8 374.0 280.8 371.0 272.5 367.8 265.8 363.8 259.2 357.2 251.0 351.2 245.0 342.0 237.5 334.5 232.5 323.8 226.2 304.2 216.5 303.8 216.5 294.0 211.8 289.0 209.8 286.2 208.2 283.5 207.2 271.0 201.2 264.5 198.5 259.8 196.0 256.0 194.5 238.2 185.8 225.2 178.5 215.5 172.0 206.0 164.2 198.0 156.0 195.2 152.5 195.0 151.8 195.5 151.2 194.8 151.2 192.5 152.8 192.0 152.8 187.5 155.2 182.2 158.8Z"/></svg></svg>`,
  react: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="15" fill="#20232a"/>
  <g fill="none" stroke="#61dafb" stroke-width="2.8"><ellipse cx="32" cy="32" rx="25" ry="9"/><ellipse cx="32" cy="32" rx="25" ry="9" transform="rotate(60 32 32)"/><ellipse cx="32" cy="32" rx="25" ry="9" transform="rotate(120 32 32)"/></g>
  <circle cx="32" cy="32" r="4.8" fill="#61dafb"/>
</svg>`,
  linux: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="15" fill="#f7c948"/>
  <ellipse cx="32" cy="35" rx="17" ry="22" fill="#202124"/>
  <ellipse cx="32" cy="40" rx="12" ry="14" fill="#f5f5f2"/>
  <circle cx="27" cy="24" r="5" fill="white"/><circle cx="37" cy="24" r="5" fill="white"/>
  <circle cx="28" cy="25" r="2"/><circle cx="36" cy="25" r="2"/>
  <path d="M27 31l5-4 5 4-5 4z" fill="#f28c28"/><path d="M16 55h14l-7-5zM34 55h14l-7-5z" fill="#f28c28"/>
</svg>`,
} as const;

export const SHOWCASE_PROJECTS = [
  {
    id: "studio",
    title: "SpecWithCode",
    directory: "studio",
    repositoryUrl: "https://github.com/anton-abyzov/specwithcode.git",
    favicon: PROJECT_FAVICONS.studio,
  },
  {
    id: "react",
    title: "React",
    directory: "react",
    repositoryUrl: "https://github.com/facebook/react.git",
    favicon: PROJECT_FAVICONS.react,
  },
  {
    id: "linux",
    title: "Linux",
    directory: "linux",
    repositoryUrl: "https://github.com/torvalds/linux.git",
    favicon: PROJECT_FAVICONS.linux,
  },
] as const;

export const SHOWCASE_ENVIRONMENTS = [
  {
    id: "moonbase-terminal",
    label: "Moonbase Terminal",
    projectIds: ["studio"],
  },
  {
    id: "suspense-station",
    label: "Suspense Station",
    projectIds: ["react"],
  },
  {
    id: "kernel-cabin",
    label: "Kernel Cabin",
    projectIds: ["linux"],
  },
] as const;

export const SHOWCASE_THREADS = [
  {
    id: SHOWCASE_THREAD_ID,
    projectId: "studio",
    title: "Make remote coding feel local ✦",
    branch: "feat/remote-command-center",
    minutesAgo: 3,
    request:
      "Give SpecWithCode a remote-first command center. Make three machines feel one tap away, keep agent work in sync, and make every handoff feel instant.",
    response:
      "SpecWithCode now treats every machine like it is right here in the room. ✦\n\n- Moonbase, Suspense Station, and Kernel Cabin stay live together\n- Terminal state follows you without losing a single line\n- Agent work remains perfectly in sync across devices\n- Handoffs land before your train of thought can wander\n\nI also ran the changed workspace: **612 tests passed**.",
  },
  {
    id: "pocket-command-center",
    projectId: "studio",
    title: "Put the command center in your pocket",
    branch: "feat/pocket-command-center",
    minutesAgo: 21,
    state: "approval" as const,
    request: "Make switching between desktop, phone, and tablet feel like one continuous session.",
    response:
      "The handoff flow preserves the selected thread, terminal buffer, and working diff. The final motion treatment is ready for approval.",
  },
  {
    id: "buttery-suspense",
    projectId: "react",
    title: "Make Suspense transitions buttery",
    branch: "perf/buttery-suspense",
    minutesAgo: 12,
    state: "working" as const,
    request:
      "Trace the last few dropped frames in nested Suspense transitions and make them disappear.",
    response: null,
  },
  {
    id: "hydration-haikus",
    projectId: "react",
    title: "Turn hydration warnings into haikus",
    branch: "dev/hydration-haikus",
    minutesAgo: 44,
    request:
      "Keep hydration errors precise, but make the development copy unexpectedly delightful.",
    response:
      "The diagnostics still lead with the exact mismatch and component stack. A tiny optional haiku now closes the expanded explanation.",
    snoozeMinutes: 90,
  },
  {
    id: "beautiful-boot",
    projectId: "linux",
    title: "Make boot logs oddly beautiful",
    branch: "feat/beautiful-boot",
    minutesAgo: 34,
    state: "plan" as const,
    request:
      "Design a clearer boot timeline that remains useful over serial and never hides kernel detail.",
    response:
      "The plan groups milestones without changing the underlying log stream, preserves plain-text output, and adds zero work to the hot path.",
  },
  {
    id: "patient-penguins",
    projectId: "linux",
    title: "Teach penguins to wait patiently",
    branch: "feat/patient-penguins",
    minutesAgo: 52,
    request: "Make delayed work easier to follow without adding noise to the scheduler trace.",
    response:
      "Delayed work now carries a concise reason through the trace, so the wait is legible without changing scheduling behavior.",
    snoozeMinutes: 8 * 60,
  },
  // Finished work, settled by hand: the list keeps it as a receded tail so
  // the active block above reads as everything still in flight. The active
  // block stays small enough that the settled tail begins above the fold —
  // a store screenshot has to show that history exists, not just imply it.
  {
    id: "handoff-haptics",
    projectId: "studio",
    title: "Tune the handoff haptics",
    branch: "feat/handoff-haptics",
    minutesAgo: 5 * 60,
    settled: true,
    request: "Give the desktop-to-phone handoff a haptic that lands with the animation.",
    response:
      "The handoff now taps once as the thread lands and stays silent on failure, so the phone never celebrates a handoff that did not happen.",
  },
  {
    id: "streaming-shell",
    projectId: "react",
    title: "Stream the shell before the data",
    branch: "feat/streaming-shell",
    minutesAgo: 28 * 60,
    settled: true,
    request: "Get the app shell painted before any data request resolves.",
    response:
      "The shell now flushes on first byte and the data boundaries hydrate underneath it, so the first paint no longer waits on the slowest query.",
  },
  {
    id: "quieter-oom",
    projectId: "linux",
    title: "Make the OOM killer explain itself",
    branch: "feat/quieter-oom",
    minutesAgo: 2 * 24 * 60,
    settled: true,
    request: "Make out-of-memory kills legible without adding a single allocation to the hot path.",
    response:
      "Kills now report the winning heuristic and the runner-up alongside the usual dump, assembled entirely from data the path already had.",
  },
] as const;

function minutesBefore(now: number, minutes: number): string {
  return new Date(now - minutes * 60_000).toISOString();
}

async function runGit(workspaceRoot: string, args: ReadonlyArray<string>): Promise<void> {
  await execFile("git", [...args], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Alex Rivera",
      GIT_AUTHOR_EMAIL: "alex@lumen.test",
      GIT_COMMITTER_NAME: "Alex Rivera",
      GIT_COMMITTER_EMAIL: "alex@lumen.test",
    },
  });
}

async function initializeRepository(input: {
  readonly workspaceRoot: string;
  readonly repositoryUrl: string;
  readonly commitMessage: string;
}): Promise<void> {
  await runGit(input.workspaceRoot, ["init", "-b", "main"]);
  await runGit(input.workspaceRoot, ["remote", "add", "origin", input.repositoryUrl]);
  await runGit(input.workspaceRoot, ["add", "."]);
  await runGit(input.workspaceRoot, ["commit", "-m", input.commitMessage]);
}

async function seedSpecWeaveStudioWorkspace(workspaceRoot: string): Promise<void> {
  await NodeFSP.mkdir(NodePath.join(workspaceRoot, "apps/mobile/src/features/home"), {
    recursive: true,
  });
  await NodeFSP.writeFile(
    NodePath.join(workspaceRoot, "package.json"),
    `${JSON.stringify({ name: "studio", private: true, scripts: { test: "vp test" } }, null, 2)}\n`,
  );
  await NodeFSP.writeFile(NodePath.join(workspaceRoot, "favicon.svg"), PROJECT_FAVICONS.studio);
  await NodeFSP.writeFile(
    NodePath.join(workspaceRoot, "apps/mobile/src/features/home/environmentPresence.ts"),
    BASE_ENVIRONMENT_PRESENCE,
  );
  await initializeRepository({
    workspaceRoot,
    repositoryUrl: "https://github.com/anton-abyzov/specwithcode.git",
    commitMessage: "Show connected environments",
  });
  await runGit(workspaceRoot, ["checkout", "-b", "feat/remote-command-center"]);
  await NodeFSP.writeFile(
    NodePath.join(workspaceRoot, "apps/mobile/src/features/home/environmentPresence.ts"),
    UPDATED_ENVIRONMENT_PRESENCE,
  );
  await NodeFSP.writeFile(
    NodePath.join(workspaceRoot, "apps/mobile/src/features/home/RemoteHandoffCard.tsx"),
    REMOTE_HANDOFF_CARD,
  );
}

async function seedCompanionWorkspace(input: {
  readonly workspaceRoot: string;
  readonly title: string;
  readonly repositoryUrl: string;
  readonly favicon: string;
}): Promise<void> {
  await NodeFSP.mkdir(input.workspaceRoot, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(input.workspaceRoot, "favicon.svg"), input.favicon);
  await NodeFSP.writeFile(
    NodePath.join(input.workspaceRoot, "README.md"),
    `# ${input.title}\n\nSeeded by the SpecWithCode mobile screenshot harness.\n`,
  );
  await initializeRepository({
    workspaceRoot: input.workspaceRoot,
    repositoryUrl: input.repositoryUrl,
    commitMessage: `Seed ${input.title} workspace`,
  });
}

function insertThread(
  database: NodeSqlite.DatabaseSync,
  now: number,
  input: {
    readonly id: string;
    readonly projectId: string;
    readonly title: string;
    readonly branch: string;
    readonly minutesAgo: number;
    readonly state?: "working" | "approval" | "plan";
    readonly settled?: boolean;
    readonly snoozeMinutes?: number;
    readonly workspaceRoot: string;
  },
): void {
  const turnId = `${input.id}-turn`;
  const updatedAt = minutesBefore(now, input.minutesAgo);
  const isWorking = input.state === "working";
  const snoozedUntil =
    input.snoozeMinutes === undefined
      ? null
      : new Date(now + input.snoozeMinutes * 60_000).toISOString();
  const snoozedAt =
    input.snoozeMinutes === undefined
      ? null
      : minutesBefore(now, Math.max(1, Math.floor(input.minutesAgo / 2)));
  database
    .prepare(
      `INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        branch, worktree_path, latest_turn_id, latest_user_message_at, pending_approval_count,
        pending_user_input_count, has_actionable_proposed_plan, created_at, updated_at,
        archived_at, deleted_at, settled_override, settled_at, snoozed_until, snoozed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.projectId,
      input.title,
      MODEL_SELECTION,
      "full-access",
      input.state === "plan" ? "plan" : "default",
      input.branch,
      input.workspaceRoot,
      turnId,
      minutesBefore(now, input.minutesAgo + 1),
      input.state === "approval" ? 1 : 0,
      input.state === "plan" ? 1 : 0,
      minutesBefore(now, input.minutesAgo + 120),
      updatedAt,
      input.settled ? "settled" : null,
      input.settled ? updatedAt : null,
      snoozedUntil,
      snoozedAt,
    );
  database
    .prepare(
      `INSERT INTO projection_turns (
        thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at,
        started_at, completed_at, checkpoint_turn_count, checkpoint_ref, checkpoint_status,
        checkpoint_files_json, source_proposed_plan_thread_id, source_proposed_plan_id
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, '[]', NULL, NULL)`,
    )
    .run(
      input.id,
      turnId,
      isWorking ? null : `${input.id}-answer`,
      isWorking ? "running" : "completed",
      minutesBefore(now, input.minutesAgo + 2),
      minutesBefore(now, input.minutesAgo + 2),
      isWorking ? null : updatedAt,
    );
  database
    .prepare(
      `INSERT INTO projection_thread_sessions (
        thread_id, status, provider_name, provider_instance_id, provider_session_id,
        provider_thread_id, runtime_mode, active_turn_id, last_error, updated_at
      ) VALUES (?, ?, 'Codex', 'codex', NULL, NULL, 'full-access', ?, NULL, ?)`,
    )
    .run(input.id, isWorking ? "running" : "ready", isWorking ? turnId : null, updatedAt);
}

// V1 tables this seed owns. `projection_projects` is not listed: V2 still
// stores projects there, so the seed upserts its own rows instead. V2 clients
// do not read the V1 thread rows; moving the seed to V2 is tracked in
// https://github.com/anton-abyzov/specwithcode/issues/15013.
const SEEDED_V1_TABLES = [
  "projection_pending_approvals",
  "projection_thread_proposed_plans",
  "projection_thread_activities",
  "projection_thread_messages",
  "projection_thread_sessions",
  "projection_turns",
  "projection_threads",
  "projection_state",
] as const;

const SEEDED_PROJECTION_TABLES = [...SEEDED_V1_TABLES, "projection_projects"] as const;

const SEEDED_THREAD_COLUMNS = ["snoozed_until", "snoozed_at"] as const;

function hasSeedableSchema(dbPath: string): boolean {
  let database: NodeSqlite.DatabaseSync;
  try {
    database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return false;
  }
  try {
    const tableCount = database
      .prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN (${SEEDED_PROJECTION_TABLES.map(() => "?").join(", ")})`,
      )
      .get(...SEEDED_PROJECTION_TABLES) as { count: number };
    if (tableCount.count !== SEEDED_PROJECTION_TABLES.length) return false;

    const threadColumns = database.prepare("PRAGMA table_info(projection_threads)").all() as Array<{
      name: string;
    }>;
    const threadColumnNames = new Set(threadColumns.map((column) => column.name));
    return SEEDED_THREAD_COLUMNS.every((column) => threadColumnNames.has(column));
  } catch {
    return false;
  } finally {
    database.close();
  }
}

async function waitForSeedableSchema(dbPath: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasSeedableSchema(dbPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The environment server did not migrate ${dbPath} within ${timeoutMs}ms.`);
}

function seedDatabase(
  dbPath: string,
  workspaceRoots: ReadonlyMap<string, string>,
  projects: ReadonlyArray<(typeof SHOWCASE_PROJECTS)[number]>,
  threads: ReadonlyArray<(typeof SHOWCASE_THREADS)[number]>,
  now: number,
): void {
  // The environment server is already running against this file and keeps
  // writing (migrations, projections) while we seed, so the write lock is
  // genuinely contended — without a busy timeout `BEGIN IMMEDIATE` fails
  // instantly with SQLITE_BUSY on a loaded machine.
  const database = new NodeSqlite.DatabaseSync(dbPath, { timeout: 30_000 });
  try {
    database.exec("BEGIN IMMEDIATE");
    for (const table of SEEDED_V1_TABLES) {
      database.exec(`DELETE FROM ${table}`);
    }
    const insertProject = database.prepare(
      `INSERT OR REPLACE INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    for (const [index, project] of projects.entries()) {
      const workspaceRoot = workspaceRoots.get(project.id);
      if (!workspaceRoot) throw new Error(`Missing workspace root for ${project.id}.`);
      const latestThreadMinutes = Math.min(
        ...threads
          .filter((thread) => thread.projectId === project.id)
          .map((thread) => thread.minutesAgo),
      );
      insertProject.run(
        project.id,
        project.title,
        workspaceRoot,
        MODEL_SELECTION,
        PROJECT_SCRIPTS,
        minutesBefore(now, 60 * 24 * (90 - index * 12)),
        minutesBefore(now, latestThreadMinutes),
      );
    }

    for (const thread of threads) {
      const workspaceRoot = workspaceRoots.get(thread.projectId);
      if (!workspaceRoot) throw new Error(`Missing workspace root for ${thread.projectId}.`);
      insertThread(database, now, {
        ...thread,
        ...("state" in thread ? { state: thread.state } : {}),
        workspaceRoot,
      });
    }

    const insertMessage = database.prepare(
      `INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, attachments_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
    );
    for (const thread of threads) {
      const turnId = `${thread.id}-turn`;
      const requestTime = minutesBefore(now, thread.minutesAgo + 5);
      insertMessage.run(
        `${thread.id}-request`,
        thread.id,
        turnId,
        "user",
        thread.request,
        requestTime,
        requestTime,
      );
      if (thread.response !== null) {
        const responseTime = minutesBefore(now, thread.minutesAgo);
        insertMessage.run(
          `${thread.id}-answer`,
          thread.id,
          turnId,
          "assistant",
          thread.response,
          responseTime,
          responseTime,
        );
      }
    }

    const turnId = `${SHOWCASE_THREAD_ID}-turn`;
    const insertActivity = database.prepare(
      `INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
      ) VALUES (?, ?, ?, 'tool', 'tool.completed', ?, ?, ?, ?)`,
    );
    insertActivity.run(
      "trace-remote-handoff",
      SHOWCASE_THREAD_ID,
      turnId,
      "Traced the remote handoff path",
      JSON.stringify({
        itemType: "command_execution",
        title: "Traced the remote handoff path",
        detail: "Three environments, one continuous workspace",
        status: "completed",
      }),
      1,
      minutesBefore(now, 8),
    );
    insertActivity.run(
      "sync-command-center",
      SHOWCASE_THREAD_ID,
      turnId,
      "Synced the command center",
      JSON.stringify({
        itemType: "file_change",
        title: "Synced the command center",
        detail: "2 files changed · instant handoffs · calm reconnects",
        status: "completed",
      }),
      2,
      minutesBefore(now, 6),
    );
    insertActivity.run(
      "run-changed-suite",
      SHOWCASE_THREAD_ID,
      turnId,
      "Ran the changed workspace",
      JSON.stringify({
        itemType: "command_execution",
        title: "Ran the changed workspace",
        detail: "612 tests passed · 3 environments online",
        status: "completed",
      }),
      3,
      minutesBefore(now, 4),
    );

    for (const [index, projector] of PROJECTOR_NAMES.entries()) {
      database
        .prepare(
          "INSERT INTO projection_state (projector, last_applied_sequence, updated_at) VALUES (?, ?, ?)",
        )
        .run(projector, index + 1, minutesBefore(now, 1));
    }
    database.exec("COMMIT");
  } catch (error) {
    // A failed BEGIN (or an error SQLite already auto-rolled back) leaves no
    // transaction, and the rollback's own "cannot rollback" error would then
    // replace the one that actually explains the failure.
    try {
      database.exec("ROLLBACK");
    } catch {
      // Nothing to roll back.
    }
    throw error;
  } finally {
    database.close();
  }
}

export async function seedShowcaseEnvironment(input: {
  readonly baseDir: string;
  readonly projectIds?: ReadonlyArray<string>;
  readonly now?: number;
}): Promise<{ readonly dbPath: string; readonly workspaceRoot: string }> {
  const now = input.now ?? Date.now();
  const selectedProjectIds = new Set(
    input.projectIds ?? SHOWCASE_PROJECTS.map((project) => project.id),
  );
  const projects = SHOWCASE_PROJECTS.filter((project) => selectedProjectIds.has(project.id));
  if (projects.length === 0) throw new Error("At least one showcase project must be selected.");
  const threads = SHOWCASE_THREADS.filter((thread) => selectedProjectIds.has(thread.projectId));
  const workspaceBase = NodePath.join(input.baseDir, "workspace");
  const workspaceRoots = new Map(
    projects.map(
      (project) => [project.id, NodePath.join(workspaceBase, project.directory)] as const,
    ),
  );
  const primaryProject =
    projects.find((project) => project.id === SHOWCASE_PROJECT_ID) ?? projects[0];
  if (!primaryProject) throw new Error("The primary showcase workspace is not configured.");
  const workspaceRoot = workspaceRoots.get(primaryProject.id);
  if (!workspaceRoot) throw new Error("The primary showcase workspace is not configured.");
  const dbPath = NodePath.join(input.baseDir, "userdata", "statev2.sqlite");
  if (primaryProject.id === SHOWCASE_PROJECT_ID) {
    await seedSpecWeaveStudioWorkspace(workspaceRoot);
  }
  await Promise.all(
    projects
      .filter((project) => project.id !== SHOWCASE_PROJECT_ID)
      .map(async (project) => {
        const projectWorkspaceRoot = workspaceRoots.get(project.id);
        if (!projectWorkspaceRoot) throw new Error(`Missing workspace root for ${project.id}.`);
        await seedCompanionWorkspace({
          workspaceRoot: projectWorkspaceRoot,
          title: project.title,
          repositoryUrl: project.repositoryUrl,
          favicon: project.favicon,
        });
      }),
  );
  // The environment server begins listening before it finishes migrating the
  // database, so wait for the schema before deleting from and reseeding it.
  await waitForSeedableSchema(dbPath);
  seedDatabase(dbPath, workspaceRoots, projects, threads, now);

  const terminalDirectory = NodePath.join(input.baseDir, "userdata", "logs", "terminals");
  if (selectedProjectIds.has(SHOWCASE_PROJECT_ID)) {
    const safeThreadId = Buffer.from(SHOWCASE_THREAD_ID).toString("base64url");
    await NodeFSP.mkdir(terminalDirectory, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(terminalDirectory, `terminal_${safeThreadId}.log`),
      SHOWCASE_TERMINAL_BUFFER,
    );
  }
  return { dbPath, workspaceRoot };
}
