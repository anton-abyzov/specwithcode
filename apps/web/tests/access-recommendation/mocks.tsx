// Stand-ins for the desktop shell, the setup header and the saved answer. The
// step and the callout are the app's own; only what they would save is faked.
export const isElectron = true;
export const FirstRunUpdateNotice = () => null;
export const StarOnGitHubLink = () => null;
export const useFullAccessRecommendation = () => {
  throw new Error("The fixture passes the answers in itself.");
};
export const useEnvironment = () => null;
export const usePrimaryEnvironmentId = () => null;
