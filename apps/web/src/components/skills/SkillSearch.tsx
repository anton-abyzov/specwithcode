/**
 * One search box over this machine's installed skills, the skills its
 * connected repos offer, and notes in its Obsidian vault. Searching reads
 * only: a skill installs when Install is pressed.
 */
import {
  AuthFilesystemReadScope,
  AuthTerminalOperateScope,
  formatSkillSourceVersion,
  type ProjectSkillSearchAvailable,
  type ProjectSkillSourceStatus,
  type ProjectSkillsSearchResult,
  type ProjectSkillUpdateOutcome,
} from "@specweave-studio/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useTx } from "../../i18n";
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
  SKILL_CHANGE_PERMISSION,
  skillFolderInput,
  type SkillFolderScope,
} from "./SkillUpdate.logic";
import { SkillRolloutAfter } from "./SkillRollout";
import {
  SkillUpdateOutcomeLine,
  skillCommandErrorText,
  useSkillUpdateRun,
} from "./SkillUpdateOutcome";

const SEARCH_DELAY_MS = 250;
const MIN_QUERY = 2;

function Group({
  name,
  title,
  count,
  children,
}: {
  name: string;
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section data-group={name} aria-label={title} className="space-y-1.5">
      <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {title}
        <span className="tabular-nums">{count}</span>
      </h4>
      {children}
    </section>
  );
}

export function SkillSearch({
  onChanged,
  ...scope
}: SkillFolderScope & {
  /** Called after an install changed this machine. */ onChanged?: () => void;
}) {
  const tx = useTx();
  const { environmentId } = scope;
  const machine = useMachineNickname(environmentId) || tx("this machine");
  const canRead = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const canTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const search = useAtomCommand(projectWorkspace.skillsSearch, { reportFailure: false });
  const { canRun, run } = useSkillUpdateRun(scope, onChanged);
  const [text, setText] = useState("");
  /** The last answer, with the machine and folder it was asked for. */
  const [answered, setAnswered] = useState<{
    readonly scope: string;
    readonly value: ProjectSkillsSearchResult;
  } | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<ReadonlyArray<ProjectSkillUpdateOutcome>>([]);
  const [statuses, setStatuses] = useState<ReadonlyArray<ProjectSkillSourceStatus>>([]);
  const [noteMessage, setNoteMessage] = useState<string | null>(null);
  const asked = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const folder = JSON.stringify(skillFolderInput(scope));
  const scopeKey = `${environmentId}\u0000${folder}`;
  const query = text.trim();
  // An answer for another machine or folder is never shown; one for an older query is
  // shown dimmed, with nothing to install, until the new answer arrives.
  const result = answered !== null && answered.scope === scopeKey ? answered.value : null;
  const stale = result !== null && result.query !== query;

  const ask = async (value: string) => {
    const ticket = asked.current;
    const askedFor = scopeKey;
    setSearching(true);
    const answer = await search({
      environmentId,
      input: { ...JSON.parse(folder), operation: "search", query: value },
    });
    // A slower, older answer never replaces a newer one.
    if (ticket !== asked.current) return;
    setSearching(false);
    if (answer._tag !== "Success") {
      setError(skillCommandErrorText(answer));
      return;
    }
    setError(null);
    setAnswered({ scope: askedFor, value: answer.value });
  };

  const change = (value: string) => {
    setText(value);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    // Every edit drops any answer still on its way.
    asked.current += 1;
    const next = value.trim();
    if (next.length < MIN_QUERY) {
      setAnswered(null);
      setSearching(false);
      setError(null);
      return;
    }
    timer.current = setTimeout(() => void ask(next), SEARCH_DELAY_MS);
  };
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [timer],
  );

  const install = async (entry: ProjectSkillSearchAvailable) => {
    const key = `${entry.repo}/${entry.skill.name}`;
    setInstalling(key);
    setError(null);
    const done = await run({
      operation: "install",
      install: { repo: entry.repo, skill: entry.skill.name },
    });
    setInstalling(null);
    if (!done.ok) {
      setError(done.error);
      return;
    }
    setOutcomes(done.value.outcomes ?? []);
    setStatuses(done.value.statuses);
    if (query.length >= MIN_QUERY) {
      asked.current += 1;
      void ask(query);
    }
  };

  const openNote = async (path: string) => {
    setNoteMessage(null);
    const answer = await search({
      environmentId,
      input: { ...JSON.parse(folder), operation: "open-note", note: path },
    });
    if (answer._tag !== "Success" || answer.value.opened !== true)
      setNoteMessage(tx("Obsidian on {machine} did not open the note.", { machine }));
  };

  return (
    <section
      aria-label={tx("Search skills and notes")}
      className="space-y-3"
      data-testid="skill-search"
    >
      <div className="relative">
        <Input
          type="search"
          nativeInput
          value={text}
          maxLength={200}
          aria-label={tx("Search skills and notes")}
          placeholder={tx("Search installed skills, connected repos and notes")}
          onChange={(event) => change(event.target.value)}
        />
        {searching ? (
          <Spinner className="absolute end-2.5 top-1/2 size-3.5 -translate-y-1/2" />
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
      {outcomes.map((outcome) => (
        <div key={outcome.skill} className="space-y-2">
          <SkillUpdateOutcomeLine outcome={outcome} />
          <SkillRolloutAfter
            environmentId={environmentId}
            projectId={scope.projectId}
            outcome={outcome}
            statuses={statuses}
          />
        </div>
      ))}
      {result ? (
        <div
          className={stale ? "space-y-4 opacity-60" : "space-y-4"}
          aria-busy={stale || undefined}
          data-stale={stale || undefined}
        >
          <Group
            name="installed"
            title={tx("Installed on {machine}", { machine })}
            count={result.installed.length}
          >
            {result.installed.length === 0 ? (
              <p className="text-xs text-muted-foreground">{tx("No installed skill matches.")}</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {result.installed.map((skill) => (
                  <li key={skill.name} className="space-y-0.5 px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-foreground">{skill.name}</span>
                      {skill.version ? (
                        <span className="font-mono text-xs text-muted-foreground">
                          {skill.version}
                        </span>
                      ) : null}
                      {skill.agents.map((agent) => (
                        <Badge key={agent} size="sm" variant="outline">
                          {agent}
                        </Badge>
                      ))}
                    </div>
                    {skill.description ? (
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {skill.description}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Group>
          <Group
            name="available"
            title={tx("Available in a connected repo")}
            count={result.available.length}
          >
            {result.available.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {tx("No skill in a connected repo matches.")}
              </p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {result.available.map((entry) => {
                  const key = `${entry.repo}/${entry.skill.name}`;
                  return (
                    <li key={key} className="flex items-start gap-3 px-3 py-2">
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium text-foreground">{entry.skill.name}</span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {formatSkillSourceVersion(entry.skill)}
                          </span>
                          {entry.visibility === "private" ? (
                            <Badge size="sm" variant="outline">
                              {tx("Private")}
                            </Badge>
                          ) : null}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">{entry.repo}</p>
                        {entry.skill.description ? (
                          <p className="line-clamp-2 text-xs text-muted-foreground">
                            {entry.skill.description}
                          </p>
                        ) : null}
                      </div>
                      <SkillControlReason reason={canRun ? null : tx(SKILL_CHANGE_PERMISSION)}>
                        <Button
                          size="xs"
                          variant="outline"
                          type="button"
                          disabled={!canRun || stale || installing !== null}
                          onClick={() => void install(entry)}
                        >
                          {installing === key ? <Spinner className="size-3" /> : null}
                          {tx("Install")}
                        </Button>
                      </SkillControlReason>
                    </li>
                  );
                })}
              </ul>
            )}
          </Group>
          <Group name="notes" title={tx("Notes")} count={result.notes.length}>
            {result.notesState === "none" ? (
              <p className="text-xs text-muted-foreground">
                {tx("No Obsidian vault on {machine}.", { machine })}
              </p>
            ) : result.notes.length === 0 ? (
              <p className="text-xs text-muted-foreground">{tx("No note matches.")}</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {result.notes.map((note) => (
                  <li key={note.path} className="flex items-start gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="font-medium text-foreground">{note.title}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {note.vault} · {note.path}
                      </p>
                      {note.snippet ? (
                        <p className="line-clamp-2 text-xs text-muted-foreground">{note.snippet}</p>
                      ) : null}
                    </div>
                    {canRead && canTerminal ? (
                      <Button
                        size="xs"
                        variant="outline"
                        type="button"
                        onClick={() => void openNote(note.path)}
                      >
                        {tx("Open in Obsidian")}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {result.notesState === "partial" ? (
              <p className="text-xs text-muted-foreground">
                {tx("More notes may match. Narrow the search.")}
              </p>
            ) : null}
            {noteMessage ? (
              <p role="alert" className="text-xs text-destructive-foreground">
                {noteMessage}
              </p>
            ) : null}
          </Group>
        </div>
      ) : null}
    </section>
  );
}
