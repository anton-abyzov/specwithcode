/* Settings > Routines list across two machines (`?single` for one machine). */
import { PlusIcon } from "lucide-react";
import { createRoot } from "react-dom/client";
import { RoutineList } from "../../src/components/settings/RoutineList";
import { SettingsSection } from "../../src/components/settings/settingsLayout";
import { Button } from "../../src/components/ui/button";
import { fixtureEnvironments } from "./mocks";

const single = new URLSearchParams(location.search).has("single");
document.body.classList.add("bg-background", "text-foreground");
createRoot(document.getElementById("root")!).render(
  <main style={{ maxWidth: 960, margin: "24px auto", padding: 16 }}>
    <SettingsSection
      title="Routines"
      variant="plain"
      headerAction={
        <Button size="xs" variant="ghost-muted">
          <PlusIcon className="size-3" />
          New routine
        </Button>
      }
    >
      <RoutineList
        environments={(single ? fixtureEnvironments.slice(0, 1) : fixtureEnvironments) as never}
        linkedEnvironmentId={undefined}
        taskId={undefined}
        onEdit={(_environmentId, task) => {
          document.body.dataset.edited = task.id;
        }}
      />
    </SettingsSection>
  </main>,
);
