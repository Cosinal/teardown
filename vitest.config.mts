import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Mirrors tsconfig's "@/*" path so tests can import modules that use it.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
});
