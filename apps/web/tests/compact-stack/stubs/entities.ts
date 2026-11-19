// Everything else comes from the real module, so new exports never break the
// fixture; only the queue's two thread hooks read fictional data.
export * from "../../../src/state/entities";

const projection = { projection: { messages: [] } };
export const useThreadProjection = () => projection;
export const useThreadShell = () => ({ title: "Onboarding rethink" });
