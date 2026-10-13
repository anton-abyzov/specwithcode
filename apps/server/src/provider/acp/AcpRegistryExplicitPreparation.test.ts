import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { AcpRegistrySettings } from "@specweave-studio/contracts";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSettings from "../../serverSettings.ts";
import { makeAcpRegistryCatalog } from "./AcpRegistrySupport.ts";
import { requiresExplicitAcpPreparation } from "./AcpExplicitPreparation.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const npmSource = `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const args=process.argv.slice(2), prefix=process.env.npm_config_prefix;
fs.appendFileSync(process.env.FAKE_NPM_LOG, args.join(' ')+'\\n');
if(args[0]==='root') console.log(path.join(prefix,'lib/node_modules'));
else if(args[0]==='prefix') console.log(prefix);
else if(args[0]==='install') {
 const spec=args[2], split=spec.lastIndexOf('@'), name=spec.slice(0,split), version=spec.slice(split+1);
 const bin=name==='@google/gemini-cli'?'gemini':name.split('/').pop(), pkg=path.join(prefix,'lib/node_modules',name);
 fs.mkdirSync(pkg,{recursive:true});fs.mkdirSync(path.join(prefix,'bin'),{recursive:true});
 fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name,version,bin:{[bin]:'cli.js'}}));
 fs.writeFileSync(path.join(prefix,'bin',bin),'#!/bin/sh\\n',{mode:0o755});
 if(process.env.GROK_HOME) {
  fs.mkdirSync(path.join(process.env.GROK_HOME,'bin'),{recursive:true});
  fs.writeFileSync(path.join(process.env.GROK_HOME,'bin/grok'),'#!/bin/sh\\n',{mode:0o755});
 }
} else process.exit(64);
`;

describe("featured ACP explicit preparation", () => {
  for (const [id, packageName, executableName] of [
    ["github-copilot-cli", "@github/copilot", "copilot"],
    ["grok-build", "@xai-official/grok", "grok"],
    ["gemini", "@google/gemini-cli", "gemini"],
  ] as const) {
    it.effect(`${id}: explicit install, repair and version changes preserve host ownership`, () => {
      let version = "1.0.0";
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              version: "1.0.0",
              agents: [
                {
                  id,
                  name: id,
                  version,
                  description: "test agent",
                  distribution: { npx: { package: `${packageName}@${version}`, args: ["--acp"] } },
                },
              ],
            }),
          ),
        ),
      );
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-explicit-acp-" });
        const bin = path.join(root, "bin");
        const foreignBin = path.join(root, "foreign-bin");
        const log = path.join(root, "npm.log");
        yield* fs.makeDirectory(bin);
        yield* fs.makeDirectory(foreignBin);
        // A separately installed CLI must not satisfy a missing managed executable.
        yield* fs.writeFileString(path.join(foreignBin, executableName), "#!/bin/sh\nexit 48\n");
        yield* fs.chmod(path.join(foreignBin, executableName), 0o755);
        yield* fs.writeFileString(log, "");
        yield* fs.writeFileString(path.join(bin, "npm"), npmSource);
        yield* fs.chmod(path.join(bin, "npm"), 0o755);
        const env = {
          PATH: `${bin}:${foreignBin}:${process.env.PATH}`,
          FAKE_NPM_LOG: log,
          HOME: root,
        };
        const catalog = yield* makeAcpRegistryCatalog({
          cacheDir: path.join(root, "cache"),
          toolsDir: path.join(root, "tools"),
          registryUrl: "https://registry.test/registry.json",
        }).pipe(Effect.provideService(HostProcessEnvironment, env));
        const settings = decodeSettings({ agentId: id });
        yield* catalog.search({ query: id });
        expect(yield* catalog.inspect(settings, env)).toMatchObject({ status: "unprepared" });
        const missing = yield* catalog.resolve(settings, root, env).pipe(Effect.flip);
        expect(missing.detail).toContain("Install / update agent");
        expect(yield* fs.readFileString(log)).toBe("");

        yield* catalog.prepare({ agentId: id });
        expect(yield* catalog.inspect(settings, env)).toMatchObject({ status: "ready", version });
        const resolved = yield* catalog.resolve(settings, root, env);
        expect(resolved.spawn.command).toContain(path.join(root, "tools", id, version));
        expect(path.basename(resolved.spawn.command)).toBe(executableName);
        expect(resolved.spawn.env?.HOME).toBe(root);
        let preparedLog = yield* fs.readFileString(log);
        expect(preparedLog.match(/^install --global /gmu)).toHaveLength(1);

        // Provider PATH customizations must not invalidate the host-owned install receipt.
        const alternateBin = path.join(root, "instance-bin");
        yield* fs.makeDirectory(alternateBin);
        yield* fs.writeFileString(path.join(alternateBin, "npm"), "#!/bin/sh\nexit 47\n");
        yield* fs.chmod(path.join(alternateBin, "npm"), 0o755);
        const instanceEnv = {
          ...env,
          PATH: `${alternateBin}:${env.PATH}`,
          PROVIDER_MARKER: "retained",
        };
        expect(yield* catalog.inspect(settings, instanceEnv)).toMatchObject({ status: "ready" });
        const instance = yield* catalog.resolve(settings, root, instanceEnv);
        expect(instance.spawn.env?.PROVIDER_MARKER).toBe("retained");
        expect(instance.spawn.env?.PATH).toContain(alternateBin);
        expect(yield* fs.readFileString(log)).toBe(preparedLog);

        // A retained receipt cannot hide a missing executable or trigger automatic repair.
        yield* fs.remove(resolved.spawn.command);
        expect(yield* catalog.inspect(settings, env)).toMatchObject({ status: "unprepared" });
        const broken = yield* catalog.resolve(settings, root, env).pipe(Effect.flip);
        expect(broken.detail).toContain("Install / update agent");
        expect(yield* fs.readFileString(log)).toBe(preparedLog);
        yield* catalog.prepare({ agentId: id });
        expect(yield* catalog.inspect(settings, instanceEnv)).toMatchObject({ status: "ready" });
        const repaired = yield* catalog.resolve(settings, root, instanceEnv);
        expect(yield* fs.exists(repaired.spawn.command)).toBe(true);
        expect(path.basename(repaired.spawn.command)).toBe(executableName);
        preparedLog = yield* fs.readFileString(log);
        expect(preparedLog.match(/^install --global /gmu)).toHaveLength(2);

        version = "1.0.1";
        yield* catalog.search({ query: id });
        expect(yield* catalog.inspect(settings, env)).toMatchObject({
          status: "unprepared",
          version,
        });
        const drift = yield* catalog.resolve(settings, root, env).pipe(Effect.flip);
        expect(drift.detail).toContain("1.0.1 is not prepared");
        expect(yield* fs.readFileString(log)).toBe(preparedLog);
        yield* catalog.prepare({ agentId: id });
        expect(yield* catalog.inspect(settings, env)).toMatchObject({ status: "ready", version });
        expect((yield* fs.readFileString(log)).match(/^install --global /gmu)).toHaveLength(3);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            ServerSettings.layerTest(),
            Layer.succeed(HostProcessPlatform, "linux"),
            Layer.succeed(HostProcessArchitecture, "x64"),
            Layer.succeed(HttpClient.HttpClient, http),
          ),
        ),
      );
    });
  }

  it("limits the compatibility policy to the matching official package and registry identity", () => {
    expect(requiresExplicitAcpPreparation("github-copilot-cli", "@github/copilot@1.0.94")).toBe(
      true,
    );
    expect(requiresExplicitAcpPreparation("grok-build", "@xai-official/grok@1.0.50")).toBe(true);
    expect(requiresExplicitAcpPreparation("gemini", "@google/gemini-cli@0.63.0")).toBe(true);
    expect(requiresExplicitAcpPreparation("gemini", "@other/gemini-cli@0.63.0")).toBe(false);
    expect(requiresExplicitAcpPreparation("gemini", "@google/gemini-cli-tools@0.63.0")).toBe(false);
    expect(requiresExplicitAcpPreparation("custom", "@google/gemini-cli@0.63.0")).toBe(false);
    expect(requiresExplicitAcpPreparation("gemini")).toBe(false);
    expect(requiresExplicitAcpPreparation("grok-build", "@other/grok@1.0.50")).toBe(false);
    expect(requiresExplicitAcpPreparation("custom", "@github/copilot@1.0.94")).toBe(false);
  });
});
