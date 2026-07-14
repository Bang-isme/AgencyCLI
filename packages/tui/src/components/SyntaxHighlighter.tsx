import React from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";

export function renderHighlightedLine(
  line: string,
  language: string,
  theme: ThemeTokens
): React.ReactNode {
  const lowerLang = language?.toLowerCase() ?? "";
  
  // Only apply formatting to supported languages
  const supported = ["js", "ts", "javascript", "typescript", "json", "py", "python", "sh", "bash"];
  if (!supported.includes(lowerLang)) {
    return <Text color={theme.text} backgroundColor={theme.panel}>{line}</Text>;
  }

  // Regex-based simple tokenization for syntax elements:
  // Group 1: Comments (// ... or # ...)
  // Group 2: Strings ("..." or '...' or `...`)
  // Group 3: Keywords (const, let, function, return, class, import, etc.)
  // Group 4: Numbers
  // Group 5: Function calls (word before open parenthesis)
  const tokenRegex = /(\/\/.*|#.*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b(?:const|let|var|function|return|class|import|from|export|default|if|else|for|while|new|async|await|try|catch|throw|type|interface|enum|extends|implements|def|elif|as|in|is|not|and|or|lambda|except|finally|raise|with|assert|pass|nonlocal|global)\b)|(\b\d+\b)|(\b\w+(?=\())/g;

  const parts = line.split(tokenRegex);
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < parts.length; i += 6) {
    // 0: Normal text
    if (parts[i]) {
      elements.push(<Text key={`text-${i}`} color={theme.text} backgroundColor={theme.panel}>{parts[i]}</Text>);
    }
    if (i + 1 < parts.length) {
      // 1: Comment
      if (parts[i + 1] !== undefined) {
        elements.push(<Text key={`comment-${i}`} color={theme.muted} backgroundColor={theme.panel} italic>{parts[i + 1]}</Text>);
      }
      // 2: String (uses success green/cyan color)
      if (parts[i + 2] !== undefined) {
        elements.push(<Text key={`string-${i}`} color={theme.success} backgroundColor={theme.panel}>{parts[i + 2]}</Text>);
      }
      // 3: Keyword (uses accent purple/pink color)
      if (parts[i + 3] !== undefined) {
        elements.push(<Text key={`keyword-${i}`} color={theme.accent} backgroundColor={theme.panel} bold>{parts[i + 3]}</Text>);
      }
      // 4: Number (uses warning amber color)
      if (parts[i + 4] !== undefined) {
        elements.push(<Text key={`number-${i}`} color={theme.warning} backgroundColor={theme.panel}>{parts[i + 4]}</Text>);
      }
      // 5: Function (uses highlight cyan color)
      if (parts[i + 5] !== undefined) {
        elements.push(<Text key={`function-${i}`} color={theme.highlight} backgroundColor={theme.panel}>{parts[i + 5]}</Text>);
      }
    }
  }

  return <Box flexDirection="row">{elements}</Box>;
}
