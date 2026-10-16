import { validate, version } from "uuid";

/**
 * Reads an Idempotency-Key header value as a lowercase UUIDv7, or undefined
 * when it is missing or not a UUIDv7.
 */
export function parseIdempotencyKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toLowerCase();
  return validate(key) && version(key) === 7 ? key : undefined;
}
