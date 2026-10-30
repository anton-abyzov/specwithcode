import { createRoot } from "react-dom/client";
import { ProviderUpdatesAction } from "../../src/components/ProviderUpdatesAction";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

createRoot(document.getElementById("root")!).render(
  <ProviderUpdatesAction
    open
    onOpenChange={() => {}}
    target={{ environmentId: "ministorm", instanceId: "codex", driver: "codex" } as never}
  />,
);
