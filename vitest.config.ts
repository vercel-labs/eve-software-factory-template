import { defineConfig } from "vitest/config";

/**
 * Deterministic test suite configuration.
 *
 * @remarks
 * The suite never reaches a model, GitHub, Linear, Blob, or a sandbox: every
 * boundary is replaced with an in-process fake. The environment values below
 * exist only because several modules validate them at load time
 * (`FACTORY_REPO`, `LINEAR_CONNECTOR`); they name nothing real.
 */
export default defineConfig({
  test: {
    env: {
      FACTORY_INTAKE_TOKEN: "test-intake-token-0123456789abcdef",
      FACTORY_REPO: "acme/widgets",
      GITHUB_CONNECTOR: "github/test-agent",
      LINEAR_CONNECTOR: "linear/test-agent",
    },
    environment: "node",
    include: ["tests/**/*.test.ts"],
    typecheck: {
      enabled: true,
      include: ["tests/**/*.test-d.ts"],
      tsconfig: "./tsconfig.json",
    },
  },
});
