export { SecurityLevel, SecurityEscalationManager } from "./security-escalation.js";
export type { SecurityCheckResult } from "./security-escalation.js";
export { NativeSandbox, DockerSandbox, isDockerAvailable, normalizeDockerPath } from "./sandbox.js";
export type { SandboxOptions, SandboxResult, Sandbox, SandboxEvent, SandboxEventType } from "./sandbox.js";
export { ProcessJail } from "./process-jail.js";
export { EgressFilterProxy, matchGlob } from "./egress-proxy.js";
export type { EgressFilterProxyOptions } from "./egress-proxy.js";

