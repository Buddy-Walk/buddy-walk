import { z } from "zod";

/** A saved field, read as missing when absent, null or in an older shape. */
export const maybe = <T extends z.ZodType>(schema: T) =>
  schema
    .nullish()
    .transform((value) => value ?? undefined)
    .optional()
    .catch(undefined);

/** A saved array, leaving out items in an older shape. Absent reads as empty. */
export const list = <T extends z.ZodType>(item: T) =>
  z
    .array(z.unknown())
    .transform((values) =>
      values.flatMap((value) => {
        const parsed = item.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      }),
    )
    .catch([]);
