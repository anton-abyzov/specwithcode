import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ProjectId,
  type ProjectKnowledgeSearchResult,
  type ProjectKnowledgeStatus,
  type ProjectWorkspaceReadResult,
} from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { formatAgo } from "../../studio/hostLimitsModel";
import {
  KNOWLEDGE_POLL_MS,
  knowledgeAccess,
  knowledgeAccessProblem,
  knowledgeAllowanceText,
  knowledgeCapacity,
  knowledgeModeText,
  knowledgeModifiedDate,
  knowledgeSearchText,
  knowledgeShouldPoll,
  knowledgeSkippedText,
  knowledgeStateText,
  knowledgeTokens,
} from "../../studio/projectKnowledgeModel";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScopeAccess } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

type MemorySummary = ProjectWorkspaceReadResult["memory"];

/** The status Rebuild index returned, and when; it stands until the host answers again. */
type RebuildStarted = {
  readonly environmentId: EnvironmentId;
  readonly at: number;
  readonly status: ProjectKnowledgeStatus;
};

/**
 * What the project's threads receive as knowledge: the mode, how full the
 * index is, its sources, and a search box that finds what a thread would.
 */
export function ProjectKnowledge({
  environmentId,
  projectId,
  memory,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  memory: MemorySummary;
}) {
  const environment = useEnvironment(environmentId);
  const connection = environment?.connection ?? null;
  const read = useEnvironmentScopeAccess(environmentId, AuthOrchestrationReadScope, connection);
  const files = useEnvironmentScopeAccess(environmentId, AuthFilesystemReadScope, connection);
  const config = environment?.serverConfig ?? null;
  const access = knowledgeAccess({
    phase: connection?.phase,
    supported: config ? config.environment.capabilities.projectKnowledge === true : null,
    read,
    files,
  });
  const problem = knowledgeAccessProblem(access, environment?.label ?? "this machine");
  const query = useEnvironmentQuery(
    access === "ready" ? projectWorkspace.knowledge({ environmentId, input: { projectId } }) : null,
  );
  const updatedAt = query.dataUpdatedAt;
  const [rebuilt, setRebuilt] = useState<RebuildStarted | null>(null);
  // Once the host answers after a rebuild, its status is current again, and stays so.
  if (rebuilt !== null && updatedAt > rebuilt.at) setRebuilt(null);
  // Until then, the status the rebuild returned is the latest word.
  const awaitingRebuild =
    access === "ready" &&
    rebuilt !== null &&
    rebuilt.environmentId === environmentId &&
    rebuilt.status.projectId === projectId &&
    updatedAt <= rebuilt.at;
  // A query that is not running says nothing about this project.
  const status =
    access === "ready" ? (awaitingRebuild ? rebuilt.status : (query.data ?? null)) : null;
  const answeredAt = awaitingRebuild ? rebuilt.at : updatedAt;
  const canRebuild = useAtomValue(projectWorkspace.knowledgeReindex.permissionAtom(environmentId));
  const reindex = useAtomCommand(projectWorkspace.knowledgeReindex, { reportFailure: false });
  const search = useAtomCommand(projectWorkspace.knowledgeSearch, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  // Two clicks in one moment would both start before the button turns off.
  const sending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [found, setFound] = useState<ProjectKnowledgeSearchResult | null>(null);
  const [searching, setSearching] = useState(false);

  const refresh = query.refresh;
  const polling = awaitingRebuild || knowledgeShouldPoll(status);
  // Asks again a moment after each answer, never while one is still pending.
  useEffect(() => {
    if (!polling) return;
    const timer = setTimeout(refresh, Math.max(0, answeredAt + KNOWLEDGE_POLL_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [polling, refresh, answeredAt]);

  // A saved memory file changes what threads receive; ask again once it lands.
  const memorySignature = useMemo(
    () => memory.files.map((file) => `${file.name}@${file.revision}`).join("|"),
    [memory.files],
  );
  const seenSignature = useRef(memorySignature);
  useEffect(() => {
    if (seenSignature.current === memorySignature) return;
    seenSignature.current = memorySignature;
    if (access === "ready") refresh();
  }, [memorySignature, access, refresh]);

  async function rebuild() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    const result = await reindex({ environmentId, input: { projectId } });
    sending.current = false;
    setBusy(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "The index could not be rebuilt.");
      return;
    }
    // Shown at once, so the card says "Indexing…"; the poll asks the host again shortly.
    setRebuilt({ environmentId, at: Date.now(), status: result.value });
  }

  async function find(value: string) {
    const trimmed = value.trim();
    if (!trimmed || searching) return;
    setSearching(true);
    setError(null);
    const result = await search({ environmentId, input: { projectId, query: trimmed } });
    setSearching(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      // Passages from an earlier search would read as this one's.
      setFound(null);
      setError(failure instanceof Error ? failure.message : "Search failed. Try again.");
      return;
    }
    setFound(result.value);
  }

  const mode = status ? knowledgeModeText(status) : null;
  const capacity = status ? knowledgeCapacity(status) : null;
  const skipped = status ? knowledgeSkippedText(status.skipped) : null;
  const foundText = found ? knowledgeSearchText(found) : null;
  return (
    <section className="project-settings-section" aria-labelledby="project-knowledge-heading">
      <div className="project-section-title">
        <h2 id="project-knowledge-heading">Project knowledge</h2>
        {access === "ready" && (
          <div className="project-actions">
            <button
              type="button"
              className="project-control"
              onClick={refresh}
              disabled={query.isPending}
            >
              Check again
            </button>
            <button
              type="button"
              className="project-control"
              onClick={() => void rebuild()}
              disabled={!canRebuild || busy || awaitingRebuild || status?.state === "indexing"}
            >
              Rebuild index
            </button>
          </div>
        )}
      </div>
      <p className="project-muted">
        Threads use this project&apos;s memory files, hub artifacts and Library documents as
        knowledge. While memory files and hub artifacts fit, Claude and Codex worker threads receive
        them in full; past that, threads search everything and read only what they need.
      </p>
      {access === "ready" && !canRebuild && (
        <p className="project-muted">
          Rebuilding the index needs permission to run work on{" "}
          {environment?.label ?? "this machine"}.
        </p>
      )}
      {problem && (
        <p className="project-notice" role="status">
          {problem}
        </p>
      )}
      {access === "ready" && query.error && <p role="alert">{query.error}</p>}
      {access === "ready" && !status && !query.error && (
        <p role="status" className="project-muted">
          Loading project knowledge…
        </p>
      )}
      {status && mode && capacity && (
        <>
          <p className="project-knowledge-mode">
            <strong>{mode.title}</strong>
            <span className="project-muted" role="status">
              {knowledgeStateText(status, (at) => formatAgo(at, answeredAt))}
            </span>
          </p>
          {/* A first build that failed already names its problem beside the title. */}
          {mode.detail !== status.problem && <p className="project-muted">{mode.detail}</p>}
          <div
            className="project-knowledge-bar"
            data-tone={capacity.tone}
            role="meter"
            aria-label="Index capacity"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(capacity.share * 100)}
          >
            <span
              style={{ width: `${Math.max(capacity.share > 0 ? 1 : 0, capacity.share * 100)}%` }}
            />
          </div>
          <p className="project-muted">{capacity.label}</p>
          {status.mode !== "empty" && (
            <p className="project-muted">{knowledgeAllowanceText(status)}</p>
          )}
          {status.sources.length > 0 && (
            <ul className="project-knowledge-sources" aria-label="Knowledge sources">
              {status.sources.map((source) => (
                <li key={`${source.kind}:${source.label}`}>
                  <span>{source.label}</span>
                  <small>
                    {source.documents.toLocaleString()}{" "}
                    {source.documents === 1 ? "document" : "documents"} ·{" "}
                    {knowledgeTokens(source.characters)}
                  </small>
                </li>
              ))}
            </ul>
          )}
          {skipped && <p className="project-muted">{skipped}</p>}
          <form
            className="project-inline-form project-knowledge-search"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              void find(text);
            }}
          >
            <input
              type="search"
              aria-label="Search project knowledge"
              placeholder="Search as a thread would, for example: storage decision"
              value={text}
              maxLength={1_000}
              onChange={(event) => setText(event.target.value)}
            />
            <button className="project-control" disabled={searching || text.trim().length === 0}>
              {searching ? "Searching…" : "Search"}
            </button>
          </form>
          {/* Present before the first search, so its outcome is announced; passages are not read out. */}
          <div className="sr-only" role="status">
            {searching ? "Searching…" : (foundText?.summary ?? "")}
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="project-notice">
          {error}
        </p>
      )}
      {found && foundText && (
        <div className="project-knowledge-results">
          {foundText.note && <p className="project-muted">{foundText.note}</p>}
          {found.results.length > 0 && (
            <ol aria-label="Search results">
              {found.results.map((hit) => (
                <li key={`${hit.documentId}:${hit.offset}`}>
                  <div>
                    <strong>{hit.title}</strong>
                    <small>{knowledgeModifiedDate(hit.modifiedAt)}</small>
                  </div>
                  <small>
                    {hit.location}
                    {hit.heading ? ` · ${hit.heading}` : ""}
                  </small>
                  {hit.excerpt && <p>{hit.excerpt}</p>}
                </li>
              ))}
            </ol>
          )}
          {found.truncated && found.results.length > 0 && (
            <p className="project-muted">More passages matched. Use more specific words.</p>
          )}
        </div>
      )}
    </section>
  );
}
