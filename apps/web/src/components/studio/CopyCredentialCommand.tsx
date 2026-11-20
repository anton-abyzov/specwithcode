import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useTx } from "../../i18n";
import { Button } from "../ui/button";

/** One command of the credentials list: shown whole, wrapped, with a copy button. */
export function CopyCredentialCommand({
  label,
  command,
}: {
  readonly label: string;
  readonly command: string;
}) {
  const tx = useTx();
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1" data-slot="copy-credential-command">
      {/* Label and command are separate plain text: neither is built from the other. */}
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2">
        {/* Wrapped, never clipped: a command cut off at the edge is not one a person can check. */}
        <code className="min-w-0 flex-1 font-mono text-xs break-all whitespace-pre-wrap">
          {command}
        </code>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={copied ? tx("Copied") : tx("Copy command")}
          onClick={() =>
            void writeTextToClipboard(command).then(
              () => setCopied(true),
              () => {},
            )
          }
        >
          {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
        </Button>
      </div>
    </div>
  );
}
