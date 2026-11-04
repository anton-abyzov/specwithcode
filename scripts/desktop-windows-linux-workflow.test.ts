// @effect-diagnostics nodeBuiltinImport:off - Reads the workflow files as text.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

const read = (name: string) =>
  NodeFS.readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");

const original = read("desktop-windows-linux.yml");
const releaseWorkflow = read("release-windows-linux.yml");

type Mode = "source" | "release";

interface Step {
  readonly name: string;
  readonly if: string | undefined;
  readonly continueOnError: boolean;
  readonly run: string;
}

/**
 * An `if:` or `continue-on-error:` value as YAML gives it, in any form GitHub accepts (plain,
 * quoted, folded or on the next line; a boolean or an expression). Anything else throws, so an
 * unsupported form is never read as absent.
 */
const expression = (key: string, value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return value.trim();
  throw new Error(`unsupported ${key}: ${JSON.stringify(value)}`);
};

/** Whether `continue-on-error` can let a failure pass: anything but absent or a literal false. */
const continues = (value: unknown) => {
  const text = expression("continue-on-error", value);
  return text !== undefined && text !== "false" && text !== "${{ false }}";
};

/** One job of a workflow's text, parsed: its own `if:` and `continue-on-error:`, and its steps by name. */
const job = (text: string, name: string) => {
  const parsed = parse(text, { uniqueKeys: true }) as { jobs?: Record<string, unknown> };
  const value = parsed.jobs?.[name] as Record<string, unknown> | undefined;
  if (value === undefined) throw new Error(`no job ${name}`);
  const steps = new Map<string, Step>();
  for (const raw of (value.steps as Array<Record<string, unknown>> | undefined) ?? []) {
    if (typeof raw.name !== "string") continue;
    if (steps.has(raw.name)) throw new Error(`two steps named ${raw.name}`);
    if (raw.run !== undefined && typeof raw.run !== "string")
      throw new Error(`unsupported run in ${raw.name}`);
    steps.set(raw.name, {
      name: raw.name,
      if: expression("if", raw.if),
      continueOnError: continues(raw["continue-on-error"]),
      run: (raw.run as string | undefined) ?? "",
    });
  }
  return {
    if: expression("if", value.if),
    continueOnError: continues(value["continue-on-error"]),
    needs: value.needs,
    steps,
  };
};

const steps = (name: string, text = original) => job(text, name).steps;

const condition = (step: Step | undefined) => step?.if;

/**
 * Whether a step with this `if:` runs in a mode, assuming every earlier step passed and the run is
 * not a release pull request. Knows only the expressions this workflow uses; anything else throws,
 * so a new condition on a gate step has to be added here on purpose.
 */
const runsIn = (expression: string | undefined, mode: Mode): boolean => {
  if (expression === undefined) return true;
  let reduced = expression
    .replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1")
    .replaceAll("!startsWith(github.head_ref, 'release/')", "true")
    .replaceAll("success() || failure()", "true")
    .replaceAll("always()", "true")
    .replaceAll("env.RELEASE_TAG == ''", String(mode === "source"))
    .replaceAll("env.RELEASE_TAG != ''", String(mode === "release"));
  for (let previous = ""; previous !== reduced;) {
    previous = reduced;
    reduced = reduced
      .replace(/\(\s*(true|false)\s*\)/g, "$1")
      .replace(/!\s*(true|false)\b/g, (_, value) => String(value !== "true"))
      .replace(/\b(true|false)\s*&&\s*(true|false)\b/, (_, a, b) =>
        String(a === "true" && b === "true"),
      );
    if (reduced === previous) {
      reduced = reduced.replace(/\b(true|false)\s*\|\|\s*(true|false)\b/, (_, a, b) =>
        String(a === "true" || b === "true"),
      );
    }
  }
  if (reduced !== "true" && reduced !== "false") {
    throw new Error(`unknown condition: ${expression}`);
  }
  return reduced === "true";
};

type OsJob = "linux" | "windows" | "macos";

/** The real-OS gates each job must run, and fail on, in one mode only. */
const GATES: Record<OsJob, Record<Mode, string[]>> = {
  linux: {
    source: ["Build AppImage and .deb"],
    release: [
      "Build the server, web client and resource monitor for the CLI archive",
      "Download the published AppImage and .deb",
    ],
  },
  windows: {
    source: ["Build NSIS installer", "Build and smoke-test the CLI archive"],
    // The published CLI zip is checksummed and smoke-tested in the download step.
    release: ["Download the published installer and CLI archive"],
  },
  macos: {
    source: ["Build the unsigned app"],
    release: ["Download the published zip"],
  },
};
/** The real-OS gates each job must run, and fail on, in both modes. */
const BOTH: Record<OsJob, string[]> = {
  linux: [
    "Install the .deb",
    "Launch the installed .deb app",
    "End-to-end check of the installed .deb app",
    "Create a chat without Git on the installed .deb app",
    "Launch the AppImage",
    "End-to-end check of the AppImage",
    "Build and smoke-test the CLI archive",
    "Start a systemd user manager",
    "Tray and background service of the installed .deb app",
    "Remove the .deb",
  ],
  windows: [
    "Install silently",
    "Launch the installed app",
    "End-to-end check of the installed app",
    "Tray and background service of the installed app",
    "Uninstall silently",
  ],
  macos: ["Launch the unpacked app", "Verify the unpacked app"],
};

/** Why a gate would not run, or would not fail its job, in a mode. Empty when every gate holds. */
const gateProblems = (text: string, jobName: OsJob, mode: Mode): string[] => {
  const parsed = job(text, jobName);
  const problems: string[] = [];
  if (parsed.needs !== undefined) problems.push(`${jobName}: independent OS job has dependencies`);
  if (parsed.continueOnError) problems.push(`${jobName}: job continues on error`);
  if (!runsIn(parsed.if, mode)) problems.push(`${jobName}: job skipped in ${mode} mode`);
  for (const name of [...BOTH[jobName], ...GATES[jobName][mode]]) {
    const step = parsed.steps.get(name);
    if (step === undefined) {
      problems.push(`${name}: missing`);
      continue;
    }
    if (step.continueOnError) problems.push(`${name}: continues on error`);
    if (!runsIn(step.if, mode)) problems.push(`${name}: skipped in ${mode} mode`);
    if (/\|\|\s*(?:true|:)\s*$|;\s*exit 0\s*$/m.test(step.run))
      problems.push(`${name}: masks failure`);
  }
  return problems;
};

describe("desktop-windows-linux.yml real-OS gates", () => {
  it.each([
    ["linux", "source"],
    ["linux", "release"],
    ["windows", "source"],
    ["windows", "release"],
    ["macos", "source"],
    ["macos", "release"],
  ] as const)("runs and fails on every %s gate in %s mode", (jobName, mode) => {
    expect(gateProblems(original, jobName, mode)).toEqual([]);
  });

  it("rejects a skipped optional preflight dependency on either OS", () => {
    for (const os of ["linux", "windows", "macos"] as const) {
      const text = original
        .replace(
          "jobs:\n",
          "jobs:\n  optional-preflight:\n    if: false\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo skipped\n",
        )
        .replace(`  ${os}:\n`, `  ${os}:\n    needs: optional-preflight\n`);
      expect(text).not.toBe(original);
      for (const mode of ["source", "release"] as const)
        expect(gateProblems(text, os, mode)).toContain(
          `${os}: independent OS job has dependencies`,
        );
    }
  });

  // Negative controls: each weakening is caught.
  const mutate = (from: string, to: string) => {
    expect(original).toContain(from);
    return original.replace(from, to);
  };

  it("catches a gate that continues on error", () => {
    const text = mutate(
      "      - name: End-to-end check of the installed .deb app\n",
      "      - name: End-to-end check of the installed .deb app\n        continue-on-error: true\n",
    );
    expect(gateProblems(text, "linux", "release")).toContain(
      "End-to-end check of the installed .deb app: continues on error",
    );
  });

  it("catches a gate that never runs", () => {
    const text = mutate(
      "        # Each check runs even when an earlier one failed; the job still fails.\n        if: ${{ success() || failure() }}\n",
      "        # Each check runs even when an earlier one failed; the job still fails.\n        if: false\n",
    );
    expect(gateProblems(text, "linux", "source")).toContain(
      "End-to-end check of the installed .deb app: skipped in source mode",
    );
  });

  it("catches a gate skipped only for a published release", () => {
    const text = mutate(
      "      - name: Uninstall silently\n        if: ${{ success() || failure() }}\n",
      "      - name: Uninstall silently\n        if: ${{ (success() || failure()) && env.RELEASE_TAG == '' }}\n",
    );
    expect(gateProblems(text, "windows", "source")).toEqual([]);
    expect(gateProblems(text, "windows", "release")).toContain(
      "Uninstall silently: skipped in release mode",
    );
  });

  it("catches a job that continues on error and a gate that masks its exit code", () => {
    const jobText = mutate(
      "    runs-on: windows-2025\n",
      "    runs-on: windows-2025\n    continue-on-error: true\n",
    );
    expect(gateProblems(jobText, "windows", "release")).toContain(
      "windows: job continues on error",
    );
    const masked = mutate(
      '          sudo apt-get remove -y "$DEB_PACKAGE"\n',
      '          sudo apt-get remove -y "$DEB_PACKAGE" || true\n',
    );
    expect(gateProblems(masked, "linux", "release")).toContain("Remove the .deb: masks failure");
  });

  it("reads an if: on the next line and a quoted key, for steps and jobs", () => {
    const multiline = mutate(
      "      - name: Uninstall silently\n        if: ${{ success() || failure() }}\n",
      "      - name: Uninstall silently\n        if:\n          ${{ false }}\n",
    );
    expect(gateProblems(multiline, "windows", "source")).toContain(
      "Uninstall silently: skipped in source mode",
    );
    const quoted = mutate(
      "      - name: End-to-end check of the installed .deb app\n",
      '      - name: End-to-end check of the installed .deb app\n        "continue-on-error": true\n',
    );
    expect(gateProblems(quoted, "linux", "source")).toContain(
      "End-to-end check of the installed .deb app: continues on error",
    );
    const folded = mutate(
      "      - name: Launch the AppImage\n",
      "      - name: Launch the AppImage\n        continue-on-error: >-\n          ${{ true }}\n",
    );
    expect(gateProblems(folded, "linux", "release")).toContain(
      "Launch the AppImage: continues on error",
    );
    const jobIf = mutate(
      "    runs-on: windows-2025\n",
      "    runs-on: windows-2025\n    'continue-on-error': true\n",
    );
    expect(gateProblems(jobIf, "windows", "release")).toContain("windows: job continues on error");
    const skippedJob = original.replace(
      "  linux:\n    name: Linux x64 install and launch\n    # release.sh opens release PRs after publishing and merges them at once.\n    if: ${{ !startsWith(github.head_ref, 'release/') }}\n",
      "  linux:\n    name: Linux x64 install and launch\n    if:\n      ${{ false }}\n",
    );
    expect(skippedJob).not.toBe(original);
    expect(gateProblems(skippedJob, "linux", "source")).toContain(
      "linux: job skipped in source mode",
    );
  });

  it("refuses a form it cannot read and a duplicated key", () => {
    const listIf = mutate(
      "      - name: Uninstall silently\n        if: ${{ success() || failure() }}\n",
      "      - name: Uninstall silently\n        if: [false]\n",
    );
    expect(() => gateProblems(listIf, "windows", "source")).toThrow(/unsupported if/);
    const twice = mutate(
      "      - name: Uninstall silently\n        if: ${{ success() || failure() }}\n",
      "      - name: Uninstall silently\n        if: ${{ success() || failure() }}\n        if: false\n",
    );
    expect(() => gateProblems(twice, "windows", "source")).toThrow();
  });

  it("catches a missing gate", () => {
    const text = mutate("      - name: Launch the AppImage\n", "      - name: Launch it\n");
    expect(gateProblems(text, "linux", "source")).toContain("Launch the AppImage: missing");
  });

  it("refuses a condition it does not understand", () => {
    expect(() => runsIn("github.event_name == 'push'", "source")).toThrow(/unknown condition/);
  });
});

describe("desktop-windows-linux.yml with release_tag", () => {
  const linux = steps("linux");

  it("never builds the Linux desktop app it replaces with the published one", () => {
    expect(runsIn(condition(linux.get("Build AppImage and .deb")), "release")).toBe(false);
    expect(runsIn(condition(linux.get("Cache Linux capture helpers")), "release")).toBe(false);
    // Rust is still set up when the resource monitor the CLI archive needs is not cached.
    expect(condition(linux.get("Setup Rust"))).toBe(
      "steps.resource_monitor_cache.outputs.cache-hit != 'true' || (env.RELEASE_TAG == '' && steps.capture_helper_cache.outputs.cache-hit != 'true')",
    );
  });

  it("builds only the server, web client and resource monitor for the CLI archive", () => {
    const build = linux.get(
      "Build the server, web client and resource monitor for the CLI archive",
    );
    expect(runsIn(condition(build), "source")).toBe(false);
    expect(build?.run).toContain("set -euo pipefail");
    expect(build?.run).toContain("vp run --filter specweave-studio build");
    // What build-desktop-artifact.ts applies to apps/server/dist/client for a stable version.
    expect(build?.run).toContain(
      "node scripts/apply-web-brand-assets.ts production apps/server/dist/client",
    );
    expect(build?.run).toContain("--target x86_64-unknown-linux-gnu");
    expect(build?.run).toContain(
      "test -x native/resource-monitor/target/x86_64-unknown-linux-gnu/release/studio-resource-monitor",
    );
  });

  it("checks the published files against the release before installing them", () => {
    const download = linux.get("Download the published AppImage and .deb");
    expect(download?.run).toContain("sha256sum -c --ignore-missing SHA256SUMS-windows-linux");
    expect(download?.run).toContain(
      `[ "$(node -p 'require("./apps/desktop/package.json").version')" = "$v" ]`,
    );
    const windows = steps("windows").get("Download the published installer and CLI archive");
    expect(windows?.run).toContain("sha256sum -c --ignore-missing SHA256SUMS-windows-linux");
    expect(windows?.run).toContain(
      'node scripts/smoke-cli-archive.ts --archive "release-cli/studio-$v-win32-x64.zip"',
    );
  });
});

describe("the built-app verify on every desktop OS", () => {
  it("verifies the macOS zip as the updater unpacks it, headless, in both modes", () => {
    const macos = job(original, "macos");
    expect(macos.needs).toBeUndefined();
    const verify = macos.steps.get("Verify the unpacked app");
    expect(verify?.if).toBe("${{ success() || failure() }}");
    expect(verify?.run).toContain("set -euo pipefail");
    expect(verify?.run).toContain(
      'node scripts/release/verify-built-app.mjs --mode fresh --no-proofs --archive "$(ls release/SpecWithCode-*-arm64.zip | head -1)"',
    );
    expect(macos.steps.get("Launch the unpacked app")?.run).toContain("ditto -x -k");
    expect(macos.steps.get("Download the published zip")?.run).toContain(
      "shasum -a 256 -c --ignore-missing SHA256SUMS",
    );
    // The voice helper needs the macOS 26 SDK: a macOS 26 image, and Xcode 26 or later selected.
    expect(original).toMatch(/\n {2}macos:\n {4}name: [^\n]+\n(?: {4}#[^\n]*\n)* {4}if: [^\n]+\n {4}runs-on: macos-26\n/);
    const names = [...macos.steps.keys()];
    expect(names.indexOf("Select Xcode 26")).toBeGreaterThan(-1);
    expect(names.indexOf("Select Xcode 26")).toBeLessThan(names.indexOf("Build the unsigned app"));
    expect(macos.steps.get("Select Xcode 26")?.run).toContain('[ "$current" -ge 26 ]');
    expect(original).toContain('PWDEBUG: "0"');
  });

  it("catches a macOS verify that masks its failure or is skipped", () => {
    const masked = original.replace(
      '--version "$v" --out "$RUNNER_TEMP/verify-macos"\n',
      '--version "$v" --out "$RUNNER_TEMP/verify-macos" || true\n',
    );
    expect(masked).not.toBe(original);
    expect(gateProblems(masked, "macos", "source")).toContain("Verify the unpacked app: masks failure");
    const skipped = original.replace(
      "      - name: Verify the unpacked app\n        if: ${{ success() || failure() }}\n",
      "      - name: Verify the unpacked app\n        if: env.RELEASE_TAG == ''\n",
    );
    expect(skipped).not.toBe(original);
    expect(gateProblems(skipped, "macos", "release")).toContain(
      "Verify the unpacked app: skipped in release mode",
    );
  });

  it.each([
    ["windows", '--app "$RUNNER_TEMP/installer/app/SpecWithCode.exe"', "verify-windows"],
    ["linux", '--app "$exe"', "verify-linux"],
  ] as const)("runs the same verify in the %s release job before its assets are collected", (name, app, out) => {
    const release = job(releaseWorkflow, name);
    const names = [...release.steps.keys()];
    const verify = release.steps.get("Verify the built app");
    expect(verify).toBeDefined();
    expect(verify?.if).toBeUndefined();
    expect(verify?.continueOnError).toBe(false);
    expect(verify?.run).toContain("set -euo pipefail");
    expect(verify?.run).toContain(
      `node scripts/release/verify-built-app.mjs --mode fresh --no-proofs ${app}`,
    );
    expect(verify?.run).toContain(`--version "$VERSION" --out "$RUNNER_TEMP/${out}"`);
    expect(verify?.run).not.toMatch(/\|\|\s*(?:true|:)\s*$/m);
    // After the unpacked app exists, before anything is collected for upload.
    expect(names.indexOf("Verify the built app")).toBeGreaterThan(
      names.findIndex((step) => step.startsWith("Check the")),
    );
    expect(names.indexOf("Verify the built app")).toBeLessThan(names.indexOf("Collect assets"));
  });
});
