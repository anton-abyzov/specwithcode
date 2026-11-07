import { StarIcon, XIcon } from "lucide-react";
import { useTx } from "../../i18n";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";

export const SPECWITHCODE_REPO_URL = "https://github.com/anton-abyzov/specwithcode";

function openRepository() {
  void ensureLocalApi().shell.openExternal(SPECWITHCODE_REPO_URL);
}

/** Settings > About: always shown. */
export function StarOnGitHubButton() {
  const tx = useTx();
  return (
    <Button size="sm" variant="outline" onClick={openRepository}>
      <StarIcon className="size-3.5" aria-hidden="true" />
      {tx("Star on GitHub")}
    </Button>
  );
}

/** First-run screen: a quiet link the person can dismiss for good. */
export function StarOnGitHubLink() {
  const tx = useTx();
  const dismissed = useClientSettings((settings) => settings.starOnGitHubDismissed);
  const updateClientSettings = useUpdateClientSettings();
  if (dismissed) return null;
  return (
    <span className="inline-flex items-center gap-0.5">
      <Button size="sm" variant="ghost-muted" onClick={openRepository}>
        <StarIcon className="size-3.5" aria-hidden="true" />
        {tx("Star on GitHub")}
      </Button>
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label={tx("Hide the GitHub star link")}
        onClick={() => void updateClientSettings({ starOnGitHubDismissed: true })}
      >
        <XIcon className="size-3" aria-hidden="true" />
      </Button>
    </span>
  );
}
