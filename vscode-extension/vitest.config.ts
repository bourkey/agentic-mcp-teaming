import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    alias: {
      vscode: new URL("./tests/__mocks__/vscode.ts", import.meta.url).pathname,
    },
    include: ["tests/**/*.test.ts"],
  },
});
