/** The star card itself (1489): one calm question, three answers, nothing in return. */
import { StarIcon, XIcon } from "lucide-react";

import { useTx } from "../../i18n";
import { Button } from "../ui/button";

export function GitHubStarPromptCard(props: {
  onStar: () => void;
  onAlreadyStarred: () => void;
  onNotNow: () => void;
}) {
  const tx = useTx();
  return (
    <section
      role="dialog"
      aria-label={tx("Star SpecWithCode on GitHub")}
      data-testid="github-star-prompt"
      className="fixed right-4 bottom-4 z-50 flex w-[25rem] max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-xl border border-border bg-popover p-4 text-sm shadow-lg"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">{tx("Enjoying SpecWithCode?")}</p>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          aria-label={tx("Close")}
          onClick={props.onNotNow}
        >
          <XIcon className="size-3" aria-hidden="true" />
        </Button>
      </div>
      <p className="text-muted-foreground">
        {tx("A star on GitHub helps other developers find it.")}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" size="sm" variant="outline" onClick={props.onNotNow}>
          {tx("Not now")}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={props.onAlreadyStarred}>
          {tx("Already starred")}
        </Button>
        <Button type="button" size="sm" onClick={props.onStar}>
          <StarIcon className="size-3.5" aria-hidden="true" />
          {tx("Star on GitHub")}
        </Button>
      </div>
    </section>
  );
}
