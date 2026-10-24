/** Local inspection must discover the selected checkout, regardless of the server's Git context. */
export function repositoryInspectionEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) env[key] = undefined;
  return {
    ...env,
    // Git for Windows maps "/dev/null" to NUL itself but cannot open `os.devNull` ("\\.\nul").
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  };
}
