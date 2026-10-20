import { createRoot } from "react-dom/client";
import { ProvisionMachineButton } from "../../src/components/settings/ProvisionMachineSheet";
import "./fixture.css";
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-background p-8 text-foreground">
    <h1>Your private machines</h1>
    <p>Ministorm · Online</p>
    <ProvisionMachineButton environmentId={"ministorm" as never} environmentLabel="Ministorm" />
  </main>,
);
