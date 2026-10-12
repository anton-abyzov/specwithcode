import { describe, expect, it } from "vite-plus/test";

import { shortenShellCommand } from "./shellCommandLabel.ts";

const GH_RUN_LIST =
  "gh run list -R octo-org/example-api --branch feat/1234-example -L 1 --json databaseId -q '.[0].databaseId'";

describe("shortenShellCommand", () => {
  it("shows the captured command when nothing runs after the assignment", () => {
    expect(shortenShellCommand(`ID=$(${GH_RUN_LIST})`)).toBe(GH_RUN_LIST);
    expect(shortenShellCommand('OUT="$(echo "(a)" $(date +%s))"')).toBe('echo "(a)" $(date +%s)');
    expect(shortenShellCommand("SHA=`git rev-parse HEAD`")).toBe("git rev-parse HEAD");
  });

  it("shows the command that runs after a captured assignment, not the lookup", () => {
    expect(shortenShellCommand(`ID=$(${GH_RUN_LIST}); gh run watch $ID`)).toBe("gh run watch $ID");
    expect(shortenShellCommand("TOKEN=$(gh auth token) npm run deploy")).toBe("npm run deploy");
    expect(shortenShellCommand("X=$(echo ok); rm -rf build")).toBe("rm -rf build");
    expect(shortenShellCommand('OUT="$(echo "(a)" $(date +%s))" && echo $OUT')).toBe("echo $OUT");
    expect(shortenShellCommand("SHA=`git rev-parse HEAD` git push")).toBe("git push");
    expect(shortenShellCommand("A=$(x)suffix&&npm test")).toBe("npm test");
  });

  it("uses the rest of a captured command that was cut off before it closed", () => {
    expect(shortenShellCommand("ID=$(gh run list -R x --branch feat -L 1...")).toBe(
      "gh run list -R x --branch feat -L 1...",
    );
    expect(shortenShellCommand("SHA=`git rev-parse")).toBe("git rev-parse");
  });

  it("keeps the captured command when what follows is not a command of its own", () => {
    expect(shortenShellCommand("ID=$(gh run list) || echo none")).toBe("gh run list");
    expect(shortenShellCommand("ID=$(gh run list) | tee log")).toBe("gh run list");
  });

  it("drops plain environment assignments in front of a command", () => {
    expect(shortenShellCommand("PORT=3019 NODE_ENV=development npm run dev")).toBe("npm run dev");
    expect(shortenShellCommand("export TOKEN='a b' && gh auth status")).toBe("gh auth status");
    expect(shortenShellCommand('MSG="hello world" ./notify.sh')).toBe("./notify.sh");
    expect(shortenShellCommand("CI=1; npx vp test run")).toBe("npx vp test run");
    expect(shortenShellCommand("A=1&&npm run dev")).toBe("npm run dev");
    expect(shortenShellCommand("A=1;npm run dev")).toBe("npm run dev");
    expect(shortenShellCommand("A=1 B=$(pwd) npm run dev")).toBe("npm run dev");
  });

  it("leaves a plain assignment piped or chained with || as it was written", () => {
    expect(shortenShellCommand("A=1 | tee log")).toBe("A=1 | tee log");
    expect(shortenShellCommand("A=1|tee log")).toBe("A=1|tee log");
    expect(shortenShellCommand("A=1 || echo no")).toBe("A=1 || echo no");
    expect(shortenShellCommand("A=1 & sleep 1")).toBe("A=1 & sleep 1");
  });

  it("collapses whitespace and leaves ordinary commands and descriptions alone", () => {
    expect(shortenShellCommand("  npm   test\n  -- a  ")).toBe("npm test -- a");
    expect(shortenShellCommand("Start the shared dev server")).toBe("Start the shared dev server");
    expect(shortenShellCommand("git log --format=%H -1")).toBe("git log --format=%H -1");
  });

  it("keeps text that is only an assignment, or captures nothing", () => {
    expect(shortenShellCommand("FOO=bar")).toBe("FOO=bar");
    expect(shortenShellCommand("EMPTY=$( )")).toBe("EMPTY=$( )");
    expect(shortenShellCommand("FOO=bar;")).toBe("FOO=bar;");
  });
});
