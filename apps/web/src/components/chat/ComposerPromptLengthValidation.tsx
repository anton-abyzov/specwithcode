import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@specweave-studio/contracts";

import { CharacterCount } from "../ui/character-count";
import { getComposerPromptInputLength } from "./composerSubmission";

// The count stays out of the way until a prompt gets close to the limit.
const PROMPT_COUNT_THRESHOLD = 0.8;

export function ComposerPromptLengthValidation({
  message,
  prompt = "",
}: {
  message: string | null;
  /** The draft, so a count can show once it nears the send limit. */
  prompt?: string;
}) {
  if (!message) {
    // Measured the way the send check measures, so the two never disagree.
    const count = getComposerPromptInputLength(prompt);
    if (count < PROVIDER_SEND_TURN_MAX_INPUT_CHARS * PROMPT_COUNT_THRESHOLD) return null;
    return (
      <div className="px-3 pb-2 sm:px-4">
        <CharacterCount count={count} max={PROVIDER_SEND_TURN_MAX_INPUT_CHARS} />
      </div>
    );
  }

  return (
    <p
      role="alert"
      className="px-3 pb-2 text-xs text-destructive sm:px-4"
      data-chat-composer-validation="prompt-length"
    >
      {message}
    </p>
  );
}
