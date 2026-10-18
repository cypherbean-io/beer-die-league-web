import type { ErrorBody } from '@beer-die/core';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';

// Thrown from handlers and middleware; app.onError renders it as an ErrorBody.
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly details: unknown;

  constructor(status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

// Parses the JSON body with a strict core schema; any structural problem is 422 VALIDATION.
export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(422, 'VALIDATION', 'Request body must be valid JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map(({ path, message }) => ({ path, message }));
    throw new ApiError(422, 'VALIDATION', 'Invalid request body', details);
  }
  return parsed.data;
}
