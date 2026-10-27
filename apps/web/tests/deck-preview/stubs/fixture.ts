/* What the fixture's host answers, set by the page from its URL. */
export const fixture = {
  /** `ok` serves the deck's slides; `corrupt` refuses it as the server does. */
  deck: "ok" as "ok" | "corrupt" | "old-server",
  actions: [] as Array<{ action: string; filePath: string }>,
};
Object.assign(window, { fixtureActions: () => fixture.actions });
