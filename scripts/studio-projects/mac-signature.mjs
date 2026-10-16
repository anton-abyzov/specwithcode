#!/usr/bin/env node
// Refuses a macOS desktop build that would make every update look like a new
// app. macOS ties the "studio Safe Storage" Keychain item, and the privacy
// grants, to the app's designated requirement. An ad-hoc build's requirement
// is its code hash, which changes with every build, so each update asks for
// the login keychain password again. A Developer ID signature from one team
// keeps the requirement the same across releases.
//
// Usage: node scripts/studio-projects/mac-signature.mjs <SpecWithCode.app|.dmg|.zip>
// Set STUDIO_APPLE_TEAM_ID to check a different team.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const DESKTOP_BUNDLE_ID = "com.specweave.studio";
export const RELEASE_TEAM_ID = "NMCB2JZ7QG";

/** The problems that keep a build from being published; empty when it may ship. */
export function macSignatureProblems(
  { codesign, verify, spctl, stapler },
  teamId = RELEASE_TEAM_ID,
) {
  const field = (name) => codesign.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim();
  const problems = [];
  if (verify.trim() !== "") problems.push(`codesign --verify failed: ${verify.trim()}`);
  if (field("Signature") === "adhoc" || /flags=0x[0-9a-f]*\([^)]*adhoc/.test(codesign))
    problems.push("The app is signed ad hoc; every update would ask for the keychain again.");
  if (field("Identifier") !== DESKTOP_BUNDLE_ID)
    problems.push(`Identifier is ${field("Identifier") ?? "missing"}, not ${DESKTOP_BUNDLE_ID}.`);
  if (!/^Authority=Developer ID Application: /m.test(codesign))
    problems.push("The app is not signed with a Developer ID Application certificate.");
  if (field("TeamIdentifier") !== teamId)
    problems.push(`TeamIdentifier is ${field("TeamIdentifier") ?? "missing"}, not ${teamId}.`);
  if (!/flags=0x[0-9a-f]*\([^)]*runtime/.test(codesign))
    problems.push("The hardened runtime is off, so the app cannot be notarized.");
  if (!/: accepted$/m.test(spctl) || !/^source=Notarized Developer ID$/m.test(spctl))
    problems.push("Gatekeeper does not accept the app as notarized Developer ID.");
  if (!/The validate action worked/.test(stapler))
    problems.push("The notarization ticket is not stapled to the app.");
  return problems;
}

function run(command, args) {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8" });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function inspectApp(appPath) {
  return {
    codesign: run("/usr/bin/codesign", ["-dvv", appPath]),
    verify: run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]),
    spctl: run("/usr/sbin/spctl", ["-a", "-vv", "-t", "exec", appPath]),
    stapler: run("/usr/bin/xcrun", ["stapler", "validate", appPath]),
  };
}

function findApp(directory) {
  const app = NodeFS.readdirSync(directory).find((name) => name.endsWith(".app"));
  if (!app) throw new Error(`No .app in ${directory}`);
  return NodePath.join(directory, app);
}

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

// Gatekeeper's check registers the bundle with Launch Services. A scratch
// copy left registered can be opened in place of the installed app.
function inspectScratchApp(appPath) {
  try {
    return macSignatureProblems(inspectApp(appPath), teamId());
  } finally {
    NodeChildProcess.spawnSync(LSREGISTER, ["-u", appPath]);
  }
}

function checkArtifact(artifact) {
  const resolved = NodePath.resolve(artifact);
  if (resolved.endsWith(".app")) return macSignatureProblems(inspectApp(resolved), teamId());
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "specwithcode-signature-"));
  try {
    if (resolved.endsWith(".zip")) {
      NodeChildProcess.execFileSync("/usr/bin/ditto", ["-x", "-k", resolved, scratch]);
      return inspectScratchApp(findApp(scratch));
    }
    if (resolved.endsWith(".dmg")) {
      const mount = NodePath.join(scratch, "mount");
      NodeChildProcess.execFileSync("/usr/bin/hdiutil", [
        "attach",
        "-nobrowse",
        "-readonly",
        "-quiet",
        "-mountpoint",
        mount,
        resolved,
      ]);
      try {
        return inspectScratchApp(findApp(mount));
      } finally {
        NodeChildProcess.spawnSync("/usr/bin/hdiutil", ["detach", "-quiet", mount]);
      }
    }
    throw new Error(`Expected a .app, .dmg or .zip: ${artifact}`);
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}

function teamId() {
  return process.env.STUDIO_APPLE_TEAM_ID?.trim().toUpperCase() || RELEASE_TEAM_ID;
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const artifacts = process.argv.slice(2);
  if (artifacts.length === 0) {
    process.stderr.write("Usage: mac-signature.mjs <SpecWithCode.app|.dmg|.zip>...\n");
    process.exitCode = 2;
  }
  for (const artifact of artifacts) {
    try {
      const problems = checkArtifact(artifact);
      if (problems.length === 0) {
        process.stdout.write(`ok ${artifact}: Developer ID ${teamId()}, notarized\n`);
        continue;
      }
      process.stderr.write(`refused ${artifact}:\n${problems.map((p) => `  - ${p}\n`).join("")}`);
    } catch (error) {
      process.stderr.write(
        `refused ${artifact}: ${error instanceof Error ? error.message : error}\n`,
      );
    }
    process.exitCode = 1;
  }
}
