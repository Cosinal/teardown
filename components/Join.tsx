"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

export default function Join() {
  const [count, setCount] = useState<number | null>(null);
  const [msg, setMsg] = useState("");
  const consent = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const j = await (await fetch("/api/count", { cache: "no-store" })).json();
      if (typeof j.count === "number") setCount(j.count);
    } catch {}
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    if (!consent.current?.checked) {
      setMsg("Please agree to the Privacy Policy to join.");
      return;
    }
    setMsg("Submitting…");
    try {
      const ref = new URLSearchParams(window.location.search).get("ref");
      const r = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: (form.elements.namedItem("email") as HTMLInputElement).value, consent: consent.current.checked, ref }),
      });
      const j = await r.json();
      setMsg(r.ok ? "Received. You are on the list." : j.error || "Something went wrong.");
      if (r.ok) {
        form.reset();
        consent.current.checked = false;
        refresh();
      }
    } catch {
      setMsg("Something went wrong.");
    }
  }

  return (
    <section className="join">
      <div><div id="count">{count ?? "—"}</div><div className="clabel">On the waitlist</div></div>
      <div>
        <form id="f" onSubmit={onSubmit}><input type="email" name="email" placeholder="Work or personal email" required aria-label="Email" /><button>Join waitlist</button></form>
        <label className="consent"><input type="checkbox" name="consent" id="consent" form="f" required ref={consent} /> <span>I agree to the <a href="/privacy">Privacy Policy</a> and to receive launch emails.</span></label>
        <p className="offer"><em>First 10 signups</em> receive a complimentary teardown at launch, in exchange for feedback.</p>
        <p id="msg">{msg}</p>
      </div>
    </section>
  );
}
