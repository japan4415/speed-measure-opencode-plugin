import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "**/.workflow-runs/**"],
    globals: true,
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
