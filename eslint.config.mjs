import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Internal links are deliberately plain <a> (full page loads) so the
      // page-scoped stylesheets never mix. See CLAUDE.md.
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  {
    // Legal copy is ported verbatim; quotes and apostrophes render the same.
    files: ["app/privacy/page.tsx", "app/data/page.tsx"],
    rules: { "react/no-unescaped-entities": "off" },
  },
  globalIgnores([".next/**", "out/**", "next-env.d.ts", "design/**"]),
]);
