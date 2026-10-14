import { createRoot } from "react-dom/client";
import { useState } from "react";
import {
  ProviderDriverKind,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@specweave-studio/contracts";
import { TraitsPicker } from "../../src/components/chat/TraitsPicker";
const models: ServerProviderModel[] = [
  {
    slug: "model",
    name: "Model",
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "agent",
          label: "Agent mode",
          type: "select",
          currentValue: "agent",
          options: [
            { id: "agent", label: "Agent" },
            { id: "plan", label: "Plan" },
          ],
        },
        {
          id: "effort",
          label: "Reasoning effort",
          type: "select",
          currentValue: "medium",
          options: [
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
        },
        { id: "allowAll", label: "Allow All", type: "boolean", currentValue: false },
      ],
    },
  },
];
function App() {
  const [options, setOptions] = useState<ReadonlyArray<ProviderOptionSelection> | undefined>([
    { id: "allowAll", value: false },
  ]);
  return (
    <main style={{ padding: 80 }}>
      <h1>Provider traits — cached Allow All Off</h1>
      <TraitsPicker
        provider={ProviderDriverKind.make("acp")}
        model="model"
        models={models}
        prompt=""
        onPromptChange={() => {}}
        modelOptions={options}
        onModelOptionsChange={setOptions}
        planModeEnabled={true}
      />
      <pre data-testid="options">{JSON.stringify(options)}</pre>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
