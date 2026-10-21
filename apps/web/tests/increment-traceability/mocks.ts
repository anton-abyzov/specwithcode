// Stand-ins for the RPC and atom layers; the fixture page supplies the data on window.
const fixture = () => (window as any).fixture;
const STATUSES = ["completed", "active", "planned", "abandoned"];
const all = Array.from({ length: 3000 }, (_, index) => {
  const number = String(index + 1).padStart(4, "0");
  return {
    incrementId: `${number}-feature-${index + 1}`,
    title: index === 2961 ? "AC traceability" : `Feature ${index + 1}`,
    status: index > 2955 ? "active" : STATUSES[index % 7 === 0 ? 2 : index % 11 === 0 ? 3 : 0],
  };
});
export const projectWorkspace = {
  incrementsList: (value: any) => value,
  threadIncrementLink: async () => ({ _tag: "Success", value: null }),
};
export const useEnvironmentQuery = (value: any) => {
  const { query, status, limit } = value.input;
  const matching = all.filter(
    (item) =>
      (!query || `${item.incrementId} ${item.title}`.toLowerCase().includes(query.toLowerCase())) &&
      (!status || item.status === status),
  );
  const statusCounts: Record<string, number> = {};
  for (const item of all) statusCounts[item.status] = (statusCounts[item.status] ?? 0) + 1;
  return {
    error: null,
    isPending: false,
    data: {
      link: { type: "auto" },
      increments: matching.toReversed().slice(0, limit ?? 300),
      total: matching.length,
      statusCounts,
    },
  };
};
export const useAtomCommand = (command: any) => command;
export const appAtomRegistry = { get: () => 0, set: () => undefined };
export const incrementLinkRevisionAtom = {};
export const useThreadShell = () => null;
export const readLocalApi = () => undefined;
export const projectEnvironment = {
  folderCheck: async () => ({ _tag: "Success", value: fixture().check }),
  changeFolder: async () => ({ _tag: "Success", value: null }),
};
export const threadEnvironment = { interruptTurn: async () => ({ _tag: "Success", value: null }) };
