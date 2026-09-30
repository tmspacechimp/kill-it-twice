import { z } from 'zod';
import { ApiError } from './api-error.js';
import { availableSchema, unavailableSchema } from './contracts.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;
export const UPSTREAM_TIMEOUT_MS = 2000;

export class ReplicatorHttp {
  constructor(private readonly origin: string | undefined) {}

  async request<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown) {
    if (!this.origin) {
      throw new ApiError(503, 'not_configured', 'REPLICATOR_API_URL is not configured.');
    }

    const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
    try {
      const response = await fetch(new URL(path, this.origin), {
        method,
        redirect: 'manual',
        signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await readBody(response);
      return parseResponse(response.status, text, schema);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (signal.aborted) {
        throw new ApiError(
          504,
          'timeout',
          'Replicator request exceeded two seconds; completion is unknown.',
        );
      }
      throw new ApiError(503, 'unreachable', 'The replicator HTTP API could not be reached.');
    }
  }
}

async function readBody(response: Response): Promise<string> {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ApiError(502, 'invalid_response', 'Replicator response exceeded 1 MiB.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseResponse<T>(status: number, text: string, schema: z.ZodType<T>): T {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = undefined;
  }

  const unavailable = unavailableSchema.safeParse(payload);
  if (unavailable.success) {
    const { code, reason } = unavailable.data;
    const responseStatus = status >= 400 && status <= 599 ? status : 501;
    throw new ApiError(responseStatus, code, reason);
  }
  if ([404, 405, 501].includes(status)) {
    throw new ApiError(501, 'unsupported', 'This replicator endpoint is not implemented.');
  }
  if (status === 202) {
    throw new ApiError(502, 'unconfirmed', 'The replicator has not confirmed completion.');
  }
  if (status < 200 || status >= 300) {
    throw new ApiError(502, 'upstream_error', `Replicator returned HTTP ${status}.`);
  }

  const result = availableSchema(schema).safeParse(payload);
  if (!result.success) {
    throw new ApiError(
      502,
      'invalid_response',
      'Replicator response does not match the operator contract.',
    );
  }
  return result.data.data;
}
