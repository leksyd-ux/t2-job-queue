/**
 * Computes exponential backoff with additive uniform jitter.
 *
 * Formula:
 * delay = min(capMs, baseMs * 2^(attempts)) + random(0, jitterMs)
 *
 * Jitter Rationale (Defence Line):
 * Without jitter, if a downstream dependency (such as an email provider or database)
 * experiences an outage, hundreds of failed worker tasks will calculate the EXACT SAME
 * exponential delay and retry at the EXACT SAME millisecond. This causes a synchronized
 * "Thundering Herd" retry storm that immediately knocks the recovering service offline again.
 * Adding random jitter de-synchronizes the workers, spreading retry attempts evenly across time.
 */
export function calculateBackoff(
  attempts: number,
  baseMs: number,
  capMs: number,
  jitterMs: number
): number {
  const safeAttempts = Math.max(0, attempts);
  const exponential = baseMs * Math.pow(2, safeAttempts);
  const capped = Math.min(capMs, exponential);
  const jitter = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;
  return capped + jitter;
}

export function computeNextRunAt(
  attempts: number,
  baseMs: number,
  capMs: number,
  jitterMs: number
): Date {
  const delayMs = calculateBackoff(attempts, baseMs, capMs, jitterMs);
  return new Date(Date.now() + delayMs);
}
