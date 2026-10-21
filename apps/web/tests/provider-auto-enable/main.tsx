import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@specweave-studio/contracts";
import { ProviderInstanceCard } from "../../src/components/settings/ProviderInstanceCard";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "editor" ? "editor" : "list";
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
document.body.classList.add("bg-background");

function Fixture() {
  const [instance, setInstance] = useState<ProviderInstanceConfig>({
    driver: ProviderDriverKind.make("grok"),
    enabled: true,
  });
  const [selected, setSelected] = useState(0);
  return (
    <main className="mx-auto min-h-screen max-w-2xl space-y-4 bg-background p-4 text-foreground sm:p-8">
      <p className="text-xs text-muted-foreground">Isolated UI fixture · no provider probes</p>
      <div className="rounded-lg border">
        <ProviderInstanceCard
          instanceId={ProviderInstanceId.make("grok")}
          instance={instance}
          driverOption={undefined}
          liveProvider={undefined}
          mode={mode}
          autoEnabled
          onSelect={() => setSelected((count) => count + 1)}
          onUpdate={setInstance}
          hiddenModels={[]}
          favoriteModels={[]}
          modelOrder={[]}
          onHiddenModelsChange={() => undefined}
          onFavoriteModelsChange={() => undefined}
          onModelOrderChange={() => undefined}
        />
      </div>
      <p data-testid="state">
        enabled={String(instance.enabled)} selected={selected}
      </p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
