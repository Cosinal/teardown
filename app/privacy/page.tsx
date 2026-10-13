import type { Metadata } from "next";
import "@/styles/legal.css";

export const metadata: Metadata = { title: "Privacy Policy — Teardown" };

export default function PrivacyPolicy() {
  return (
    <>
      <header><div className="wrap"><a href="/">Teardown</a><span>Privacy Policy</span></div></header>
      <main><div className="wrap"><p className="eyebrow">Legal</p><h1>Privacy Policy</h1><p className="meta">Effective October 12, 2026 · Version 2026-10-12</p>
      <h2>Who we are</h2><p>Teardown is operated by Jorden Shaw, an individual based in Halifax, Nova Scotia, Canada ("we", "us"). We are responsible for the personal information described here. Contact: <a href="mailto:jorden@mail.grokbot.com">jorden@mail.grokbot.com</a>.</p>
      <h2>What we collect</h2><p>When you join the waitlist we collect your email address, the date and time you signed up, a record that you consented, and the version of this policy you agreed to. We do not store your IP address, and we do not use advertising or tracking cookies, or cross-site tracking, on this site.</p>
      <h2>Site metrics</h2><p>We use Vercel Web Analytics and Vercel Speed Insights to count visits and measure how fast pages load. They set no cookies. For each page view they record the page address, the referring site, your approximate location (country, region and city), and your device type, operating system and browser; Speed Insights also records page-load timings and network speed. Web Analytics tells repeat page views apart with a hash of the incoming request that is discarded after 24 hours. Neither tool records your IP address or identifies you, and we see only totals.</p>
      <h2>Business ideas you submit</h2><p>When you submit a business idea for a teardown, the idea and the details you enter with it (such as the target customer, price and location) are sent to Anthropic, PBC (United States), which provides the AI models that research the market and write the report. Anthropic processes this text on our behalf. Under Anthropic's commercial terms, it does not use it to train its models and deletes it from its systems within 30 days, except where it must keep it longer to enforce its usage policy or comply with the law. Please do not include personal information about yourself or others in an idea.</p>
      <h2>Why we collect it</h2><p>We use your email only to tell you when Teardown launches, to deliver a complimentary teardown if you are among the first 10 signups, and to ask for feedback on the product. We will not use it for anything else without asking you first.</p>
      <h2>Legal basis</h2><p>We process your information on the basis of your consent, which you give by ticking the consent box on the form. You can withdraw consent at any time. Withdrawing does not affect anything we did before you withdrew.</p>
      <h2>Sharing</h2><p>We do not sell, rent, or share your personal information for cross-context behavioural advertising. We share it only with the service providers that host this site and its database, measure site traffic, and generate teardowns, as listed in our <a href="/data">Data Policy</a>, and only so they can provide that service. We may disclose information where the law requires it.</p>
      <h2>Emails</h2><p>Every email we send will identify us, include our contact details, and contain a clear way to unsubscribe. We will act on unsubscribe requests within 10 business days.</p>
      <h2>Retention</h2><p>We keep your information until you ask us to delete it or until the waitlist is no longer needed, whichever comes first. If the product does not launch, we will delete the waitlist no later than October 10, 2027.</p>
      <h2>Your rights</h2><p>Depending on where you live, you may have the right to:</p><ul><li>access the personal information we hold about you, and get a copy in a portable format;</li><li>correct it;</li><li>have it deleted;</li><li>object to or restrict how we use it, or withdraw your consent;</li><li>not be treated differently for exercising these rights.</li></ul><p>To make a request, email <a href="mailto:jorden@mail.grokbot.com">jorden@mail.grokbot.com</a> from the address you signed up with. We will respond within 30 days. If you are not satisfied with our answer, you can complain to the Office of the Privacy Commissioner of Canada, to your local data protection supervisory authority if you are in the EU or UK, or to the California Privacy Protection Agency or your state attorney general if you are in the United States.</p>
      <h2>International transfers</h2><p>Our service providers may store and process your information outside Canada, including in the United States. See the <a href="/data">Data Policy</a> for details.</p>
      <h2>Children</h2><p>This site is not directed to children under 16. We do not knowingly collect their information.</p>
      <h2>Changes</h2><p>If we change this policy, we will update the version and effective date above. If a change is material, we will email people on the waitlist before it takes effect.</p>
      <h2>Contact</h2><p>Jorden Shaw, Halifax, Nova Scotia, Canada · <a href="mailto:jorden@mail.grokbot.com">jorden@mail.grokbot.com</a></p></div></main>
      <footer><div className="wrap"><span>© 2026 Teardown</span><a href="/">Home</a><a href="/privacy">Privacy Policy</a><a href="/data">Data Policy</a></div></footer>
    </>
  );
}
