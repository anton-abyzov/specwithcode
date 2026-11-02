import { createRoot } from "react-dom/client";
import { WhatYouCanDoCard } from "../../src/components/studio/WhatYouCanDo";
import { whatYouCanDoItems } from "../../src/components/studio/whatYouCanDo.logic";
import "./fixture.css";

document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark",
);
createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
    <div className="mx-auto max-w-4xl">
      <WhatYouCanDoCard
        items={whatYouCanDoItems({
          agentReady: true,
          hasProject: true,
          hasSession: false,
          hasRoutine: false,
          hasOtherMachine: false,
        })}
        onDismiss={() => undefined}
        onNewSession={() => undefined}
      />
    </div>
  </main>,
);
