/**
 * Where the first feature guide is offered (1398 AC-11, AC-12, AC-20): one
 * card on the Overview page, "Build a first feature", until a guide on this
 * machine has finished or the card is dismissed, and "First feature guide" in
 * the command palette, which can always make a new sample. Never a stage of
 * first-run setup.
 *
 * The card and the palette read the machine's own server: no offer without
 * its `firstFeatureSample`, and `sample` is never sent to a server without it.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@specweave-studio/client-runtime/environment";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useCallback, useMemo, useState } from "react";

import { txNow } from "../../../i18n";
import { useLocalStorage } from "../../../hooks/useLocalStorage";
import { useClientSettings } from "../../../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../../../logicalProject";
import { useProjects, waitForProject } from "../../../state/entities";
import { usePrimaryEnvironmentId } from "../../../state/environments";
import { projectEnvironment } from "../../../state/projects";
import { primaryServerConfigAtom, primaryServerProvidersAtom } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { providerCanRunWork } from "../whatYouCanDo.logic";
import { useFirstFeatureFinishedHere } from "./FirstFeatureGuide";
import {
  SAMPLE_REVIEW_WARNING_TITLE,
  activeFirstFeatureSample,
  firstFeatureOffer,
} from "./firstFeature.logic";
import { FirstFeatureOfferCard } from "./FirstFeatureOfferCard";

/** The name the server needs; it names the sample itself ("First feature", numbered when taken). */
const SAMPLE_NAME = "First feature";

/** What the palette and the card share: this machine's sample state and the press. */
export function useFirstFeatureStart() {
  const navigate = useNavigate();
  const clientSettings = useClientSettings();
  const config = useAtomValue(primaryServerConfigAtom);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const environmentId = usePrimaryEnvironmentId();
  const allProjects = useProjects();
  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const createNew = useAtomCommand(projectEnvironment.createNew, { reportFailure: false });
  const [starting, setStarting] = useState(false);

  const openProject = useCallback(
    (project: EnvironmentProject) =>
      void navigate({
        to: "/projects/$projectKey",
        params: {
          projectKey: deriveLogicalProjectKeyFromSettings(
            project,
            selectProjectGroupingSettings(clientSettings),
          ),
        },
      }),
    [clientSettings, navigate],
  );

  const start = useCallback(async () => {
    if (environmentId === null || config?.firstFeatureSample !== true) return;
    const active = activeFirstFeatureSample(projects);
    if (active !== undefined) {
      openProject(active);
      return;
    }
    if (!providers.some(providerCanRunWork)) {
      void navigate({ to: "/settings/providers" });
      return;
    }
    setStarting(true);
    try {
      const result = await createNew({
        environmentId,
        input: { name: SAMPLE_NAME, sample: "first-feature" },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: txNow("Could not make the sample project"),
              description:
                failure instanceof Error && failure.message.trim() !== ""
                  ? failure.message
                  : txNow("Try again."),
            }),
          );
        }
        return;
      }
      const { projectId, commitError, sampleAutoReviewError } = result.value;
      if (commitError !== undefined)
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: txNow("The sample project has no first commit"),
            description: commitError,
          }),
        );
      // Said, never hidden: a review may start by itself beside the one the request asks for.
      if (sampleAutoReviewError !== undefined)
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            timeout: 0,
            title: txNow(SAMPLE_REVIEW_WARNING_TITLE),
            description: sampleAutoReviewError,
          }),
        );
      const project = await waitForProject(scopeProjectRef(environmentId, projectId)).catch(
        () => null,
      );
      if (project === null) {
        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: txNow("The sample project is ready"),
            description: txNow("It appears in the sidebar once this window catches up."),
          }),
        );
        return;
      }
      openProject(project);
    } finally {
      setStarting(false);
    }
  }, [
    config?.firstFeatureSample,
    createNew,
    environmentId,
    navigate,
    openProject,
    projects,
    providers,
  ]);

  return {
    supported: config?.firstFeatureSample === true,
    finishedOnServer: config?.firstFeatureFinished === true,
    agentReady: providers.some(providerCanRunWork),
    environmentId,
    projects,
    starting,
    start,
  };
}

const DismissedSchema = Schema.Boolean;

/** The Overview card. Hidden until the machine's server and providers are known. */
export function FirstFeatureOffer() {
  const sample = useFirstFeatureStart();
  const [dismissed, setDismissed] = useLocalStorage(
    `swc:first-feature-offer-dismissed:${sample.environmentId ?? "none"}`,
    false,
    DismissedSchema,
  );
  const [finishedHere] = useFirstFeatureFinishedHere(sample.environmentId);
  const offer = firstFeatureOffer({
    supported: sample.supported,
    // The server fact is read when the config loads; windows sharing this origin's storage learn
    // a finish at once through finishedHere. A window on another origin or browser profile keeps
    // its loaded config and can offer the card again until it reloads; pressing it makes a new sample.
    finishedBefore: sample.finishedOnServer || finishedHere,
    dismissed,
    agentReady: sample.agentReady,
    projects: sample.projects,
  });
  return (
    <FirstFeatureOfferCard
      offer={offer}
      starting={sample.starting}
      onStart={() => void sample.start()}
      onDismiss={() => setDismissed(true)}
    />
  );
}
