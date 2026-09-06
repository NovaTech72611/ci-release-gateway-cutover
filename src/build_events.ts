import { z } from "zod";

export const BuildEvent = z.object({
  build_id: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().min(1),
  status: z.enum(["passed", "failed", "cancelled"]),
  duration_ms: z.number().int().nonnegative(),
  attempt: z.number().int().min(1),
  failed_step: z.string().optional(),
  log_tail: z.string().default(""),
});
export type BuildEvent = z.infer<typeof BuildEvent>;

export const ReleaseRequest = z.object({
  release_id: z.string().min(1), // client-supplied: a retried publish never double-applies
  repo: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  event: BuildEvent,
});
export type ReleaseRequest = z.infer<typeof ReleaseRequest>;

export type Triage =
  | { action: "release"; reason: string }
  | { action: "auto_retry"; reason: string }
  | { action: "diagnose"; reason: string }
  | { action: "page_oncall"; reason: string };

const FLAKY_STEPS = new Set(["fetch-deps", "restore-cache", "upload-artifact"]);

/**
 * The one decision this service exists to make. Deterministic and offline —
 * the model is only asked for prose *after* triage says "diagnose".
 */
export function triage(event: BuildEvent): Triage {
  if (event.status === "cancelled") {
    return { action: "auto_retry", reason: "cancelled builds carry no signal" };
  }
  if (event.status === "passed") {
    return { action: "release", reason: "build green" };
  }
  if (event.branch === "main" && event.attempt >= 3) {
    return { action: "page_oncall", reason: "main red after three attempts" };
  }
  if (event.failed_step && FLAKY_STEPS.has(event.failed_step) && event.attempt < 3) {
    return { action: "auto_retry", reason: `infrastructure step ${event.failed_step}` };
  }
  return { action: "diagnose", reason: `${event.failed_step ?? "unknown step"} failed` };
}
