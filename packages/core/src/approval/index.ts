export { appendAudit, type AuditEntry } from "./audit.js";
export {
  isDestructiveCommand,
  DENY_PATTERNS,
} from "./patterns.js";
export {
  ApprovalRequiredError,
  assertApproval,
  requiresApproval,
  isSelfKillingCommand,
} from "./policy.js";
export { RiskAssessor } from "./risk-assessor.js";
export { ApprovalPolicyEngine } from "./approval-policy-engine.js";

