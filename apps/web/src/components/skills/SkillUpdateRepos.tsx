/**
 * The skill repos this machine has connected: add one by `owner/repo` or a
 * GitHub link, see what it offers with each skill's version and source
 * commit, install one, or disconnect. A private repo is read only through the
 * machine's own GitHub sign-in.
 */
import {
  AuthSettingsWriteScope,
  formatSkillSourceVersion,
  parseSkillRepoRef,
  type ProjectSkillRepo,
  type ProjectSkillReposResult,
  type ProjectSkillUpdateOutcome,
  type SkillRepoRefusalReason,
} from "@specweave-studio/contracts";
import { useState } from "react";

import { useTx } from "../../i18n";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useMachineNickname } from "../../studio/machineNickname";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { SkillControlReason } from "../settings/ProjectSkillReason";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import {
  REPO_REFUSAL_PHRASES,
  SKILL_CHANGE_PERMISSION,
  SKILL_REPO_PERMISSION,
  type SkillFolderScope,
} from "./SkillUpdate.logic";
import {
  SkillUpdateOutcomeLine,
  skillCommandErrorText,
  useSkillUpdateRun,
} from "./SkillUpdateOutcome";

export function SkillUpdateRepos({
  onChanged,
  ...scope
}: SkillFolderScope & {
  /** Called after an install changed this machine. */ onChanged?: () => void;
}) {
  const tx = useTx();
  const { environmentId, projectId } = scope;
  const machine = useMachineNickname(environmentId) || tx("this machine");
  const canChange = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const query = useEnvironmentQuery(
    projectWorkspace.skillRepos({ environmentId, input: { projectId, operation: "read" } }),
  );
  const change = useAtomCommand(projectWorkspace.skillReposChange, { reportFailure: false });
  const { canRun, run } = useSkillUpdateRun(scope, onChanged);
  /** The answer of the last change; newer than the query until the query is read again. */
  const [changed, setChanged] = useState<ProjectSkillReposResult | null>(null);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<ReadonlyArray<ProjectSkillUpdateOutcome>>([]);

  const data = changed ?? query.data;
  const repos: ReadonlyArray<ProjectSkillRepo> = data?.repos ?? [];
  const suggestions = data?.suggestions ?? [];
  const busy = pending !== null;
  const repoPermission = canChange ? null : tx(SKILL_REPO_PERMISSION);
  const refusal = (reason: SkillRepoRefusalReason, repo: string) =>
    tx(REPO_REFUSAL_PHRASES[reason], { machine, repo });

  const send = async (operation: "connect" | "disconnect" | "read", repo?: string) => {
    setPending(`${operation}:${repo ?? ""}`);
    setError(null);
    const result = await change({
      environmentId,
      input: {
        projectId,
        operation,
        ...(repo === undefined ? {} : { repo }),
        ...(operation === "read" ? { refresh: true } : {}),
      },
    });
    setPending(null);
    if (result._tag !== "Success") {
      setError(skillCommandErrorText(result));
      return;
    }
    setChanged(result.value);
    if (result.value.refusal) {
      setError(refusal(result.value.refusal.reason, result.value.refusal.repo));
      return;
    }
    if (operation === "connect") setText("");
    query.refresh();
  };

  const connectTyped = () => {
    if (parseSkillRepoRef(text) === null) {
      setError(refusal("invalid", text.trim()));
      return;
    }
    void send("connect", text.trim());
  };

  const install = async (repo: string, skill: string) => {
    setPending(`install:${repo}/${skill}`);
    setError(null);
    const done = await run({ operation: "install", install: { repo, skill } });
    setPending(null);
    if (!done.ok) {
      setError(done.error);
      return;
    }
    setOutcomes(done.value.outcomes ?? []);
  };

  return (
    <section aria-label={tx("Skill repos")} className="space-y-2" data-testid="skill-repos">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium text-foreground">{tx("Skill repos")}</h3>
        {query.isPending ? <Spinner className="size-3" /> : null}
        <span className="flex-1" />
        {repos.length > 0 ? (
          <Button
            size="xs"
            variant="outline"
            type="button"
            disabled={busy}
            onClick={() => void send("read")}
          >
            {pending === "read:" ? <Spinner className="size-3" /> : null}
            {tx("Check again")}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {tx(
          "Connected on {machine} only. A private repo is read with the GitHub sign-in on {machine} and is never sent to a registry.",
          { machine },
        )}
      </p>
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          connectTyped();
        }}
      >
        <Input
          nativeInput
          size="sm"
          font="mono"
          className="min-w-0 flex-1"
          value={text}
          maxLength={300}
          aria-label={tx("Skill repo")}
          placeholder={tx("owner/repo or a GitHub link")}
          onChange={(event) => setText(event.target.value)}
        />
        <SkillControlReason reason={repoPermission}>
          <Button
            size="xs"
            variant="outline"
            type="submit"
            disabled={!canChange || busy || text.trim().length === 0}
          >
            {pending?.startsWith("connect:") ? <Spinner className="size-3" /> : null}
            {tx("Connect")}
          </Button>
        </SkillControlReason>
      </form>
      {suggestions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{tx("Suggested")}</span>
          {suggestions.map((repo) => (
            <Button
              key={repo}
              size="xs"
              variant="outline"
              type="button"
              disabled={!canChange || busy}
              onClick={() => void send("connect", repo)}
            >
              {tx("Connect {repo}", { repo })}
            </Button>
          ))}
        </div>
      ) : null}
      {(error ?? query.error) ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error ?? query.error}
        </p>
      ) : null}
      {outcomes.map((outcome) => (
        <SkillUpdateOutcomeLine key={outcome.skill} outcome={outcome} />
      ))}
      {repos.length > 0 ? (
        <ul className="space-y-2">
          {repos.map((repo) => (
            <li key={repo.repo} data-repo={repo.repo} className="rounded-lg border">
              <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
                <span className="font-mono text-xs font-medium text-foreground">{repo.repo}</span>
                <Badge size="sm" variant="outline">
                  {repo.visibility === "private" ? tx("Private") : tx("Public")}
                </Badge>
                {repo.state === "ok" ? (
                  <span className="text-xs text-muted-foreground">
                    {tx("Skills: {count}", { count: repo.skills.length })}
                    {repo.commit ? ` · ${repo.commit.slice(0, 7)}` : ""}
                  </span>
                ) : null}
                <span className="flex-1" />
                <SkillControlReason reason={repoPermission}>
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    type="button"
                    disabled={!canChange || busy}
                    onClick={() => void send("disconnect", repo.repo)}
                  >
                    {tx("Disconnect")}
                  </Button>
                </SkillControlReason>
              </div>
              {repo.state !== "ok" ? (
                <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                  {refusal(repo.state, repo.repo)}
                </p>
              ) : repo.skills.length === 0 ? (
                <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                  {tx("No skills found in this repo.")}
                </p>
              ) : (
                <ul className="divide-y border-t">
                  {repo.skills.map((skill) => (
                    <li
                      key={skill.path}
                      data-skill={skill.name}
                      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5"
                    >
                      <span className="text-foreground">{skill.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {formatSkillSourceVersion(skill)}
                      </span>
                      {skill.plugin ? (
                        <Badge size="sm" variant="outline">
                          {skill.plugin}
                        </Badge>
                      ) : null}
                      <span className="flex-1" />
                      <SkillControlReason reason={canRun ? null : tx(SKILL_CHANGE_PERMISSION)}>
                        <Button
                          size="xs"
                          variant="outline"
                          type="button"
                          disabled={!canRun || busy}
                          onClick={() => void install(repo.repo, skill.name)}
                        >
                          {pending === `install:${repo.repo}/${skill.name}` ? (
                            <Spinner className="size-3" />
                          ) : null}
                          {tx("Install")}
                        </Button>
                      </SkillControlReason>
                    </li>
                  ))}
                </ul>
              )}
              {repo.truncated ? (
                <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                  {tx("This repo holds more skills than are listed here.")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
