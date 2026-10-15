"use client";

import { useEffect } from "react";

const sent = new Set<string>();

/** Fire-and-forget first-party page view. No cookie, no identifier. */
export default function Track({ path }: { path: string }) {
  useEffect(() => {
    if (sent.has(path)) return;
    sent.add(path);
    const q = new URLSearchParams(window.location.search);
    const body = JSON.stringify({
      kind: "page_view",
      path,
      ref: q.get("ref"),
      referrer: document.referrer || null,
      utm_source: q.get("utm_source"),
      utm_medium: q.get("utm_medium"),
      utm_campaign: q.get("utm_campaign"),
    });
    const blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon) navigator.sendBeacon("/api/event", blob);
    else void fetch("/api/event", { method: "POST", body, headers: { "Content-Type": "application/json" }, keepalive: true });
  }, [path]);
  return null;
}
