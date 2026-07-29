import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    coverage: {
      enabled: false
    },
    environment: "node",
    include: ["**/*.test.ts"],
    mockReset: true,
    passWithNoTests: false,
    restoreMocks: true,
    testTimeout: 10_000
  }
});
