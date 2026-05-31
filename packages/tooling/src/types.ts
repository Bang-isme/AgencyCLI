export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ToolValidationResult {
  valid: boolean;
  coercedArguments: Record<string, any>;
  errors?: string[];
}
