import { getElementContext } from "react-grab/primitives";

/**
 * Runs in the preview page's own JavaScript world. React's fibers hang off DOM
 * nodes as properties the page set, which the isolated picker preload cannot
 * see. The preload hands this function's source to
 * `contextBridge.executeInMainWorld`, so the build inlines its imports into the
 * body (`pageWorldFunction` in vite.config.ts). Everything it returns is
 * page-controlled data; `PageWorldBridge.ts` checks each field.
 */
export function installPageWorld() {
  return {
    elementContext: async (element: Element) => {
      const context = await getElementContext(element);
      return {
        selector: context.selector,
        htmlPreview: context.htmlPreview,
        componentName: context.componentName,
        styles: context.styles,
        // Fibers cannot cross back to the preload, so only plain fields go.
        stack: context.stack?.map((frame) => ({
          functionName: frame.functionName,
          fileName: frame.fileName,
          lineNumber: frame.lineNumber,
          columnNumber: frame.columnNumber,
        })),
      };
    },
  };
}
