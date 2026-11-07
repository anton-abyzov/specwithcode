import type {
  SkillPublication,
  SkillApplyRequest,
  SkillApplyResult,
} from "@specweave-studio/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as ProcessRunner from "../processRunner.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { findVskillBinary } from "./ProjectSkillsActionsCommon.ts";
import {
  SkillPublishingAdapter,
  SkillPublishingError,
  skillContentHash,
} from "./SkillPublishingService.ts";

const failure = (detail: string) => new SkillPublishingError({ detail });
const asObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  const home = expandHomePath("~");
  const http = yield* HttpClient.HttpClient;
  const installMutex = yield* Semaphore.make(1);
  const token = Effect.gen(function* () {
    // Read vskill's documented fallback store, never return its contents to the client.
    const stored = yield* fs
      .readFileString(path.join(home, ".vskill", "keys.env"))
      .pipe(Effect.orElseSucceed(() => ""));
    const match = stored.match(/^vskill-api-token=(vsk_[A-Za-z0-9_-]+)\s*$/m);
    if (match) return match[1];
    if (platform === "darwin") {
      const key = yield* runner
        .run({
          command: "security",
          args: ["find-generic-password", "-s", "vskill-token", "-a", "vskill-api-token", "-w"],
          timeout: "10 seconds",
          maxOutputBytes: 4096,
        })
        .pipe(Effect.option);
      if (
        key._tag === "Some" &&
        Number(key.value.code) === 0 &&
        /^vsk_[A-Za-z0-9_-]+$/.test(key.value.stdout.trim())
      )
        return key.value.stdout.trim();
    }
    return undefined;
  });
  const request = (
    url: string,
    headers: Record<string, string>,
    method = "GET",
    body?: unknown,
    allow404 = false,
  ): Effect.Effect<Record<string, unknown> | null, SkillPublishingError> =>
    Effect.gen(function* () {
      const base =
        method === "POST"
          ? HttpClientRequest.post(url)
          : method === "PUT"
            ? HttpClientRequest.put(url)
            : HttpClientRequest.get(url);
      const req = base.pipe(HttpClientRequest.setHeaders(headers));
      const response = yield* http
        .execute(body === undefined ? req : req.pipe(HttpClientRequest.bodyJsonUnsafe(body)))
        .pipe(
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          Effect.timeout("30 seconds"),
          Effect.mapError(() => failure("Publishing network request failed.")),
        );
      if (allow404 && response.status === 404) return null;
      if (response.status < 200 || response.status >= 300)
        return yield* failure(
          `Publishing request failed (HTTP ${response.status}). Check the selected account and repository.`,
        );
      const json = yield* response.json.pipe(
        Effect.mapError(() => failure("Invalid publishing response.")),
      );
      return Array.isArray(json) ? { entries: json } : asObject(json);
    });
  const github = (
    route: string,
    method = "GET",
    body?: unknown,
    allow404 = false,
  ): Effect.Effect<Record<string, unknown> | null, SkillPublishingError> =>
    Effect.gen(function* () {
      const auth = yield* runner
        .run({
          command: "gh",
          args: ["auth", "token", "--hostname", "github.com"],
          timeout: "10 seconds",
          maxOutputBytes: 4096,
        })
        .pipe(Effect.mapError(() => failure("Connect GitHub CLI before publishing.")));
      if (Number(auth.code) !== 0 || !auth.stdout.trim())
        return yield* Effect.fail(failure("Connect GitHub CLI before publishing."));
      return yield* request(
        `https://api.github.com${route}`,
        {
          Authorization: `Bearer ${auth.stdout.trim()}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        method,
        body,
        allow404,
      );
    });
  const registry = (route: string, tenant?: string, method = "GET", body?: unknown) =>
    Effect.gen(function* () {
      const credential = yield* token;
      if (tenant && !credential)
        return yield* Effect.fail(
          failure("Sign in with vskill auth login before private publishing."),
        );
      return (yield* request(
        `https://verified-skill.com${route}`,
        {
          "Content-Type": "application/json",
          ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
          ...(tenant ? { "X-Vskill-Tenant": tenant } : {}),
        },
        method,
        body,
      ))!;
    });
  const submission = (data: Record<string, unknown>, publication: SkillPublication) => {
    if (typeof data.id !== "string" || typeof data.state !== "string")
      throw failure("Registry returned no submission identity.");
    if (
      publication.visibility === "private" &&
      (data.privacy !== "PRIVATE" || data.tenantId !== publication.tenantId)
    )
      throw failure("Private submission account identity did not match.");
    return {
      id: data.id,
      state: data.state,
      ...(typeof data.error === "string" ? { detail: data.error } : {}),
    };
  };
  const verify = (publication: SkillPublication) =>
    Effect.gen(function* () {
      if (publication.visibility === "private") {
        const listing = yield* registry(
          `/api/v1/tenants/${encodeURIComponent(publication.tenantId!)}/skills?limit=100`,
          publication.tenant,
        );
        const rows = Array.isArray(listing.skills) ? listing.skills.map(asObject) : [];
        const found = rows.filter(
          (row) =>
            row.displayName === publication.skillId.split("/").at(-1) &&
            row.tenantId === publication.tenantId,
        );
        if (found.length !== 1)
          return yield* Effect.fail(
            failure("The published private identity is missing or ambiguous."),
          );
        const row = found[0]!;
        const download = yield* registry(
          `/api/v1/tenants/${encodeURIComponent(publication.tenantId!)}/skills/${encodeURIComponent(`${row.repoSlug}:${row.skillSlug}`)}/download?version=${encodeURIComponent(publication.version)}`,
          publication.tenant,
        );
        const skill = asObject(download.skill);
        const files = asObject(download.files);
        if (
          download.version !== publication.version ||
          download.contentHash !== publication.contentHash ||
          skill.tenantId !== publication.tenantId ||
          skill.repoUrl !== `https://github.com/${publication.repository}` ||
          skill.skillPath !== publication.skillPath ||
          typeof files["SKILL.md"] !== "string" ||
          skillContentHash(files["SKILL.md"]) !== publication.contentHash
        )
          return yield* Effect.fail(
            failure("Published private version or content does not match the draft."),
          );
        return;
      }
      const versions = yield* registry(
        `/api/v1/skills/${publication.skillId.split("/").map(encodeURIComponent).join("/")}/versions`,
      );
      const exact = (Array.isArray(versions.versions) ? versions.versions.map(asObject) : []).find(
        (row) => row.version === publication.version,
      );
      if (exact?.contentHash !== publication.contentHash)
        return yield* Effect.fail(
          failure("Published version or content does not match the draft."),
        );
    });
  const apply = (
    publication: SkillPublication,
    cwd: string,
    input: SkillApplyRequest,
    preview: boolean,
  ) =>
    Effect.gen(function* () {
      const dirs: Record<string, string> = {
        codex: ".agents/skills",
        "claude-code": ".claude/skills",
        cursor: ".agents/skills",
      };
      if (!input.agents.length || input.agents.some((agent) => !Object.hasOwn(dirs, agent)))
        return yield* Effect.fail(
          failure("Select a supported agent: Codex, Claude Code or Cursor."),
        );
      const root = input.scope === "user" ? home : cwd;
      const sourceName = publication.skillId.split("/").at(-1)!;
      let name = sourceName;
      if (publication.visibility === "private") {
        const listing = yield* registry(
          `/api/v1/tenants/${encodeURIComponent(publication.tenantId!)}/skills?limit=100`,
          publication.tenant,
        );
        const rows = (Array.isArray(listing.skills) ? listing.skills.map(asObject) : []).filter(
          (row) => row.displayName === sourceName && row.tenantId === publication.tenantId,
        );
        if (rows.length !== 1 || typeof rows[0]?.id !== "string")
          return yield* failure("Private install identity is missing or ambiguous.");
        const clean = (value: string, max: number) =>
          value
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, max) || "skill";
        name = `private-${clean(publication.tenant!, 16)}-${clean(sourceName, 26)}-${skillContentHash(`${publication.tenantId}\0${rows[0].id}`).slice(0, 12)}`;
      }
      const files = [
        ...new Set([
          path.join(root, ".agents", "skills", name, "SKILL.md"),
          ...input.agents.map((agent) => path.join(root, dirs[agent]!, name, "SKILL.md")),
        ]),
      ];
      const lockPath =
        input.scope === "user"
          ? path.join(home, ".agents", "vskill.lock")
          : path.join(cwd, "vskill.lock");
      // Check links before exists(): exists follows symlinks and misses dangling links.
      // Copy mode below keeps future retries free of installer-created symlinks.
      for (const target of [...files, lockPath]) {
        let component = target;
        while (component !== root && component !== path.dirname(component)) {
          const link = yield* fs.readLink(component).pipe(Effect.option);
          if (link._tag === "Some")
            return yield* failure(
              "The install destination contains a symbolic link. Installation was refused.",
            );
          component = path.dirname(component);
        }
        let parent = path.dirname(target);
        while (!(yield* fs.exists(parent))) {
          const next = path.dirname(parent);
          if (next === parent)
            return yield* failure(
              "The install filesystem root is unavailable. Nothing was installed.",
            );
          parent = next;
        }
        const real = yield* fs
          .realPath(parent)
          .pipe(Effect.mapError(() => failure("Could not verify the install destination.")));
        const canonicalRoot = yield* fs
          .realPath(root)
          .pipe(Effect.mapError(() => failure("Could not verify the selected folder.")));
        if (real !== canonicalRoot && !real.startsWith(`${canonicalRoot}${path.sep}`))
          return yield* failure("The install directory links outside the selected scope.");
      }
      const snapshots = yield* Effect.forEach([...files, lockPath], (file) =>
        fs.readFileString(file).pipe(Effect.orElseSucceed(() => "absent")),
      );
      const previewJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        publication,
        root,
        agents: input.agents,
        snapshots,
      }).pipe(Effect.mapError(() => failure("Invalid apply preview.")));
      const expectedHash = skillContentHash(previewJson);
      const contentMatches = (content: string) => {
        const comparable =
          publication.visibility === "private" && content.startsWith(`---\nname: ${name}\n`)
            ? content.replace(`---\nname: ${name}\n`, `---\nname: "${sourceName}"\n`)
            : content;
        return skillContentHash(comparable) === publication.contentHash;
      };
      const lockMatches = (value: unknown) => {
        const entry = asObject(asObject(asObject(value).skills)[name]);
        return (
          entry.version === publication.version &&
          entry.sha === publication.contentHash &&
          entry.sourceRepoUrl === `https://github.com/${publication.repository}` &&
          entry.sourceSkillPath === publication.skillPath &&
          entry.scope === input.scope &&
          (publication.visibility !== "private" ||
            (entry.sourcePrivate === true &&
              asObject(entry.hostedPrivate).tenantId === publication.tenantId))
        );
      };
      const existingLock = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
        snapshots[files.length],
      ).pipe(Effect.orElseSucceed(() => null));
      const alreadyInstalled =
        snapshots.slice(0, files.length).every(contentMatches) && lockMatches(existingLock);
      if (alreadyInstalled)
        return {
          preview,
          expectedHash,
          files: [...files, lockPath],
          summary: "Already installed and verified. Start a new session to load the skill.",
          installedVersion: publication.version,
          ready: false,
        } satisfies SkillApplyResult;
      for (const file of files) {
        if (yield* fs.exists(path.dirname(file)))
          return yield* failure(
            "A same-name skill directory already exists. Use another name or the existing skill's version controls.",
          );
      }
      if (snapshots.slice(0, files.length).some((content) => content !== "absent"))
        return yield* failure(
          "A same-name skill already exists. Rename this draft or use the existing skill's version controls.",
        );
      if (preview)
        return {
          preview: true,
          expectedHash,
          files: [...files, lockPath],
          summary: `Install ${publication.skillId}@${publication.version} for ${input.agents.join(", ")} in ${root}.`,
          ready: false,
        } satisfies SkillApplyResult;
      if (input.expectedHash !== expectedHash)
        return yield* Effect.fail(
          failure("The apply preview is stale. Preview the installation again."),
        );
      const binary = yield* findVskillBinary({
        home,
        pathEnv: env.PATH,
        platform,
        appData: env.APPDATA,
        pathExt: env.PATHEXT,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      if (!binary) return yield* Effect.fail(failure("Install vskill before applying this skill."));
      const args = [
        "install",
        publication.visibility === "private"
          ? sourceName
          : `${publication.skillId}@${publication.version}`,
        "-y",
        "--cwd",
        "--copy",
        ...(input.scope === "user" ? ["--global"] : []),
        ...input.agents.flatMap((agent) => ["--agent", agent]),
        ...(publication.visibility === "private"
          ? ["--tenant", publication.tenant!, "--version", publication.version]
          : []),
      ];
      const installed = yield* runner
        .run({ command: binary, args, cwd: root, timeout: "2 minutes", maxOutputBytes: 4096 })
        .pipe(
          Effect.mapError(() =>
            failure("The skill installer failed. Inspect Skills before retrying."),
          ),
        );
      if (Number(installed.code) !== 0)
        return yield* Effect.fail(
          failure("The skill installer failed. Inspect Skills before retrying."),
        );
      for (const file of files) {
        const content = yield* fs
          .readFileString(file)
          .pipe(Effect.mapError(() => failure("Installed file readback failed.")));
        if (!contentMatches(content))
          return yield* Effect.fail(
            failure("Installed content does not match the published version."),
          );
      }
      const lock = yield* fs
        .readFileString(lockPath)
        .pipe(Effect.mapError(() => failure("Installed lock readback failed.")));
      const decodedLock = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
        lock,
      ).pipe(Effect.mapError(() => failure("Installed lock is invalid.")));
      if (!lockMatches(decodedLock))
        return yield* Effect.fail(failure("Installed lock version does not match."));
      return {
        preview: false,
        expectedHash,
        files: [...files, lockPath],
        summary: "Installed and verified. Start a new session to load the skill.",
        installedVersion: publication.version,
        ready: false,
      } satisfies SkillApplyResult;
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(SkillPublishingError)(cause) ? cause : failure("Skill installation failed."),
      ),
    );
  return SkillPublishingAdapter.of({
    prepare: (destination) =>
      Effect.gen(function* () {
        if (
          !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(destination.repository)
        )
          return yield* Effect.fail(failure("Select a GitHub owner/repository."));
        const repo = yield* github(`/repos/${destination.repository}`);
        if (
          typeof repo?.private !== "boolean" ||
          repo.private !== (destination.visibility === "private")
        )
          return yield* Effect.fail(
            failure(
              "Selected visibility does not match the GitHub repository. Nothing was uploaded.",
            ),
          );
        if (destination.visibility === "public") return {};
        if (!destination.tenant)
          return yield* Effect.fail(failure("Select a private publishing account."));
        const account = yield* registry("/api/v1/account/tenants", destination.tenant);
        const matches = (
          Array.isArray(account.tenants) ? account.tenants.map(asObject) : []
        ).filter((row) => row.slug === destination.tenant);
        const tenant = matches.length === 1 ? matches[0] : undefined;
        const id = tenant?.tenantId ?? tenant?.id;
        if (!tenant?.installationId || typeof id !== "string")
          return yield* Effect.fail(
            failure("Connect the GitHub App for this private publishing account."),
          );
        return { tenantId: id };
      }),
    upload: (publication, content) =>
      Effect.gen(function* () {
        const route = `/repos/${publication.repository}/contents/${publication.skillPath}`;
        const directory = yield* github(
          route.slice(0, route.lastIndexOf("/")),
          "GET",
          undefined,
          true,
        );
        if (
          directory &&
          (!Array.isArray(directory.entries) ||
            directory.entries.some(
              (item) => asObject(item).name !== "SKILL.md" || asObject(item).type !== "file",
            ))
        )
          return yield* failure(
            "The publication folder contains files outside this draft. Choose a new version.",
          );
        const existing = yield* github(route, "GET", undefined, true);
        if (existing) {
          if (
            typeof existing.content !== "string" ||
            skillContentHash(Buffer.from(existing.content, "base64").toString("utf8")) !==
              publication.contentHash
          )
            return yield* Effect.fail(
              failure(
                "This skill version already exists with different content. Choose a new version.",
              ),
            );
          return;
        }
        yield* github(route, "PUT", {
          message: `Publish ${publication.skillId.split("/").at(-1)} ${publication.version}`,
          content: Buffer.from(content).toString("base64"),
        });
      }),
    submit: (publication) =>
      registry("/api/v1/submissions", publication.tenant, "POST", {
        repoUrl: `https://github.com/${publication.repository}`,
        skillName: publication.skillId.split("/").at(-1),
        skillPath: publication.skillPath,
        privacy: publication.visibility,
        ...(publication.tenantId ? { tenantId: publication.tenantId } : {}),
        source: "specwithcode",
      }).pipe(
        Effect.flatMap((data) =>
          Effect.try({
            try: () => submission(data, publication),
            catch: (cause) =>
              Schema.is(SkillPublishingError)(cause)
                ? cause
                : failure("Invalid submission response."),
          }),
        ),
      ),
    status: (publication) =>
      Effect.gen(function* () {
        let id = publication.submissionId;
        if (!id) {
          // Private submissions are not in the public account feed. Never infer
          // absence from that feed or repeat an uncertain private POST.
          if (publication.visibility === "private")
            return yield* failure(
              "The private submission response was lost. Archive this unresolved draft to create a new version; its receipt remains available and nothing is resubmitted.",
            );
          const feed = yield* registry("/api/v1/submissions?mine=1&limit=100", publication.tenant);
          const rows = Array.isArray(feed.submissions) ? feed.submissions.map(asObject) : [];
          const candidates = rows.filter(
            (row) =>
              row.repoUrl === `https://github.com/${publication.repository}` &&
              row.skillName === publication.skillId.split("/").at(-1) &&
              typeof row.id === "string",
          );
          // List summaries omit skillPath; fetch the authoritative details.
          const details = yield* Effect.forEach(candidates, (row) =>
            registry(`/api/v1/submissions/${encodeURIComponent(row.id as string)}`),
          );
          const matches = details.filter(
            (row) =>
              row.repoUrl === `https://github.com/${publication.repository}` &&
              row.skillPath === publication.skillPath &&
              row.skillName === publication.skillId.split("/").at(-1),
          );
          const complete =
            Array.isArray(feed.submissions) &&
            Number.isInteger(feed.total) &&
            feed.total === rows.length &&
            rows.length <= 100 &&
            feed.degraded !== true &&
            !feed.cache &&
            !feed.warning;
          if (matches.length === 0 && complete)
            return {
              id: "",
              state: "UNSUBMITTED",
              detail:
                "No submission was found in the complete account feed. Archive this draft to create a new version; this publication will not be resubmitted.",
            };
          if (matches.length !== 1 || typeof matches[0]?.id !== "string")
            return yield* failure(
              "The submission is not yet identifiable in the account feed. Check status again later; nothing was resubmitted.",
            );
          id = matches[0].id;
        }
        const data = yield* registry(
          `/api/v1/submissions/${encodeURIComponent(id)}`,
          publication.tenant,
        );
        if (
          publication.visibility === "public" &&
          (data.repoUrl !== `https://github.com/${publication.repository}` ||
            data.skillPath !== publication.skillPath)
        )
          return yield* Effect.fail(failure("Submission source did not match the draft."));
        return yield* Effect.try({
          try: () => submission(data, publication),
          catch: (cause) =>
            Schema.is(SkillPublishingError)(cause)
              ? cause
              : failure("Invalid submission response."),
        });
      }),
    verify,
    apply: (publication, cwd, input, preview) =>
      installMutex.withPermits(1)(apply(publication, cwd, input, preview)),
  });
});
export const layer = Layer.effect(SkillPublishingAdapter, make);
