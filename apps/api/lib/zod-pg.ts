import { z } from "zod";

/**
 * Builds a Zod enum from a Drizzle pgEnum's `.enumValues` while preserving the
 * literal union in the parsed output type. The runtime values passed to
 * `z.enum` are the real enum members, so validation is exact; only the static
 * tuple type is coerced to satisfy `z.enum`'s signature.
 */
export function zEnumFromPg<T extends string>(values: readonly T[]) {
  return z.enum(values as unknown as [T, ...T[]]);
}
