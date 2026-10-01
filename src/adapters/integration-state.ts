/**
 * Integration states (§32/§35). Degradation is a diagnosis, not a shrug:
 * NOT_CONFIGURED (nothing to connect to) differs from UNREACHABLE
 * (configured but down), from TOOL_MISSING, from OPERATION_FAILED, from
 * DISABLED_BY_POLICY, and — for gated integrations like Reusery — from
 * NOT_NEEDED (policy chose not to consult).
 */

import type { EvidenceGrade } from "../qa/types.js";

export type IntegrationState =
  | "READY"
  | "NOT_CONFIGURED"
  | "UNREACHABLE"
  | "TOOL_MISSING"
  | "OPERATION_FAILED"
  | "DISABLED_BY_POLICY"
  | "NOT_NEEDED";

export interface IntegrationDescriptor {
  name: string;
  state: IntegrationState;
  reason: string;
  grade: EvidenceGrade;
  version?: string;
  executable?: string;
}
