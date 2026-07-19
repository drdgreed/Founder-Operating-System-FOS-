import {
  ZodArray,
  ZodBoolean,
  ZodDefault,
  ZodEnum,
  ZodNullable,
  ZodNumber,
  ZodObject,
  ZodOptional,
  ZodRecord,
  ZodString,
  ZodType,
} from "zod";

/**
 * FLAG (genuinely underspecified — no JSON-Schema-generation dependency was
 * pre-approved alongside `@anthropic-ai/sdk`): a minimal, hand-rolled
 * Zod -> JSON Schema converter covering only the subset of Zod this
 * package's agent definitions use (object/string/number/boolean/array/enum/
 * record, plus optional/nullable/default wrapping). It is NOT a general
 * converter — an unsupported Zod type throws rather than silently producing
 * a wrong/permissive schema. If a broader converter is later wanted, adding
 * `zod-to-json-schema` as an approved dependency is the natural upgrade; this
 * keeps the runtime's dependency footprint to exactly the founder-approved
 * `@anthropic-ai/sdk`.
 */
export function zodToJsonSchema(schema: ZodType): Record<string, unknown> {
  if (schema instanceof ZodOptional || schema instanceof ZodNullable) {
    return zodToJsonSchema(schema.unwrap());
  }
  if (schema instanceof ZodDefault) {
    return zodToJsonSchema(schema.removeDefault());
  }
  if (schema instanceof ZodString) {
    return { type: "string" };
  }
  if (schema instanceof ZodNumber) {
    return { type: "number" };
  }
  if (schema instanceof ZodBoolean) {
    return { type: "boolean" };
  }
  if (schema instanceof ZodEnum) {
    return { type: "string", enum: schema.options };
  }
  if (schema instanceof ZodArray) {
    return { type: "array", items: zodToJsonSchema(schema.element) };
  }
  if (schema instanceof ZodRecord) {
    return { type: "object", additionalProperties: zodToJsonSchema(schema.valueSchema) };
  }
  if (schema instanceof ZodObject) {
    const shape = schema.shape as Record<string, ZodType>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      if (!(value instanceof ZodOptional) && !(value instanceof ZodDefault)) {
        required.push(key);
      }
    }
    return { type: "object", properties, required, additionalProperties: false };
  }
  throw new Error(`zodToJsonSchema: unsupported Zod type "${schema.constructor.name}"`);
}
