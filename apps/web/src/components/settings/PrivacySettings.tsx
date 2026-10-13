import { DownloadIcon, FileSearchIcon, ShieldCheckIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { resolveUsageAccess } from "@specweave-studio/client-runtime/state/usage-access";

import { APP_VERSION } from "../../branding";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import {
  buildPrivateDiagnosticsReport,
  productUsageStatusLabel,
  type PrivateDiagnosticsReport,
} from "./PrivacySettings.logic";

export function downloadPrivateDiagnosticsReport(report: PrivateDiagnosticsReport): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "specwithcode-diagnostics.json";
  link.click();
  URL.revokeObjectURL(url);
}

/** Consent belongs to this exact preview and is reset when its component is replaced. */
export function DiagnosticsReportPreview({
  report,
  onDownload = downloadPrivateDiagnosticsReport,
}: {
  readonly report: PrivateDiagnosticsReport;
  readonly onDownload?: (report: PrivateDiagnosticsReport) => void;
}) {
  const [reviewed, setReviewed] = useState(false);
  return (
    <div className="space-y-4 p-4 sm:p-5">
      <p className="text-sm text-muted-foreground">
        This is the entire report. It contains versions, diagnostic counts, and failure categories.
        Conversation content, raw logs, files, credentials, paths, and identifiers are excluded.
      </p>
      <pre
        data-privacy-report
        tabIndex={0}
        aria-label="Diagnostics report preview"
        className="max-h-80 overflow-auto rounded-lg border border-border/60 bg-muted/30 p-3 font-mono text-xs leading-relaxed"
      >
        {JSON.stringify(report, null, 2)}
      </pre>
      <label className="flex cursor-pointer items-start gap-2.5 text-sm">
        <Checkbox
          aria-label="I reviewed this report"
          checked={reviewed}
          onCheckedChange={(checked) => setReviewed(checked === true)}
          className="mt-0.5"
        />
        <span>I reviewed this report and want to save a copy.</span>
      </label>
      <Button
        disabled={!reviewed}
        size="sm"
        onClick={() => {
          if (reviewed) onDownload(report);
        }}
      >
        <DownloadIcon className="size-4" /> Save report
      </Button>
      <p className="text-xs text-muted-foreground">
        The file is saved on your device. Share it with support only if you choose.
      </p>
    </div>
  );
}

export function PrivacySettingsPanel() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const configuration = environment?.serverConfig;
  const observability = configuration?.observability;
  const session = useEnvironmentQuery(
    environmentId === null ? null : environmentSession.sessionStateAtom(environmentId),
  );
  const access = resolveUsageAccess({
    connectionPhase: environment?.connection.phase ?? "available",
    session: session.data,
    hasSessionError: session.error !== null,
  });
  const [requestedEnvironment, setRequestedEnvironment] = useState<EnvironmentId | null>(null);
  const [previewGeneration, setPreviewGeneration] = useState(0);
  useEffect(() => {
    setRequestedEnvironment(null);
  }, [environmentId]);
  const requested = environmentId !== null && requestedEnvironment === environmentId;
  const diagnostics = useEnvironmentQuery(
    requested && access.canReadDiagnostics
      ? serverEnvironment.traceDiagnostics({ environmentId, input: {} })
      : null,
  );
  const report =
    requested &&
    diagnostics.isSuccess &&
    !diagnostics.isPending &&
    diagnostics.data &&
    configuration
      ? buildPrivateDiagnosticsReport({
          appVersion: APP_VERSION,
          serverVersion: configuration.environment.serverVersion,
          os: configuration.environment.platform.os,
          architecture: configuration.environment.platform.arch,
          observability: configuration.observability,
          diagnostics: diagnostics.data,
        })
      : null;
  const externalConfigured =
    observability &&
    (observability.otlpTracesEnabled ||
      observability.otlpMetricsEnabled ||
      observability.otlpLogsEnabled);

  return (
    <SettingsPageContainer>
      <section data-privacy-settings aria-label="Data and privacy" className="space-y-8">
        <SettingsSection
          id="privacy-data"
          title="Your data"
          icon={<ShieldCheckIcon className="size-4" />}
        >
          <div className="space-y-3 p-4 text-sm sm:p-5">
            <p className="font-medium">You control what you share.</p>
            <p className="text-muted-foreground">
              Chat history, uploaded attachments, server settings, and diagnostic logs are stored on
              the environment you use. Provider logs and terminal output can contain conversation
              content or sensitive data.
            </p>
            <p className="text-muted-foreground">
              Drafts, preferences, and cached interface data can also remain on the device where you
              use the app, including with a remote environment. Drafts can contain prompts,
              attachment details, and selected terminal text.
            </p>
            <p className="text-muted-foreground">
              When you start an agent turn or use a connected service, the selected provider
              receives the context needed for that request under its own privacy policy.
            </p>
          </div>
        </SettingsSection>
        <SettingsSection id="privacy-collection" title="Product improvement and diagnostics">
          <div className="space-y-3 p-4 text-sm sm:p-5">
            <p className="font-medium">Product usage collection</p>
            <p className="rounded-md bg-muted/40 px-3 py-2" role="status">
              {productUsageStatusLabel(observability)}
            </p>
            <p className="text-muted-foreground">
              Collection is off by default. If enabled by the server operator, usage events include
              provider and model choices, turn results, durations, and token totals. They exclude
              prompts, responses, and file contents.
            </p>
            <p className="text-muted-foreground">
              Local diagnostic collection helps troubleshoot problems. External trace, metric, and
              log export is separate from product usage collection and can be configured by the
              server operator.
            </p>
            <p className="rounded-md bg-muted/40 px-3 py-2" role="status">
              {observability
                ? `Selected environment: local tracing ${observability.localTracingEnabled ? "on" : "off"}; external diagnostic export ${externalConfigured ? "configured" : "off"}.`
                : "Connect an environment to inspect its diagnostic export settings."}
            </p>
            <Collapsible>
              <CollapsibleTrigger render={<Button size="sm" variant="ghost" />}>
                Technical details
              </CollapsibleTrigger>
              <CollapsiblePanel className="pt-3">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  There is no built-in analytics destination. Enabling collection requires
                  STUDIO_TELEMETRY_ENABLED=true and a PostHog host and key on the server. To disable
                  it, set STUDIO_TELEMETRY_ENABLED=false and restart the server. External
                  OpenTelemetry export is configured separately. These indicators show startup
                  settings, not confirmed delivery.
                </p>
              </CollapsiblePanel>
            </Collapsible>
          </div>
        </SettingsSection>
        <SettingsSection
          id="privacy-report"
          title="Help improve SpecWithCode"
          icon={<FileSearchIcon className="size-4" />}
        >
          <div className="space-y-3 p-4 sm:p-5">
            <p className="text-sm text-muted-foreground">
              Create a report from the selected environment, review every field, then save it if you
              want to share it. Creating a report does not upload it.
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={
                environmentId === null || !access.canReadDiagnostics || diagnostics.isPending
              }
              onClick={() => {
                if (environmentId === null || !access.canReadDiagnostics || diagnostics.isPending)
                  return;
                setPreviewGeneration((generation) => generation + 1);
                if (requested) diagnostics.refresh();
                else setRequestedEnvironment(environmentId);
              }}
            >
              {diagnostics.isPending ? "Preparing report…" : "Preview diagnostic report"}
            </Button>
            {access.error ? <p className="text-sm text-muted-foreground">{access.error}</p> : null}
            {requested && diagnostics.error ? (
              <p role="alert" className="text-sm text-destructive">
                Could not prepare the report. Reconnect the environment and try again.
              </p>
            ) : null}
          </div>
          {report ? (
            <DiagnosticsReportPreview
              key={`${environmentId}:${previewGeneration}:${JSON.stringify(report)}`}
              report={report}
            />
          ) : null}
        </SettingsSection>
      </section>
    </SettingsPageContainer>
  );
}
