// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - disposable real Git fixtures only.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { folderCopyAllConflictsKey } from "@specweave-studio/contracts";

import { CopyError, DestinationCopies, type DestinationRecord } from "./destinationService.ts";
import { git, makeUmbrella, write, type UmbrellaFixture } from "./folderFixture.testkit.ts";
import { repoRowId } from "./reconcile.ts";
import { platformHomePath } from "./secretLocations.ts";
import { SourceTransfers, type SourceOperationRecord } from "./sourceService.ts";
import { serveSource } from "./sourceTestServer.testkit.ts";

let base: string;
let fixture: UmbrellaFixture;
let transfers: SourceTransfers;
let served: Awaited<ReturnType<typeof serveSource>>;
const released: Array<{ operationId: string; reason: string }> = [];

let sourceHome: string;
beforeAll(async () => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-dest-home-")));
  fixture = makeUmbrella(base);
  sourceHome = NodePath.join(base, "source-home");
  NodeFS.mkdirSync(sourceHome, { recursive: true });
  transfers = new SourceTransfers(NodePath.join(base, "source-state"), {
    release: async (record: SourceOperationRecord, reason: string) => {
      released.push({ operationId: record.operationId, reason });
    },
    home: () => sourceHome,
  });
  served = await serveSource(transfers, "env-source");
}, 60_000);
afterAll(async () => {
  if (served !== undefined) await served.close();
  NodeFS.rmSync(base, { recursive: true, force: true });
});

const fast = { allowLoopback: true, sleep: async () => undefined, pollMs: 20 } as const;

async function settle(
  copies: DestinationCopies,
  operationId: string,
  until: ReadonlyArray<string>,
) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await copies.waitFor(operationId);
    const record = await copies.read(operationId);
    if (record && until.includes(record.state)) return record;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`copy ${operationId} never reached ${until.join(", ")}`);
}

async function offer(mode: "copy-only" | "copy-and-move" = "copy-only") {
  const operationId = NodeCrypto.randomUUID();
  const offered = await transfers.offer({
    operationId,
    projectId: "project-source",
    folder: fixture.root,
    mode,
    destinationEnvironmentId: "env-destination",
    secretPatterns: ["~/.config/acme/token.json", "*.creds"],
  });
  return { operationId, token: offered.token };
}

const startInput = (operationId: string, token: string, target: string, mode = "copy-only") => ({
  operationId,
  sourceUrl: served.url,
  token,
  sourceEnvironmentId: "env-source",
  sourceProjectId: "project-source",
  sourceMachine: "M4MAX",
  mode: mode as "copy-only" | "copy-and-move",
  targetFolder: target,
  title: "Umbrella",
});

describe("home secret files", () => {
  it("sends ticked ~/ files to the same place in the other home, privately, and Undo removes them", async () => {
    write(
      NodePath.join(fixture.root, "src/Api/Api.csproj"),
      "<Project><PropertyGroup><UserSecretsId>api-77</UserSecretsId></PropertyGroup></Project>",
    );
    const inHome = platformHomePath(".microsoft/usersecrets/api-77/secrets.json", process.platform);
    const userSecrets = NodePath.join(sourceHome, inHome);
    NodeFS.mkdirSync(NodePath.dirname(userSecrets), { recursive: true });
    NodeFS.writeFileSync(userSecrets, '{"Db":"fixture-db"}');
    const token = NodePath.join(sourceHome, ".config/acme/token.json");
    NodeFS.mkdirSync(NodePath.dirname(token), { recursive: true });
    NodeFS.writeFileSync(token, "fixture-token");
    write(NodePath.join(fixture.root, "ops/deploy.creds"), "fixture-creds");
    const destinationHome = NodePath.join(base, "destination-home");
    NodeFS.mkdirSync(destinationHome, { recursive: true });
    const state = NodePath.join(base, "dest-state-home");
    const copies = new DestinationCopies(state, { ...fast, home: () => destinationHome });
    const { operationId, token: grant } = await offer();
    const target = NodePath.join(base, "targets", "home");
    await copies.start(startInput(operationId, grant, target));
    await settle(copies, operationId, ["previewed"]);
    const summary = (await transfers.read(operationId))?.summary;
    expect((summary?.secretFiles ?? []).map((item) => item.path)).toEqual([
      "~/.microsoft/usersecrets/api-77/secrets.json",
      ".env",
      "ops/deploy.creds",
    ]);
    // Any other home file is listed for the person to copy, never sent.
    expect(summary?.secretHints).toEqual([
      expect.objectContaining({ path: "~/.config/acme/token.json", source: "Home folder" }),
    ]);
    // A home path the scan did not offer is refused, whatever it holds (any case).
    for (const path of ["~/.ssh/id_rsa", "~/.NETRC", "~/.config/acme/token.json"])
      await expect(
        transfers.approveSecrets({ operationId, paths: [path], destinationLabel: "M3" }),
      ).rejects.toMatchObject({ status: 400, code: "not_offered" });
    await transfers.approveSecrets({
      operationId,
      paths: ["~/.microsoft/usersecrets/api-77/secrets.json"],
      destinationLabel: "M3",
    });
    await copies.approve(operationId);
    const applied = await settle(copies, operationId, ["applied", "failed"]);
    expect(applied.error).toBeNull();
    const landed = NodePath.join(destinationHome, ".config/acme/token.json");
    const dotnet = NodePath.join(destinationHome, inHome);
    expect(NodeFS.existsSync(landed)).toBe(false);
    expect(NodeFS.readFileSync(dotnet, "utf8")).toBe('{"Db":"fixture-db"}');
    if (process.platform !== "win32") expect(NodeFS.statSync(dotnet).mode & 0o777).toBe(0o600);
    // Never inside the copied folder, and the unticked pattern match stayed behind.
    expect(NodeFS.existsSync(NodePath.join(target, "~"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(target, "ops/deploy.creds"))).toBe(false);
    expect(applied.secrets?.map((item) => item.writtenAs)).toEqual([`~/${inHome}`]);
    const records = NodeFS.readFileSync(
      NodePath.join(state, "folder-copies", operationId, "operation.json"),
      "utf8",
    );
    expect(records).not.toContain("fixture-token");
    await copies.undo(operationId, false);
    expect(NodeFS.existsSync(dotnet)).toBe(false);
  }, 120_000);

  it("takes no secret files when approved without secrets, whatever the source staged", async () => {
    write(NodePath.join(fixture.root, "ops/staged.creds"), "fixture-staged");
    const state = NodePath.join(base, "dest-state-without");
    const copies = new DestinationCopies(state, { ...fast, home: () => sourceHome });
    const { operationId, token: grant } = await offer();
    const target = NodePath.join(base, "targets", "without");
    await copies.start(startInput(operationId, grant, target));
    await settle(copies, operationId, ["previewed"]);
    // An allowed window staged it earlier; this approval comes from one that may not send it.
    await transfers.approveSecrets({
      operationId,
      paths: ["ops/staged.creds"],
      destinationLabel: "M3",
    });
    await copies.approve(operationId, { withoutSecrets: true });
    const applied = await settle(copies, operationId, ["applied", "failed"]);
    expect(applied.error).toBeNull();
    expect(applied.secrets ?? []).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(target, "ops/staged.creds"))).toBe(false);
  }, 120_000);
});
