import { createRoot } from "react-dom/client";
import { EnvironmentId } from "@specweave-studio/contracts";
import { AddProviderInstanceDialog } from "../../src/components/settings/AddProviderInstanceDialog";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

createRoot(document.getElementById("root")!).render(
  <AddProviderInstanceDialog
    open
    environmentId={EnvironmentId.make("fixture-machine")}
    environmentLabel="this Mac"
    onOpenChange={() => {}}
  />,
);
