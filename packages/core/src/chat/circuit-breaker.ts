/**
 * Circuit Breaker for tool execution loops
 * Prevents infinite loops and cascading failures
 */
export interface CircuitBreakerState {
  toolCallHistory: string[];
  consecutiveFailures: number;
}

export interface CircuitBreakerResult {
  shouldBreak: boolean;
  reason?: string;
}

const CIRCUIT_BREAKER_THRESHOLD = 3;

export function createCircuitBreaker(): CircuitBreakerState {
  return {
    toolCallHistory: [],
    consecutiveFailures: 0,
  };
}

function getToolSignature(tc: { name: string; arguments: Record<string, any> }): string {
  return `${tc.name}:${JSON.stringify(tc.arguments)}`;
}

export function checkCircuitBreaker(
  state: CircuitBreakerState,
  toolCalls: { name: string; arguments: Record<string, any> }[]
): CircuitBreakerResult {
  // Check for repeated identical tool calls
  if (toolCalls.length > 0) {
    const signatures = toolCalls.map(getToolSignature);
    const lastSignature = signatures[signatures.length - 1];
    
    // Count consecutive identical calls
    let repeatCount = 0;
    for (let i = state.toolCallHistory.length - 1; i >= 0; i--) {
      if (state.toolCallHistory[i] === lastSignature) {
        repeatCount++;
      } else {
        break;
      }
    }
    
    if (repeatCount >= CIRCUIT_BREAKER_THRESHOLD) {
      return {
        shouldBreak: true,
        reason: `Circuit breaker triggered: Tool "${toolCalls[0].name}" called ${repeatCount + 1} times with identical arguments. Possible infinite loop detected.`,
      };
    }
    
    // Update history
    state.toolCallHistory.push(...signatures);
  }

  // Check for consecutive failures
  if (state.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    return {
      shouldBreak: true,
      reason: `Circuit breaker triggered: ${state.consecutiveFailures} consecutive tool execution failures. Stopping to prevent cascading errors.`,
    };
  }

  return { shouldBreak: false };
}

export function recordToolFailure(state: CircuitBreakerState): void {
  state.consecutiveFailures++;
}

export function recordToolSuccess(state: CircuitBreakerState): void {
  state.consecutiveFailures = 0;
}
