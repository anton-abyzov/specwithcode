import { fixture } from "./fixture";

export function useFileContextMenu() {
  return {
    capabilities: { canOpenDefault: true, revealLabel: "Show in Finder", editorIds: [] },
    activate: async (action: string, target: { filePath: string }) => {
      fixture.actions.push({ action, filePath: target.filePath });
    },
  };
}
