import { CheckIcon } from "lucide-react";
import { Button } from "../ui/button";

export interface PublicationView {
  status: string;
  submissionId?: string | undefined;
  detail?: string | undefined;
  skillId?: string | undefined;
  version?: string | undefined;
}

const labels: Record<string, string> = {
  submitting: "Submission not yet confirmed",
  queued: "Queued for review",
  reviewing: "Review in progress",
  rejected: "Changes requested",
  blocked: "Publication blocked",
  published: "Published",
  failed: "Publication failed",
  unknown: "Status unknown",
};

// The path a submission takes through vskill: SKILL.md lands in the repository, the
// registry queues it, two automated scans review it, then it is published.
const steps = [
  { key: "submitting", label: "Uploaded to GitHub, sent to vskill" },
  { key: "queued", label: "Waiting in the review queue" },
  { key: "reviewing", label: "Automated security and quality scans" },
  { key: "published", label: "Published" },
] as const;

export function SkillPublicationStatus({
  publication,
  busy,
  onRefresh,
  following = false,
  paused = false,
}: {
  publication: PublicationView;
  busy: boolean;
  onRefresh: () => void;
  following?: boolean;
  paused?: boolean;
}) {
  const current = steps.findIndex((step) => step.key === publication.status);
  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label="Publication status">
      <p className="font-medium" role="status">
        {labels[publication.status] ?? publication.status}
        {publication.status === "published" && publication.version
          ? ` v${publication.version}`
          : ""}
      </p>
      {current >= 0 ? (
        <ol className="space-y-1.5 text-sm" aria-label="Publication progress">
          {steps.map((step, index) => {
            const done = index < current || publication.status === "published";
            const active = index === current && publication.status !== "published";
            return (
              <li
                key={step.key}
                aria-current={active ? "step" : undefined}
                className={
                  done || active
                    ? "flex items-center gap-2"
                    : "flex items-center gap-2 text-muted-foreground"
                }
              >
                <span
                  aria-hidden
                  className={
                    done
                      ? "flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground"
                      : active
                        ? "size-4 animate-pulse rounded-full border-2 border-primary motion-reduce:animate-none"
                        : "size-4 rounded-full border"
                  }
                >
                  {done ? <CheckIcon className="size-3" /> : null}
                </span>
                {step.label}
                <span className="sr-only">
                  {done ? " (done)" : active ? " (current step)" : " (upcoming)"}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
      {publication.detail ? (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{publication.detail}</p>
      ) : null}
      {publication.submissionId ? (
        <p className="break-all text-xs text-muted-foreground">
          Submission: {publication.submissionId}
        </p>
      ) : null}
      {publication.status !== "published" ? (
        <p className="text-sm text-muted-foreground">
          {following
            ? "Checked automatically every 20 seconds while this sheet is open. "
            : paused
              ? "Automatic checks are paused. Use Check status to look again. "
              : ""}
          You can close this sheet and return to check the review. Publication does not apply the
          skill.
        </p>
      ) : null}
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRefresh}>
        Check status
      </Button>
    </section>
  );
}
