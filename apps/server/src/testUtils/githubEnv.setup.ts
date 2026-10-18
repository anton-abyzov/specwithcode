// Clears the GitHub token variables the server reads before gh and the token
// saved in Settings. A release runner exports GH_TOKEN for its own gh calls, and
// a developer may too; left in place it becomes the credential every
// source-control test sees. Tests that need one set it with vi.stubEnv.
for (const name of [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_HOST",
]) {
  delete process.env[name];
}
