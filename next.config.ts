import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: { root: __dirname },
  // Already on Next's default opt-out list; named here so the PDF route's
  // Chromium binary is not bundled (it resolves bin/ relative to the package).
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
  outputFileTracingIncludes: {
    // picomatch treats `[id]` as a character class; match the PDF route both ways.
    "/t/*/pdf": [
      "./public/fonts/ibm-plex-*.woff2",
      "./styles/report.css",
      "./node_modules/@sparticuz/chromium/bin/**",
    ],
    "/t/\\[id\\]/pdf": [
      "./public/fonts/ibm-plex-*.woff2",
      "./styles/report.css",
      "./node_modules/@sparticuz/chromium/bin/**",
    ],
  },
};

export default nextConfig;
