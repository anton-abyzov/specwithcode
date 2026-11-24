// The Claude Ship card (increment 1458) over fixture facts. Query:
//   ?case=fork|new|outdated|steward   ?theme=light|dark
import { createRoot } from "react-dom/client";
import { ClaudeShipDialog } from "../../src/components/chat/ClaudeShipDialog";
import { claudeShipPlan, parseClaudeShipCommand } from "../../src/components/chat/claudeShip.logic";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const kind = params.get("case") ?? "fork";
const base = {
  cliVersion: "2.1.331",
  interactionMode: "default",
  runtimeMode: "auto" as const,
  platform: "darwin",
  sessionId: "0f6c8a5e-1111-4222-8333-444455556666",
};
const plan = claudeShipPlan(
  kind === "new"
    ? { ...base, sessionId: null, runtimeMode: "full-access" }
    : kind === "outdated"
      ? { ...base, cliVersion: "2.1.302" }
      : base,
);
const line = parseClaudeShipCommand(kind === "steward" ? "/steward 41 +my-lint-bot" : "/ship")!;
createRoot(document.getElementById("root")!).render(
  <ClaudeShipDialog
    open
    onOpenChange={() => {}}
    line={line}
    plan={plan}
    opening={false}
    error={null}
    onOpenTerminal={() => {}}
    onSendAnyway={() => {}}
  />,
);
