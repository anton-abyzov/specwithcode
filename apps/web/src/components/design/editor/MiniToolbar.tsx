import type { DesignNode, DesignPaint, DesignSystem } from "@specweave-studio/contracts";
import { MessageCircleIcon, SendIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { PaintField } from "./PropertiesPanel";

/** Fill, comment and "Ask agent" for the selection, floating above it. */
export function MiniToolbar({
  nodes,
  system,
  mode,
  canEdit,
  canComment,
  canAskAgent,
  onFill,
  onComment,
  onAskAgent,
}: {
  nodes: readonly DesignNode[];
  system: DesignSystem | null;
  mode: string;
  canEdit: boolean;
  canComment: boolean;
  /** Asking the agent changes the design, so it needs edit access. */
  canAskAgent: boolean;
  onFill: (fill: DesignPaint | null) => void;
  onComment: () => void;
  onAskAgent: (request: string) => Promise<void>;
}) {
  const [askOpen, setAskOpen] = useState(false);
  const [request, setRequest] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fillable =
    nodes.length > 0 &&
    nodes.every(
      (node) =>
        node.type === "frame" ||
        node.type === "rect" ||
        node.type === "ellipse" ||
        node.type === "path",
    );
  const send = async () => {
    setSending(true);
    setError(null);
    try {
      await onAskAgent(request);
      setRequest("");
      setAskOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };
  return (
    <div
      role="toolbar"
      aria-label="Selection"
      data-testid="mini-toolbar"
      className="flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 text-popover-foreground shadow-md"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {fillable && canEdit && (
        <PaintField
          compact
          label="Fill"
          value={(nodes[0] as { fill?: DesignPaint }).fill}
          system={system}
          mode={mode}
          onChange={onFill}
        />
      )}
      {canComment && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Comment on selection"
          onClick={onComment}
        >
          <MessageCircleIcon />
        </Button>
      )}
      {canAskAgent && (
        <Popover open={askOpen} onOpenChange={setAskOpen}>
          <PopoverTrigger
            render={<Button variant="ghost" size="xs" aria-label="Ask agent about selection" />}
          >
            <SparklesIcon />
            Ask agent
          </PopoverTrigger>
          <PopoverPopup side="bottom" align="start" className="w-80">
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <Textarea
                size="sm"
                autoFocus
                aria-label="Request for the agent"
                placeholder="What should the agent do with this? (optional)"
                value={request}
                onChange={(event) => setRequest(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                Sends the {nodes.length === 1 ? "layer" : `${nodes.length} layers`}, their ids and a
                PNG of the frame to the design's thread.
              </p>
              {error !== null && <p className="text-xs text-destructive-foreground">{error}</p>}
              <Button type="submit" size="sm" disabled={sending} className="self-end">
                {sending ? <Spinner /> : <SendIcon />}
                Send
              </Button>
            </form>
          </PopoverPopup>
        </Popover>
      )}
    </div>
  );
}
