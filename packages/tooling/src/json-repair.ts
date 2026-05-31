export class JSONRepairEngine {
  /**
   * Attempts to repair a malformed JSON string into a valid, parseable JSON string.
   */
  public repair(rawText: string): string {
    let trimmed = rawText.trim();
    if (!trimmed) return "{}";

    // 1. Try to parse directly first
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      // Proceed to repair steps
    }

    // 2. Extract JSON block if it is wrapped in markdown code blocks
    const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch && codeBlockMatch[1]) {
      trimmed = codeBlockMatch[1].trim();
      try {
        JSON.parse(trimmed);
        return trimmed;
      } catch {}
    }

    // 3. Repair trailing commas: e.g. [1, 2, ] -> [1, 2] or {"a": 1, } -> {"a": 1}
    trimmed = trimmed.replace(/,\s*([\]}])/g, "$1");

    // 4. Repair single quotes to double quotes for keys and values
    // But be careful not to break apostrophes in text.
    // A simple regex approach for standard JSON keys/strings:
    trimmed = trimmed.replace(/'([^']*)'\s*:/g, '"$1":'); // key quotes
    
    // 5. Replace single quoted strings with double quotes in values, but avoid replacing inside existing double quotes
    // We'll run a quick state-machine scanner below to clean quotes and balance braces
    trimmed = this.stateMachineRepair(trimmed);

    // Try parsing after cleanups
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {}

    // 6. Balance unclosed brackets and braces at the end of the text
    trimmed = this.balanceBrackets(trimmed);

    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {}

    return trimmed; // Return best effort if still unparseable
  }

  private stateMachineRepair(input: string): string {
    let output = "";
    let inDoubleQuotes = false;
    let inSingleQuotes = false;
    let escape = false;

    for (let i = 0; i < input.length; i++) {
      const char = input[i]!;

      if (escape) {
        output += char;
        escape = false;
        continue;
      }

      if (char === "\\") {
        output += char;
        escape = true;
        continue;
      }

      if (char === '"') {
        if (!inSingleQuotes) {
          inDoubleQuotes = !inDoubleQuotes;
        }
        output += char;
        continue;
      }

      if (char === "'") {
        if (!inDoubleQuotes) {
          // Replace single quotes with double quotes
          output += '"';
          inSingleQuotes = !inSingleQuotes;
          continue;
        }
      }

      // Handle unescaped newlines inside active double quotes
      if (char === "\n" && (inDoubleQuotes || inSingleQuotes)) {
        output += "\\n";
        continue;
      }

      output += char;
    }

    return output;
  }

  private balanceBrackets(input: string): string {
    let trimmed = input.trim();
    const stack: ("[" | "{")[] = [];
    let inQuotes = false;
    let escape = false;

    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i]!;

      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === '"') {
        inQuotes = !inQuotes;
        continue;
      }

      if (!inQuotes) {
        if (char === "{" || char === "[") {
          stack.push(char);
        } else if (char === "}") {
          if (stack[stack.length - 1] === "{") {
            stack.pop();
          }
        } else if (char === "]") {
          if (stack[stack.length - 1] === "[") {
            stack.pop();
          }
        }
      }
    }

    // Append matching closing braces/brackets in reverse order
    while (stack.length > 0) {
      const open = stack.pop();
      if (open === "{") {
        trimmed += "}";
      } else if (open === "[") {
        trimmed += "]";
      }
    }

    return trimmed;
  }
}
