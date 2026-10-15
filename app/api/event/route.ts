import { recordEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public: records one first-party page view or checkout start. Always 204;
// invalid payloads are ignored. Nothing about the visitor is returned.
export async function POST(req: Request) {
  try {
    let b: Record<string, unknown> = {};
    try {
      const parsed = await req.json();
      if (parsed && typeof parsed === "object") b = parsed as Record<string, unknown>;
    } catch { /* ignore empty or non-JSON bodies */ }
    await recordEvent({
      kind: b.kind,
      path: b.path,
      ref: b.ref,
      referrer: b.referrer,
      utm_source: b.utm_source,
      utm_medium: b.utm_medium,
      utm_campaign: b.utm_campaign,
      selfHost: new URL(req.url).hostname,
    });
  } catch (err) {
    console.error("event", err);
  }
  return new Response(null, { status: 204 });
}
