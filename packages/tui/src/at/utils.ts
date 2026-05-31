/** Active `@` query at end of buffer (no space after `@`). */
export function getAtQuery(
  buffer: string
): { query: string; start: number } | null {
  const lastAt = buffer.lastIndexOf("@");
  if (lastAt === -1) return null;
  const after = buffer.slice(lastAt + 1);
  if (/\s/.test(after)) return null;
  return { query: after, start: lastAt };
}

export function completeAtRef(buffer: string, path: string): string {
  const at = getAtQuery(buffer);
  if (!at) return `${buffer}@${path}`;
  return `${buffer.slice(0, at.start)}@${path} `;
}
