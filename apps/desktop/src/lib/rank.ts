import { generateKeyBetween } from "fractional-indexing";

/**
 * Key that sorts strictly between `before` and `after` (null = open end).
 * Same algorithm as `crates/core/src/rank.rs`; both pass `test-vectors/rank.json`.
 * Out-of-order bounds throw (the library would silently swap them), like the Rust side.
 */
export function rankBetween(before: string | null, after: string | null): string {
  if (before !== null && after !== null && before >= after) {
    throw new Error(`rank '${before}' must sort before '${after}'`);
  }
  return generateKeyBetween(before, after);
}
