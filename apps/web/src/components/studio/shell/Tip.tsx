import type { ReactElement, ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

/** The hover and focus label of a control whose face is only an icon or a clipped name. */
export function Tip(props: {
  label: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactElement<Record<string, unknown>>;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipPopup side={props.side ?? "bottom"}>{props.label}</TooltipPopup>
    </Tooltip>
  );
}
