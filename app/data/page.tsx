import type { Metadata } from "next";
import "@/styles/legal.css";

export const metadata: Metadata = { title: "Data Policy — Teardown" };

export default function DataPolicy() {
  return (
    <>
      <header><div className="wrap"><a href="/">Teardown</a><span>Data Policy</span></div></header>
      <main><div className="wrap"><p className="eyebrow">Legal</p><h1>Data Policy</h1><p className="meta">Effective October 10, 2026 · Version 2026-10-10</p><p>This policy explains in detail how waitlist data is handled. It supplements our <a href="/privacy">Privacy Policy</a>.</p>
      <h2>Data collected</h2><ul><li>Email address</li><li>Date and time of signup</li><li>A consent flag and the policy version you agreed to</li></ul><p>No IP addresses, names, payment details, or tracking identifiers are stored with your signup.</p>
      <h2>Purpose</h2><p>To notify you at launch, deliver a complimentary teardown to the first 10 signups, and request product feedback. The public waitlist counter shows only the total number of signups and never any email address.</p>
      <h2>Legal basis</h2><p>Consent (GDPR Article 6(1)(a); express consent under Canada's PIPEDA and CASL). You can withdraw it at any time by emailing <a href="mailto:jorden@mail.grokbot.com">jorden@mail.grokbot.com</a> or using the unsubscribe link in any email.</p>
      <h2>Retention</h2><p>We keep data until you request deletion or the waitlist is no longer needed. If the product does not launch, we delete the waitlist no later than October 10, 2027.</p>
      <h2>Storage location and processors</h2><ul><li><b>Vercel Inc.</b> (United States): website hosting and server functions.</li><li><b>Neon, a service of Databricks, Inc.</b> (United States, AWS us-east-1): the PostgreSQL database that stores waitlist entries, provisioned through the Vercel Marketplace.</li></ul><p>These providers process data on our behalf under their own terms and data processing agreements. We do not use any other processors for waitlist data.</p>
      <h2>Cross-border transfers</h2><p>Waitlist data is stored and processed in the United States. It may be subject to the laws of that country, including lawful access by authorities there. For transfers from the EU or UK, we rely on our providers' Standard Contractual Clauses or equivalent safeguards.</p>
      <h2>Security</h2><p>Data is encrypted in transit (HTTPS/TLS) and at rest by our providers. Database credentials are held only on the server and are never sent to the browser. Reading or deleting signups requires a secret administrator key, and access is limited to the operator. No method of storage is completely secure, but we take reasonable steps to protect your information.</p>
      <h2>Access, correction, deletion, portability</h2><p>Email <a href="mailto:jorden@mail.grokbot.com">jorden@mail.grokbot.com</a> from the address you signed up with and say what you would like: a copy of your data (provided as a machine-readable file), a correction, or deletion. We will confirm and complete the request within 30 days. Deletion removes your entry from the database permanently.</p>
      <h2>Sale and sharing</h2><p>We do not sell personal information and do not share it for cross-context behavioural advertising, as those terms are defined under the CCPA/CPRA.</p>
      <h2>Breach handling</h2><p>If a breach of security safeguards involving your information creates a real risk of significant harm, we will notify you and the relevant regulator (such as the Office of the Privacy Commissioner of Canada) as soon as feasible, and within 72 hours of becoming aware of it where GDPR applies. We keep a record of every breach.</p>
      <h2>Complaints</h2><p>Contact us first at <a href="mailto:jorden@mail.grokbot.com">jorden@mail.grokbot.com</a>. You also have the right to complain to the Office of the Privacy Commissioner of Canada, the data protection supervisory authority in your EU or UK country, or the relevant US state authority.</p>
      <h2>Operator</h2><p>Jorden Shaw, Halifax, Nova Scotia, Canada · <a href="mailto:jorden@mail.grokbot.com">jorden@mail.grokbot.com</a></p></div></main>
      <footer><div className="wrap"><span>© 2026 Teardown</span><a href="/">Home</a><a href="/privacy">Privacy Policy</a><a href="/data">Data Policy</a></div></footer>
    </>
  );
}
