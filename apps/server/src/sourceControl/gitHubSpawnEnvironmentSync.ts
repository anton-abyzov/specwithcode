/**
 * Keeps the GitHub token that SpecWithCode's processes get in step with
 * Settings: the github.com token saved or copied there, while that host is on.
 * That is the credential GitHubCredentials chooses first, so with it gone (or the
 * host turned off) processes get nothing extra and gh's own login applies.
 */
import { REDACTED_SECRET_MARKER, type GitHubSettings } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import { GITHUB_HOST } from "./gitHubCredentialState.ts";
import { setGitHubSpawnToken } from "./gitHubSpawnEnvironment.ts";

/**
 * The saved or copied github.com token when it is the chosen credential, null when
 * there is none, or "unreadable" when the secret store could not be read and the
 * settings carry only the redaction marker.
 */
export function chosenSavedGitHubToken(github: GitHubSettings): string | null | "unreadable" {
  if (github.hosts[GITHUB_HOST]?.enabled === false) return null;
  const token = github.tokens[GITHUB_HOST]?.trim();
  if (!token) return null;
  return token === REDACTED_SECRET_MARKER ? "unreadable" : token;
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    // An unreadable token keeps the last good one rather than handing out the marker.
    const apply = (github: GitHubSettings) =>
      Effect.sync(() => {
        const chosen = chosenSavedGitHubToken(github);
        if (chosen !== "unreadable") setGitHubSpawnToken(chosen);
        return chosen !== "unreadable";
      });
    const changes = yield* settings.subscribeChanges;
    // The first read decides what the first spawn sees, so it is retried, not skipped.
    yield* settings.getSettings.pipe(
      Effect.flatMap((current) => apply(current.github)),
      Effect.flatMap((applied) => (applied ? Effect.void : Effect.fail("unreadable" as const))),
      Effect.retry({ times: 5, schedule: Schedule.exponential("200 millis") }),
      Effect.catchCause(() => Effect.void),
    );
    yield* Stream.runForEach(changes, (current) => apply(current.github)).pipe(Effect.forkScoped);
    yield* Effect.addFinalizer(() => Effect.sync(() => setGitHubSpawnToken(null)));
  }),
);
