import { DesignError } from "@specweave-studio/contracts";

import deck from "../deck.json";
import { fixture } from "./fixture";

/* The deck preview read: the slides the server's parser made of the fixture deck. */
export function useEnvironmentQuery(atom: { previewDeck: string } | null) {
  const idle = { data: null, error: null, failure: null, isPending: false, refresh: () => {} };
  if (atom === null) return idle;
  if (fixture.deck === "corrupt") {
    const failure = new DesignError({
      code: "invalid",
      detail: "The file could not be read as a PowerPoint deck (.pptx).",
    });
    return { ...idle, error: failure.message, failure };
  }
  return { ...idle, data: deck };
}
