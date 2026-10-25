import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as PreviewBrowserHost from "./PreviewBrowserHost.ts";

// What `ldd` printed for the pinned headless shell in a bare debian:trixie-slim container.
const LDD_IN_BARE_DEBIAN = `\tlinux-vdso.so.1 (0x00007ffd2d1f8000)
\tlibdl.so.2 => /lib/x86_64-linux-gnu/libdl.so.2 (0x00007f0c1b6a1000)
\tlibglib-2.0.so.0 => not found
\tlibnss3.so => not found
\tlibX11.so.6 => not found
\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f0c1b4c0000)
`;

// Chrome's own abort on Ubuntu 26.04 with unprivileged user namespaces restricted.
const SANDBOX_ABORT =
  "[1005/163106.285700:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:129] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/";

// The bundled macOS headless shell inside `sandbox-exec`, which it cannot nest its own sandbox in.
const GPU_ABORT = [
  "sandbox initialization failed: Operation not permitted",
  "[1024/083358.532672:ERROR:content/browser/gpu/gpu_process_host.cc:1130] GPU process exited unexpectedly: exit_code=5",
  "[1024/083358.532704:WARNING:content/browser/gpu/gpu_process_host.cc:1588] The GPU process has crashed 6 time(s)",
  "[1024/083358.532723:FATAL:content/browser/gpu/gpu_data_manager_impl_private.cc:417] GPU process isn't usable. Goodbye.",
  "",
].join("\n");

// How Playwright 1.60 reports that launch: Chrome's stderr under "Browser logs" and the call log.
const PLAYWRIGHT_GPU_LAUNCH_FAILURE = [
  "browserType.launch: Failed to launch the browser process.",
  "Browser logs:",
  "",
  "<launching> /Users/me/.specwithcode/tools/chrome-headless-shell/mac-arm64/154/chrome-headless-shell --disable-gpu --headless --remote-debugging-pipe",
  "<launched> pid=41234",
  ...GPU_ABORT.split("\n")
    .filter((line) => line.length > 0)
    .map((line) => `[pid=41234][err] ${line}`),
  "Call log:",
  "  - <launching> /Users/me/.specwithcode/tools/chrome-headless-shell/mac-arm64/154/chrome-headless-shell",
  "  - <launched> pid=41234",
  "  - [pid=41234][err] [1024/083358.532723:FATAL:content/browser/gpu/gpu_data_manager_impl_private.cc:417] GPU process isn't usable. Goodbye.",
].join("\n");

const lddReporting = (stdout: string) => {
  const commands: Array<string> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const { command: name, args } = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      commands.push([name, ...args].join(" "));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, commands };
};

const diagnose = (input: {
  platform: NodeJS.Platform;
  output: string;
  ldd: string;
  sandboxOff?: boolean;
}) => {
  const { spawner, commands } = lddReporting(input.ldd);
  return PreviewBrowserHost.diagnoseLaunchFailure({
    executable:
      "/home/me/.specweave-studio/tools/chrome-headless-shell/linux64/154/chrome-headless-shell",
    output: input.output,
    setupCommand: "sudo specweave-studio browser setup",
    ...(input.sandboxOff === undefined ? {} : { sandboxOff: input.sandboxOff }),
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(HostProcessPlatform, input.platform),
    Effect.map((error) => ({ error, commands })),
  );
};

describe("diagnoseLaunchFailure", () => {
  it.effect("turns Chrome's sandbox abort into the AppArmor steps", () =>
    Effect.gen(function* () {
      const { error, commands } = yield* diagnose({
        platform: "linux",
        output: SANDBOX_ABORT,
        ldd: "",
      });
      expect(error?._tag).toBe("PreviewBrowserSandboxError");
      expect(error?.message).toContain("Run `sudo specweave-studio browser setup` on the host");
      expect(commands).toEqual([]);
    }),
  );

  it.effect("names every library the loader cannot find", () =>
    Effect.gen(function* () {
      const { error } = yield* diagnose({
        platform: "linux",
        output: "error while loading shared libraries: libglib-2.0.so.0",
        ldd: LDD_IN_BARE_DEBIAN,
      });
      expect(error).toMatchObject({
        _tag: "PreviewBrowserLibrariesError",
        libraries: ["libglib-2.0.so.0", "libnss3.so", "libX11.so.6"],
      });
      expect(error?.message).toContain("Run `sudo specweave-studio browser setup` on the host");
    }),
  );

  it.effect("names the outer sandbox when the GPU process cannot start, with Chrome's line", () =>
    Effect.gen(function* () {
      const { error, commands } = yield* diagnose({
        platform: "darwin",
        output: GPU_ABORT,
        ldd: "",
      });
      expect(error).toMatchObject({
        _tag: "PreviewBrowserGpuError",
        lastError: "GPU process isn't usable. Goodbye.",
      });
      expect(error?.message).toContain(`(Chrome: "GPU process isn't usable. Goodbye.")`);
      expect(error?.message).toContain("STUDIO_SERVER_BROWSER_SANDBOX=0");
      expect(commands).toEqual([]);
    }),
  );

  it.effect("leaves the sandbox opt-out out of the GPU steps once it is set", () =>
    Effect.gen(function* () {
      const { error } = yield* diagnose({
        platform: "darwin",
        output: GPU_ABORT,
        ldd: "",
        sandboxOff: true,
      });
      expect(error).toMatchObject({ _tag: "PreviewBrowserGpuError", sandboxOff: true });
      expect(error?.message).toContain("even without Chrome's sandbox");
      expect(error?.message).toContain("Start the server outside it, then try again.");
      expect(error?.message).not.toContain("STUDIO_SERVER_BROWSER_SANDBOX=0");
    }),
  );

  it.effect("prefers missing libraries over a GPU abort on Linux", () =>
    Effect.gen(function* () {
      const { error } = yield* diagnose({
        platform: "linux",
        output: GPU_ABORT,
        ldd: LDD_IN_BARE_DEBIAN,
      });
      expect(error?._tag).toBe("PreviewBrowserLibrariesError");
    }),
  );

  it.effect("leaves other failures alone", () =>
    Effect.gen(function* () {
      const linux = yield* diagnose({
        platform: "linux",
        output: "crashed",
        ldd: "\tlibc.so.6 => /lib/libc.so.6\n",
      });
      expect(linux.error).toBeUndefined();
      const mac = yield* diagnose({ platform: "darwin", output: "crashed", ldd: "" });
      expect(mac.error).toBeUndefined();
      expect(mac.commands).toEqual([]);
    }),
  );
});

describe("playwrightBrowserOutput", () => {
  it("reads Chrome's stderr lines out of a Playwright launch error", () => {
    const output = PreviewBrowserHost.playwrightBrowserOutput(
      new Error(PLAYWRIGHT_GPU_LAUNCH_FAILURE),
    );
    expect(output.split("\n")[0]).toBe("sandbox initialization failed: Operation not permitted");
    expect(output).not.toContain("<launch");
    expect(output).not.toContain("[pid=");
    expect(PreviewBrowserHost.browserLastError(output)).toBe("GPU process isn't usable. Goodbye.");
  });

  it("keeps Playwright's sandbox note as Chrome's abort and reads nothing else", () => {
    expect(
      PreviewBrowserHost.playwrightBrowserOutput(
        new Error("browserType.launch: Chromium sandboxing failed!\n================"),
      ),
    ).toBe(PreviewBrowserHost.NO_SANDBOX_SIGNATURE);
    expect(PreviewBrowserHost.playwrightBrowserOutput(new Error("executable unavailable"))).toBe(
      "",
    );
  });

  it.effect("names the GPU exit from a Playwright launch error", () =>
    PreviewBrowserHost.diagnosePlaywrightLaunch({
      executable: "/Users/me/chrome-headless-shell",
      cause: new Error(PLAYWRIGHT_GPU_LAUNCH_FAILURE),
      setupCommand: "sudo specweave-studio browser setup",
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, lddReporting("").spawner),
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.map((error) => {
        expect(error).toMatchObject({
          _tag: "PreviewBrowserGpuError",
          lastError: "GPU process isn't usable. Goodbye.",
        });
      }),
    ),
  );
});

describe("browserLastError", () => {
  it("picks Chrome's last fatal line without its log prefix", () => {
    expect(PreviewBrowserHost.browserLastError(GPU_ABORT)).toBe(
      "GPU process isn't usable. Goodbye.",
    );
  });

  it("falls back to the last error line, then the last line", () => {
    expect(
      PreviewBrowserHost.browserLastError(
        "[1/2.3:ERROR:a.cc:1] first\n[1/2.3:ERROR:b.cc:2] second\n[1/2.3:INFO:c.cc:3] fine\n",
      ),
    ).toBe("second");
    expect(PreviewBrowserHost.browserLastError("plain\nlast words\n")).toBe("last words");
    expect(PreviewBrowserHost.browserLastError(" \n")).toBeUndefined();
  });
});
