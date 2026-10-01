/**
 * Review depth: LIGHT / STANDARD / DEEP. Starts as internal policy:
 * consequential seams force DEEP, public behaviour forces STANDARD,
 * everything else is LIGHT. The selected depth and its reason are
 * recorded on the spec so depth is auditable, not vibes.
 */

import type { ReviewDepth } from "./types.js";

const DEEP_SEAMS = new Set([
  "security",
  "persistence",
  "concurrency",
  "migration",
  "authority",
  "irreversible-state",
]);

export function selectDepth(opts: {
  consequentialSeams?: string[];
  touchesPublicBehaviour?: boolean;
  trivial?: boolean;
}): { depth: ReviewDepth; reason: string } {
  const seams = opts.consequentialSeams ?? [];
  const deep = seams.filter((s) => DEEP_SEAMS.has(s));
  if (deep.length > 0) {
    return { depth: "DEEP", reason: `consequential seams: ${deep.join(", ")}` };
  }
  if (opts.touchesPublicBehaviour) {
    return { depth: "STANDARD", reason: "public behaviour change" };
  }
  if (opts.trivial) {
    return { depth: "LIGHT", reason: "trivial/low-consequence change" };
  }
  return { depth: "STANDARD", reason: "ordinary change, default depth" };
}
