/**
 * Skills in `~/.agents/skills` that vskill does not track: installed with
 * `npx skills`, copied by hand, or written here. Adopt records one in
 * vskill's lock when its folder matches a connected repo's copy; a skill
 * that matches nothing can be proposed to a connected repo as a pull
 * request, confirmed each time and never merged from here.
 */
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  type EnvironmentId,
  type ProjectId,
  type ProjectSkillAdoptCandidate,
  type ProjectSkillProposal,
} from "@specweave-studio/contracts";
import { useCallback, useEffect, useState } from "react";

import { useTx } from "../../i18n";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { SkillControlReason } from "../settings/ProjectSkillReason";
import { openSkillLink } from "../settings/ProjectSkillRowMenu";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { skillCommandErrorText } from "./SkillUpdateOutcome";

const TRACKER_LABELS = {
  "npx-skills": "Tracked by npx skills",
  none: "Not tracked",
} as const;

/** The repo a skill with no match is offered to: a connected private repo first. */
export function proposalRepoOf(
  repos: ReadonlyArray<{
    readonly repo: string;
    readonly visibility: string;
    readonly state: string;
  }>,
): string | null {
  const readable = repos.filter((entry) => entry.state === "ok");
  return (
    readable.find((entry) => entry.visibility === "private")?.repo ?? readable[0]?.repo ?? null
  );
}

export function SkillAdoptPanel({
  environmentId,
  projectId,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly onChanged?: (() => void) | undefined;
}) {
  const tx = useTx();
  const canRead = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const canSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const canTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canPropose = canSourceControl && canTerminal;
  const adopt = useAtomCommand(projectWorkspace.skillsAdopt, { reportFailure: false });
  const repos = useEnvironmentQuery(
    projectWorkspace.skillRepos({ environmentId, input: { projectId, operation: "read" } }),
  );
  const target = proposalRepoOf(repos.data?.repos ?? []);
  const [candidates, setCandidates] = useState<ReadonlyArray<ProjectSkillAdoptCandidate> | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [lines, setLines] = useState<ReadonlyMap<string, { text: string; failed: boolean }>>(
    new Map(),
  );
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ProjectSkillProposal | null>(null);
  const [pullRequests, setPullRequests] = useState<ReadonlyMap<string, string>>(new Map());

  const note = (skill: string, text: string, failed = false) =>
    setLines((previous) => new Map(previous).set(skill, { text, failed }));

  const check = useCallback(async () => {
    const answer = await adopt({ environmentId, input: { projectId, operation: "check" } });
    if (answer._tag !== "Success") {
      setError(skillCommandErrorText(answer));
      return;
    }
    setError(null);
    setCandidates(answer.value.candidates ?? []);
  }, [adopt, environmentId, projectId]);

  useEffect(() => {
    if (canRead) void check();
  }, [canRead, check]);

  if (!canRead || candidates === null || candidates.length === 0) return null;

  const runAdopt = async (skill: string) => {
    setBusy(skill);
    const answer = await adopt({ environmentId, input: { projectId, operation: "adopt", skill } });
    setBusy(null);
    if (answer._tag !== "Success") {
      note(skill, skillCommandErrorText(answer), true);
      return;
    }
    const outcome = answer.value.outcome;
    if (outcome?.outcome === "adopted") {
      note(
        skill,
        tx("Adopted {skill} {version} · {commit}. vskill now tracks it; the folder is unchanged.", {
          skill,
          version: outcome.version ?? "",
          commit: outcome.commit ?? "",
        }),
      );
      onChanged?.();
      await check();
    } else note(skill, outcome?.message ?? tx("{skill} was not adopted.", { skill }), true);
  };

  const preview = async (skill: string) => {
    if (target === null) return;
    setBusy(`propose:${skill}`);
    const answer = await adopt({
      environmentId,
      input: { projectId, operation: "propose-preview", skill, repo: target },
    });
    setBusy(null);
    if (answer._tag !== "Success" || answer.value.proposal === undefined) {
      note(
        skill,
        answer._tag === "Success" ? tx("Nothing to propose.") : skillCommandErrorText(answer),
        true,
      );
      return;
    }
    setProposal(answer.value.proposal);
  };

  const propose = async () => {
    if (proposal === null) return;
    const { skill, repo, fingerprint } = proposal;
    setBusy(`propose:${skill}`);
    const answer = await adopt({
      environmentId,
      input: { projectId, operation: "propose", skill, repo, fingerprint, confirmed: true },
    });
    setBusy(null);
    setProposal(null);
    if (answer._tag !== "Success" || !answer.value.pullRequestUrl) {
      note(
        skill,
        answer._tag === "Success"
          ? tx("GitHub opened no pull request.")
          : skillCommandErrorText(answer),
        true,
      );
      return;
    }
    const url = answer.value.pullRequestUrl;
    setPullRequests((previous) => new Map(previous).set(skill, url));
    note(skill, tx("Pull request opened on {repo}. It is not merged.", { repo }));
  };

  const repoName = target?.split("/")[1] ?? "";
  return (
    <section
      aria-label={tx("Not tracked by vskill")}
      className="space-y-2"
      data-testid="skill-adopt"
    >
      <div>
        <h3 className="font-medium text-foreground">{tx("Not tracked by vskill")}</h3>
        <p className="text-xs text-muted-foreground">
          {tx(
            "Adopt records a skill in vskill's lock when it matches a connected repo, so updates reach it. The folder is never moved or deleted.",
          )}
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
      <ul className="divide-y rounded-lg border">
        {candidates.map((candidate) => {
          const line = lines.get(candidate.skill);
          const pr = pullRequests.get(candidate.skill);
          return (
            <li key={candidate.skill} data-skill={candidate.skill} className="space-y-1 px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium text-foreground">{candidate.skill}</span>
                <Badge size="sm" variant="outline">
                  {tx(TRACKER_LABELS[candidate.tracker])}
                </Badge>
                <span className="flex-1" />
                {candidate.match ? (
                  <SkillControlReason
                    reason={canWrite ? null : tx("Needs permission to change files here.")}
                  >
                    <Button
                      size="xs"
                      variant="outline"
                      type="button"
                      disabled={!canWrite || busy !== null}
                      onClick={() => void runAdopt(candidate.skill)}
                    >
                      {busy === candidate.skill ? <Spinner className="size-3" /> : null}
                      {tx("Adopt")}
                    </Button>
                  </SkillControlReason>
                ) : target !== null && pr === undefined ? (
                  <SkillControlReason
                    reason={
                      canPropose ? null : tx("Needs permission to write to GitHub from here.")
                    }
                  >
                    <Button
                      size="xs"
                      variant="outline"
                      type="button"
                      disabled={!canPropose || busy !== null}
                      onClick={() => void preview(candidate.skill)}
                    >
                      {busy === `propose:${candidate.skill}` ? (
                        <Spinner className="size-3" />
                      ) : null}
                      {tx("Add to {repo}", { repo: repoName })}
                    </Button>
                  </SkillControlReason>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {candidate.match
                  ? tx("Matches {repo} {version}", {
                      repo: candidate.match.repo,
                      version: candidate.match.version ?? candidate.match.source.commit.slice(0, 7),
                    })
                  : (candidate.detail ?? tx("No connected repo holds this copy."))}
              </p>
              {line ? (
                <p
                  role={line.failed ? "alert" : "status"}
                  className={
                    line.failed ? "text-xs text-destructive-foreground" : "text-xs text-foreground"
                  }
                >
                  {line.text}
                </p>
              ) : null}
              {pr ? (
                <Button
                  size="xs"
                  variant="link"
                  type="button"
                  onClick={() => void openSkillLink(pr)}
                >
                  {tx("Open the pull request")}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <AlertDialog
        open={proposal !== null}
        onOpenChange={(open) => !open && busy === null && setProposal(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tx("Open a pull request on {repo}?", { repo: proposal?.repo ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tx(
                "This writes to GitHub: a new branch with {skill} and a pull request. Nothing is merged.",
                { skill: proposal?.skill ?? "" },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {proposal ? (
            <div className="space-y-1 px-6 pb-2 text-xs" data-testid="skill-proposal-files">
              <ul className="max-h-40 overflow-auto font-mono text-2xs text-muted-foreground">
                {proposal.files.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
              {proposal.skipped.length > 0 ? (
                <p className="text-muted-foreground">
                  {tx("Left out: {files}", { files: proposal.skipped.join(", ") })}
                </p>
              ) : null}
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose disabled={busy !== null} render={<Button variant="outline" />}>
              {tx("Cancel")}
            </AlertDialogClose>
            <Button disabled={busy !== null} onClick={() => void propose()}>
              {busy !== null ? <Spinner size="sm" /> : null}
              {tx("Open pull request")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
