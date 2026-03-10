import { type Static, Type } from '@sinclair/typebox';

export const HealthResponseSchema = Type.Object({
  status: Type.Literal('ok'),
  timestamp: Type.String({ format: 'date-time' }),
  uptime: Type.Number(),
});

export type HealthResponse = Static<typeof HealthResponseSchema>;

export const ReadyResponseSchema = Type.Object({
  status: Type.Union([Type.Literal('ready'), Type.Literal('not_ready')]),
  timestamp: Type.String({ format: 'date-time' }),
});

export type ReadyResponse = Static<typeof ReadyResponseSchema>;

export const healthSchema = {
  response: { 200: HealthResponseSchema },
};

export const readySchema = {
  response: {
    200: ReadyResponseSchema,
    503: ReadyResponseSchema,
  },
};
