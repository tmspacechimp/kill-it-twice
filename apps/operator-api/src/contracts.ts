import { z } from 'zod';

const text = z.string().trim().min(1).max(2000);
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export const unavailableSchema = z.strictObject({
  available: z.literal(false),
  code: text,
  reason: text,
});
export type Unavailable = z.infer<typeof unavailableSchema>;

export function availableSchema<T extends z.ZodType>(data: T) {
  return z.strictObject({ available: z.literal(true), data });
}

const measurement = z.union([
  z.strictObject({
    available: z.literal(true),
    value: z.number(),
    unit: text,
    definition: text,
  }),
  unavailableSchema,
]);

export const statusSchema = z.strictObject({
  replicationState: z.union([
    z.strictObject({ available: z.literal(true), value: text }),
    unavailableSchema,
  ]),
  metrics: z.strictObject({
    initialLoadProgress: measurement,
    throughput: measurement,
    incrementalLag: measurement,
    dlqCount: measurement,
  }),
  health: z
    .array(
      z.strictObject({
        component: text,
        state: z.enum(['healthy', 'unhealthy', 'unavailable']),
        reason: text,
      }),
    )
    .max(100),
});

const scalar = z.union([z.string().max(2000), z.number(), z.boolean()]);
const settingKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/);
export const configurationSchema = z
  .strictObject({
    settings: z
      .array(
        z.strictObject({
          key: settingKey,
          value: scalar,
          description: text,
          appliesAt: text,
        }),
      )
      .max(100),
  })
  .refine(
    ({ settings }) => new Set(settings.map((setting) => setting.key)).size === settings.length,
    'Setting keys must be unique',
  );

export const configurationUpdateSchema = z.strictObject({
  values: z
    .record(settingKey, scalar)
    .refine(
      (values) => Object.keys(values).length > 0 && Object.keys(values).length <= 100,
      'Provide between 1 and 100 settings',
    ),
});

export const dlqPageSchema = z.strictObject({
  entries: z
    .array(
      z.strictObject({
        id: tokenSchema,
        record: z.record(z.string(), z.unknown()),
        reason: text,
      }),
    )
    .max(100),
  nextCursor: tokenSchema.nullable(),
});

export const completionSchema = z.strictObject({
  completed: z.literal(true),
  message: text,
});

export type Configuration = z.infer<typeof configurationSchema>;
export type ConfigurationUpdate = z.infer<typeof configurationUpdateSchema>;
export type DlqQuery = { limit: number; cursor?: string };
