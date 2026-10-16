import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import Report from "@/components/Report";
import type { TeardownReport } from "@/lib/engine/types";

// process.cwd() is the app root in tests, `next start`, and the Vercel function.
const root = process.cwd();

const LOCAL_CHROME = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/local/bin/google-chrome",
].filter((p): p is string => !!p);

/** `tearitdown-<idea-slug>.pdf` — ASCII, no spaces, fits Content-Disposition. */
export function pdfFilename(ideaName: string): string {
  const slug = ideaName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `tearitdown-${slug || "report"}.pdf`;
}

function withFontDataUris(css: string): string {
  return css.replace(/url\((\/fonts\/[^)]+)\)/g, (_m, path: string) => {
    const file = path.replace(/^\/fonts\//, "");
    const buf = readFileSync(join(root, "public/fonts", file));
    return `url(data:font/woff2;base64,${buf.toString("base64")})`;
  });
}

/**
 * The five letter sheets as a print document. Fonts are data URIs so Chromium
 * does not need a network or the CDN copy of /public. No Download button.
 */
export async function reportHtml(report: TeardownReport, label?: string): Promise<string> {
  // Static import of react-dom/server is banned in the App Router; dynamic is allowed in a route handler.
  const { renderToStaticMarkup } = await import("react-dom/server");
  const css = withFontDataUris(readFileSync(join(root, "styles/report.css"), "utf8"));
  const body = renderToStaticMarkup(createElement(Report, { report, label }));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
${css}
@page{size:letter;margin:0}
html,body{margin:0;background:#fff}
.td-doc{padding:0!important;gap:0!important;display:block!important}
.td-sheet{box-shadow:none!important;break-after:page;page-break-after:always;break-inside:avoid;page-break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.td-sheet:last-child{break-after:auto;page-break-after:auto}
.td-toolbar{display:none!important}
</style>
</head>
<body>${body}</body>
</html>`;
}

function localChrome(): string | undefined {
  return LOCAL_CHROME.find((p) => existsSync(p));
}

/**
 * Render HTML to a letter-size PDF. On Vercel this unpacks @sparticuz/chromium
 * into /tmp (x64 brotli in the function bundle, ~64MB). Locally it prefers a
 * system Chrome so Amazon-Linux Chromium is not required on a laptop.
 */
export async function htmlToPdf(html: string): Promise<Uint8Array> {
  const puppeteer = await import("puppeteer-core");
  const chromium = (await import("@sparticuz/chromium")).default;
  const onVercel = !!process.env.VERCEL;
  const local = onVercel ? undefined : localChrome();
  if (onVercel || !local) chromium.setGraphicsMode = false;
  const executablePath = local ?? await chromium.executablePath();
  const serverless = !local;
  const args = serverless
    ? puppeteer.defaultArgs({ args: [...chromium.args, "--disable-dev-shm-usage"], headless: "shell" })
    : ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none", "--hide-scrollbars"];

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    browser = await puppeteer.launch({
      args,
      executablePath,
      headless: serverless ? "shell" : true,
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 816, height: 1056, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.emulateMediaType("print");
    const pdf = await page.pdf({
      format: "letter",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    await page.close();
    return pdf;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
