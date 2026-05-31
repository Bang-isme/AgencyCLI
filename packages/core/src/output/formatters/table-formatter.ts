import type { OutputTable, OutputEngineConfig } from "../output-types.js";

export function formatTable(
  data: OutputTable,
  config: OutputEngineConfig,
): string {
  if (config.surface === "json") {
    return JSON.stringify({ type: "table", ...data });
  }

  const lines: string[] = [];

  if (data.title) {
    lines.push(data.title);
  }

  const colWidths = data.headers.map((header, colIndex) => {
    let max = header.length;
    for (const row of data.rows) {
      const cell = row[colIndex] ?? "";
      if (cell.length > max) max = cell.length;
    }
    return max;
  });

  if (data.compact) {
    const headerLine = data.headers
      .map((h, i) => h.toUpperCase().padEnd(colWidths[i]!))
      .join("  ");
    lines.push(headerLine);

    const separator = colWidths.map((w) => "\u2500".repeat(w)).join("  ");
    lines.push(separator);

    for (const row of data.rows) {
      const rowLine = row
        .map((cell, i) => (cell ?? "").padEnd(colWidths[i]!))
        .join("  ");
      lines.push(rowLine);
    }
  } else {
    const border =
      "\u250c" +
      colWidths.map((w) => "\u2500".repeat(w + 2)).join("\u252c") +
      "\u2510";
    const headerSep =
      "\u251c" +
      colWidths.map((w) => "\u2500".repeat(w + 2)).join("\u253c") +
      "\u2524";
    const footer =
      "\u2514" +
      colWidths.map((w) => "\u2500".repeat(w + 2)).join("\u2534") +
      "\u2518";

    lines.push(border);
    const headerLine =
      "\u2502" +
      data.headers
        .map((h, i) => " " + h.toUpperCase().padEnd(colWidths[i]!) + " ")
        .join("\u2502") +
      "\u2502";
    lines.push(headerLine);
    lines.push(headerSep);

    for (const row of data.rows) {
      const rowLine =
        "\u2502" +
        row
          .map((cell, i) => " " + (cell ?? "").padEnd(colWidths[i]!) + " ")
          .join("\u2502") +
        "\u2502";
      lines.push(rowLine);
    }
    lines.push(footer);
  }

  return lines.join("\n");
}
