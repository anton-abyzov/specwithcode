// The header's other controls, with the markup and size of their real triggers in the
// October 26 screenshot: 21 subagents, 8 artifacts and the Concise response style.
import { BotIcon, MessageSquareTextIcon, RouteIcon, ShapesIcon } from "lucide-react";

export function SubagentsChip() {
  return (
    <button type="button" className="sws-chip sws-subagents-chip" aria-label="21 subagents">
      <BotIcon aria-hidden />
      21
    </button>
  );
}
export function ThreadArtifactsMenu() {
  return (
    <button
      type="button"
      className="sws-icon-button"
      aria-label="8 artifacts"
      style={{ width: "auto", paddingInline: 6, gap: 4 }}
    >
      <ShapesIcon aria-hidden />8
    </button>
  );
}
export function TimelineDetailMenu() {
  return (
    <button
      type="button"
      className="sws-icon-button"
      aria-label="Response style: Concise"
      style={{ width: "auto", paddingInline: 6, gap: 4 }}
    >
      <MessageSquareTextIcon aria-hidden />
      Concise
    </button>
  );
}
/** RoutingDecisionChip's trigger as it renders for a lane decision, in `?scenario=busy`. */
export function RoutingDecisionChip() {
  if (new URLSearchParams(location.search).get("scenario") !== "busy") return null;
  return (
    <button
      type="button"
      className="sws-chip sws-routing-chip"
      aria-label="Routing decision: Complex, Claude Code · Opus 5.5"
    >
      <RouteIcon aria-hidden />
      Lanes · Complex
    </button>
  );
}
export function HandoffThreadHeaderBadge() {
  return null;
}
