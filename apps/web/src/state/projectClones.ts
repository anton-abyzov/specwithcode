import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useState } from "react";
import {
  parseScopedProjectKey,
  scopedProjectKey,
} from "@specweave-studio/client-runtime/environment";
import type {
  EnvironmentId,
  ProjectCloneSnapshot,
  ScopedProjectRef,
} from "@specweave-studio/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { withPendingMachineAdds } from "../sidebarProjectGrouping";
import { listAddToMachineJobs, type AddToMachineJob } from "../studio/addToMachine";
import { ADD_TO_MACHINE_JOBS_EVENT } from "../studio/addToMachineCopy";
import type { Project } from "../types";
import { environmentServerConfigsAtom } from "./server";
import { sourceControlEnvironment } from "./sourceControl";

const EMPTY_CLONES: ReadonlyArray<ProjectCloneSnapshot> = [];
const EMPTY_CLONE_ATOM = Atom.make<ProjectCloneSnapshot | null>(null).pipe(
  Atom.withLabel("web-project-clone:empty"),
);

/**
 * Latest clone list an environment has streamed; empty until the subscription
 * delivers, and never subscribed on servers that predate clone tracking.
 */
export const environmentProjectClonesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<ProjectCloneSnapshot> => {
    const supported =
      get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
        .projectCloneTracking === true;
    if (!supported) return EMPTY_CLONES;
    const result = get(sourceControlEnvironment.projectClones({ environmentId, input: {} }));
    return Option.getOrElse(AsyncResult.value(result), () => EMPTY_CLONES);
  }).pipe(Atom.withLabel(`web-project-clones:${environmentId}`)),
);

const projectCloneAtom = Atom.family((key: string) => {
  const ref = parseScopedProjectKey(key);
  return Atom.make((get): ProjectCloneSnapshot | null => {
    if (ref === null) return null;
    const clones = get(environmentProjectClonesAtom(ref.environmentId));
    return clones.find((clone) => clone.projectId === ref.projectId) ?? null;
  }).pipe(Atom.withLabel(`web-project-clone:${key}`));
});

/**
 * The tracked clone for a project, or null once it finished (or never
 * existed). Subscribing here opens the environment's clone stream, which is
 * cheap: the server sends an empty list and stays quiet until a clone starts.
 */
export function useProjectClone(ref: ScopedProjectRef | null): ProjectCloneSnapshot | null {
  return useAtomValue(ref === null ? EMPTY_CLONE_ATOM : projectCloneAtom(scopedProjectKey(ref)));
}

export function useEnvironmentProjectClones(
  environmentId: EnvironmentId,
): ReadonlyArray<ProjectCloneSnapshot> {
  return useAtomValue(environmentProjectClonesAtom(environmentId));
}

/** Every tracked clone on every connected environment that tracks clones. */
const allProjectClonesAtom = Atom.make(
  (get): ReadonlyArray<{ environmentId: EnvironmentId; clone: ProjectCloneSnapshot }> =>
    [...get(environmentServerConfigsAtom).keys()].flatMap((environmentId) =>
      get(environmentProjectClonesAtom(environmentId)).map((clone) => ({ environmentId, clone })),
    ),
).pipe(Atom.withLabel("web-project-clones:all"));

/** Run on > Add to another machine jobs stored in this browser, kept current. */
function useAddToMachineJobs(): ReadonlyArray<AddToMachineJob> {
  const [jobs, setJobs] = useState(listAddToMachineJobs);
  useEffect(() => {
    const refresh = () => setJobs(listAddToMachineJobs());
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.includes("add-to-machine")) refresh();
    };
    refresh();
    window.addEventListener("storage", onStorage);
    window.addEventListener(ADD_TO_MACHINE_JOBS_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(ADD_TO_MACHINE_JOBS_EVENT, refresh);
    };
  }, []);
  return jobs;
}

/**
 * The sidebar's projects, with a project Run on is still cloning onto another
 * machine listed under the project it comes from (see `withPendingMachineAdds`).
 */
export function useSidebarProjects<TProject extends Project>(
  projects: ReadonlyArray<TProject>,
): ReadonlyArray<TProject> {
  const clones = useAtomValue(allProjectClonesAtom);
  const jobs = useAddToMachineJobs();
  const adds = useMemo(
    () =>
      jobs.filter((job) =>
        clones.some(
          ({ environmentId, clone }) =>
            environmentId === job.destination.environmentId &&
            clone.projectId === job.destination.projectId &&
            (clone.phase === "running" || clone.phase === "done"),
        ),
      ),
    [jobs, clones],
  );
  return useMemo(() => withPendingMachineAdds(projects, adds), [projects, adds]);
}
