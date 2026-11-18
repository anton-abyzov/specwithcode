/**
 * Model tracks: the three ordered model lists a person ranks. Daily is
 * routine work, Complex is the hardest work, Review is the model that checks
 * finished work. Daily and Complex are stored as the `routine` and `complex`
 * model lanes and Review as the adversarial review's `reviewers`, so a saved
 * list replaces the built-in order below and nothing is stored for a person
 * who never edits one.
 *
 * @module modelTracks
 */

export const MODEL_TRACKS = ["daily", "complex", "review"] as const;
export type ModelTrack = (typeof MODEL_TRACKS)[number];

export const MODEL_TRACK_LABELS: Record<ModelTrack, string> = {
  daily: "Daily",
  complex: "Complex",
  review: "Review",
};

/** One built-in track entry: a model by name, served by whichever provider lists it. */
export interface DefaultTrackModel {
  /** The model as its maker spells it; other providers' spellings match by identity. */
  readonly model: string;
  /** Shown while no provider here lists the model; a provider's own name wins. */
  readonly name: string;
  /**
   * Runs on a free account. Free entries close the Daily track and are never
   * used for Complex or Review work.
   */
  readonly free?: true;
  /** The reasoning effort the entry starts at, matched to the nearest level the model offers. */
  readonly effort?: string;
}

/**
 * The built-in order of each track. An entry runs on the release of its
 * family a source lists (GPT-6.1 Sol where nothing lists GPT-6.2 Sol yet),
 * the named one first, else the newest; an entry no enabled provider lists in
 * any release is skipped, so the defaults fit whatever a machine has signed in.
 */
export const DEFAULT_MODEL_TRACKS: Readonly<Record<ModelTrack, ReadonlyArray<DefaultTrackModel>>> =
  {
    daily: [
      { model: "claude-opus-5-5", name: "Claude Opus 5.5" },
      { model: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
      { model: "gpt-6.2-sol", name: "GPT-6.2 Sol" },
      { model: "gpt-6-luna", name: "GPT-6 Luna", free: true },
    ],
    complex: [
      { model: "claude-fable-5-2", name: "Claude Fable 5.2" },
      { model: "gpt-6.2-astra", name: "GPT-6.2 Astra" },
    ],
    review: [
      { model: "muse-wonder-full-1.0", name: "Muse Wonder Full 1.0", effort: "xhigh" },
      { model: "muse-wonder-1.0", name: "Muse Wonder 1.0", effort: "xhigh" },
      { model: "gpt-6.2-sol", name: "GPT-6.2 Sol" },
      { model: "gemini-4-carbon", name: "Gemini 4 Carbon" },
    ],
  };
