export interface Competitor {
  name: string;
  url: string;
  /** What they charge and how the offer is structured, e.g. "$29/mo per seat; free tier". */
  pricing: string;
  /** Who buys from them, and why. */
  target_customer: string;
}

export interface Source {
  title: string;
  url: string;
}

export interface TeardownReport {
  competitors: Competitor[];
  pricing_summary: string;
  customer_segments: string[];
  market_gaps: string[];
  sources: Source[];
}
