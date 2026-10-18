import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: [
      "../shared/src/testing/longTempDir.ts",
      "../shared/src/testing/isolatedTempDir.ts",
    ],
    globalSetup: ["../shared/src/testing/vitestTempDirCleanup.ts"],
  },
});
