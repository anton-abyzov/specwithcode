// Stand-ins for the server connection. The views are the app's own; only what
// they would load or save is faked by the fixture.
export const serverEnvironment = {};
export const useAtomCommand = () => async () => ({ _tag: "Failure" });
