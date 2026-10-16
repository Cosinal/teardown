import { canViewTeardown, readTeardown } from "@/lib/teardown";
import { htmlToPdf, pdfFilename, reportHtml } from "@/lib/pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Chromium cold start + five pages. Hobby allows 300s; this should be well under.
export const maxDuration = 60;

type Props = { params: Promise<{ id: string }> };

/**
 * GET /t/[id]/pdf — the finished report as a letter-size PDF.
 * Same viewer check as /t/[id]. Missing, private, waiting and failed all 404
 * (the HTML page shows Private/Cooking; a PDF URL must not emit the report).
 */
export async function GET(_req: Request, { params }: Props) {
  const { id } = await params;
  const t = await readTeardown(id);
  if (!t || !(await canViewTeardown(id, t.ownerHash)) || !t.report) {
    return new Response(null, { status: 404 });
  }
  try {
    const html = await reportHtml(t.report, id === "sample" ? "Sample report" : undefined);
    const pdf = await htmlToPdf(html);
    return new Response(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${pdfFilename(t.report.idea.name)}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    console.error(`PDF ${id}:`, err);
    return new Response(null, { status: 500 });
  }
}
