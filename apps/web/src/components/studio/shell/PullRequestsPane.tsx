/**
 * The project's PRs tab: every pull request its threads opened or linked,
 * grouped Open, Merged and Closed. A row opens the pull request; its thread
 * name opens the thread that owns it.
 */
import type { ThreadId } from "@specweave-studio/contracts";
import { useOpenLink } from "../../../browser/useOpenLink";
import { useNowMinute } from "../../../hooks/useNowMinute";
import {
  PROJECT_PULL_REQUEST_GROUPS,
  pullRequestGroup,
  type ProjectPullRequest,
} from "../../../studio/projectPaneModel";
import { compactAge, nowFromMinute } from "../../../studio/shellModel";
import { PULL_REQUEST_STATE_PRESENTATION } from "../../pullRequest/pullRequestIcons";
import { ProjectPaneBar, type ProjectPaneBarProps } from "./ProjectPaneBar";

export function PullRequestsPane({
  pullRequests,
  onOpenThread,
  bar,
  acrossMachines = false,
}: {
  pullRequests: readonly ProjectPullRequest[];
  onOpenThread: (id: ThreadId) => void;
  bar: ProjectPaneBarProps;
  /** The checkouts span machines: say so, and name each row's machines. */
  acrossMachines?: boolean;
}) {
  const openLink = useOpenLink(null);
  const now = nowFromMinute(useNowMinute());
  return (
    <>
      <ProjectPaneBar {...bar} />
      <div
        className="sws-threads-body"
        id="sws-pane-prs"
        role="tabpanel"
        aria-labelledby="sws-pane-tab-prs"
      >
        {acrossMachines ? (
          <p className="sws-pane-group-heading" data-prs-across-machines="">
            Pull requests from both machines
          </p>
        ) : null}
        {pullRequests.length === 0 ? (
          <p className="sws-empty sws-pane-empty" role="status">
            No pull requests yet. When a thread opens or links one, it shows here.
          </p>
        ) : (
          PROJECT_PULL_REQUEST_GROUPS.map((group) => {
            const rows = pullRequests.filter((pr) => pullRequestGroup(pr.state) === group);
            if (rows.length === 0) return null;
            const headingId = `sws-prs-${group.toLowerCase()}`;
            return (
              <section className="sws-thread-group" key={group} aria-labelledby={headingId}>
                <h3 id={headingId} className="sws-pane-group-heading">
                  {group}
                  <span className="sws-group-count">
                    {rows.length}
                    <span className="sr-only"> pull requests</span>
                  </span>
                </h3>
                <div className="sws-thread-list">
                  {rows.map((pr) => {
                    const presentation = PULL_REQUEST_STATE_PRESENTATION[pr.state];
                    return (
                      <article className="sws-pr-row" key={pr.key} data-state={pr.state}>
                        <button
                          type="button"
                          className="sws-pr-open"
                          onClick={() => void openLink(pr.url).catch(() => undefined)}
                        >
                          <presentation.Icon
                            aria-hidden
                            className={`sws-pr-icon ${presentation.toneClassName}`}
                          />
                          <span className="sws-thread-text">
                            <strong>{pr.title}</strong>
                            <span className="sws-thread-meta">
                              {pr.repository} #{pr.number} · {presentation.label}
                              {acrossMachines && pr.machines?.length
                                ? ` · ${pr.machines.join(", ")}`
                                : ""}
                            </span>
                          </span>
                          <time className="sws-thread-age" dateTime={pr.updatedAt}>
                            {compactAge(pr.updatedAt, now)}
                          </time>
                        </button>
                        <button
                          type="button"
                          className="sws-pr-thread"
                          onClick={() => onOpenThread(pr.threadId)}
                        >
                          <span className="sr-only">Open thread </span>
                          {pr.threadTitle}
                        </button>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })
        )}
      </div>
    </>
  );
}
