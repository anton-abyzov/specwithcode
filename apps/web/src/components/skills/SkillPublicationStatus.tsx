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

export function SkillPublicationStatus({
  publication,
  busy,
  onRefresh,
}: {
  publication: PublicationView;
  busy: boolean;
  onRefresh: () => void;
}) {
  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label="Publication status">
      <p className="font-medium" role="status">
        {labels[publication.status] ?? publication.status}
        {publication.status === "published" && publication.version
          ? ` v${publication.version}`
          : ""}
      </p>
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
