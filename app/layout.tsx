import type { ReactNode } from "react";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

// No global CSS here: the home page and the legal pages each import their own
// stylesheet (styles/home.css, styles/legal.css), ported verbatim from the
// original static site. Internal links are plain <a> tags so every navigation
// is a full page load and only one stylesheet is ever applied.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
