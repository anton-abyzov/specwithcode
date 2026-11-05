import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import { usesChatGptSharing } from "@specweave-studio/shared/usageLimits";
import type { ServerProvider } from "@specweave-studio/contracts";
import { OpenAI } from "../Icons";
import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";

export function ChatGptSharingControl({ provider }: { provider: ServerProvider | null }) {
  const tx = useTx();
  if (!usesChatGptSharing(provider)) return null;
  return (
    <div className="flex items-center justify-between gap-4 border-t px-3 py-2">
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        {renderRich(tx("{openAI}Using ChatGPT plan"), {
          openAI: <OpenAI className="size-3.5" aria-hidden="true" />,
        })}
      </span>
      <ChatGptUsageButton size="xs" />
    </div>
  );
}
