import { z } from 'zod';
import { ApiError } from './api-error.js';
import { configurationUpdateSchema, tokenSchema } from './contracts.js';
import type { Configuration, ConfigurationUpdate } from './contracts.js';

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(400, 'invalid_input', 'Input does not match the documented request shape.');
  }
  return result.data;
}

export function requireEmpty(input: unknown): void {
  parseInput(z.strictObject({}), input ?? {});
}

export function parseConfigurationUpdate(input: unknown): ConfigurationUpdate {
  return parseInput(configurationUpdateSchema, input);
}

export function validateSettings(update: ConfigurationUpdate, current: Configuration): void {
  for (const [key, value] of Object.entries(update.values)) {
    const setting = current.settings.find((candidate) => candidate.key === key);
    if (!setting || typeof setting.value !== typeof value) {
      throw new ApiError(
        400,
        'invalid_input',
        `Setting ${key} is unsupported or has the wrong type.`,
      );
    }
  }
}

export function parseDlqQuery(input: unknown) {
  const query = parseInput(
    z.strictObject({
      limit: z
        .string()
        .regex(/^[1-9][0-9]{0,2}$/)
        .optional(),
      cursor: tokenSchema.optional(),
    }),
    input,
  );
  const limit = Number(query.limit ?? 50);
  if (limit > 100) {
    throw new ApiError(400, 'invalid_input', 'DLQ limit must be between 1 and 100.');
  }
  return { limit, cursor: query.cursor };
}
