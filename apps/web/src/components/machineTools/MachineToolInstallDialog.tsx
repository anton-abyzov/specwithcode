/**
 * Installs one missing machine basic where its absence was found: a SpecWeave
 * setup that had no Node.js, a new project on a machine with no Git. The same
 * row as first-run setup's Machine basics, with its button and its log.
 */
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import { useTx } from "../../i18n";
import { renderRich } from "../../i18n/rich";
import { serverEnvironment } from "../../state/server";
import { MachineToolRow } from "../onboarding/MachineBasics";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  closeMachineToolInstall,
  type MachineToolInstallRequest,
  useMachineToolInstallRequest,
} from "./machineToolInstallRequest";
import { MACHINE_TOOL_NAMES, useMachineTools } from "./machineToolsUi";

export function MachineToolInstallDialogHost() {
  const request = useMachineToolInstallRequest((state) => state.request);
  if (request === null) return null;
  return (
    <MachineToolInstallDialog
      key={`${request.environmentId}:${request.tool}`}
      request={request}
      onClose={closeMachineToolInstall}
    />
  );
}

function MachineToolInstallDialog({
  request,
  onClose,
}: {
  readonly request: MachineToolInstallRequest;
  readonly onClose: () => void;
}) {
  const tx = useTx();
  const { environmentId, tool, machineLabel } = request;
  const os = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment.platform
    .os;
  const { state, install, refresh, start } = useMachineTools(environmentId);
  // The row stays as Ready once the tool appears, instead of vanishing.
  const [wasMissing, setWasMissing] = useState(false);
  const check = state.kind === "ready" ? state.check : null;
  if (check?.[tool] === "missing" && !wasMissing) setWasMissing(true);
  const name = MACHINE_TOOL_NAMES[tool];
  const running = install.tool === tool && install.status === "running";

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="sm:max-w-lg" data-testid="machine-tool-install">
        <DialogHeader>
          <DialogTitle>
            {machineLabel
              ? renderRich(tx("Install {tool} on {machine}"), { tool: name, machine: machineLabel })
              : tx("Install {tool}", { tool: name })}
          </DialogTitle>
          <DialogDescription>
            {tool === "node"
              ? tx("SpecWeave runs on Node.js. Once it is installed, set SpecWeave up again.")
              : tool === "git"
                ? tx("A new project is a Git repository. Once Git is installed, create it again.")
                : tx("Publishing to GitHub uses the GitHub CLI.")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {state.kind === "unavailable" ? (
            <p className="text-sm text-muted-foreground">
              {tx(
                "This machine runs an older SpecWithCode that cannot install it. Update SpecWithCode there, or install it yourself.",
              )}
            </p>
          ) : check === null ? (
            <p className="text-sm text-muted-foreground">{tx("Checking…")}</p>
          ) : check[tool] === "present" && !wasMissing ? (
            <p className="text-sm text-muted-foreground">
              {tx("{tool} is already on this machine.", { tool: name })}
            </p>
          ) : (
            <MachineToolRow
              tool={tool}
              check={check}
              os={os}
              install={install}
              wasMissing={wasMissing}
              readOnly={false}
              onInstall={() => start(tool)}
              onCheckAgain={() => void refresh()}
            />
          )}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {running ? tx("Hide") : tx("Done")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
