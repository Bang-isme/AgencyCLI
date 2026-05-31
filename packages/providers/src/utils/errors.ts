/**
 * Unified check for transient rate-limiting and temporary server errors.
 */
export function isTransientError(err: any): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const status = err?.status || err?.statusCode || err?.response?.status || err?.response?.statusCode;
  return (
    status === 429 ||
    status === 408 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("quota exceeded") ||
    msg.includes("limit exceeded") ||
    msg.includes("exhausted") ||
    msg.includes("developer limit") ||
    msg.includes("overloaded") ||
    msg.includes("service unavailable") ||
    msg.includes("bad gateway") ||
    msg.includes("gateway timeout")
  );
}
