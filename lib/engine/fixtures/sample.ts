import { parseReport } from "../validate";
import type { TeardownReport } from "../types";
import sample from "./sample.json";

/**
 * The design's sample report (Teardown's own idea), validated once at load.
 * A fixture only: the /t/sample page, the stub API and tests use it; the
 * engine never does.
 */
export const SAMPLE_REPORT: TeardownReport = parseReport(sample);
