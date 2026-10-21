/* The settler's requests, passed through so the runtime stub can read them. */
export const projectEnvironment = {
  listEntries: (request: object) => request,
  searchEntries: (request: object) => ({ ...request, search: true }),
};
