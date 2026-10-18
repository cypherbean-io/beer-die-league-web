import { ErrorBody, HealthResponse, MeResponse, VerifyCodeResponse } from '@beer-die/core';

// Same-origin in both dev (Metro proxy) and production (Caddy). The web session is an
// httpOnly cookie scoped to /api, so the browser attaches it; the app never sees it.

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

async function failure(res: Response): Promise<ApiRequestError> {
  const parsed = ErrorBody.safeParse(await res.json().catch(() => null));
  return parsed.success
    ? new ApiRequestError(res.status, parsed.data.error.code, parsed.data.error.message)
    : new ApiRequestError(res.status, 'UNKNOWN', `Request failed with ${res.status}`);
}

// Writes are always JSON: the API refuses anything else as a CSRF defence.
function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function getHealth(): Promise<HealthResponse> {
  const res = await fetch('/api/health');
  if (!res.ok) throw new Error(`Health check failed with ${res.status}`);
  return HealthResponse.parse(await res.json());
}

export async function requestCode(email: string): Promise<void> {
  const res = await postJson('/api/auth/code', { email });
  if (res.status !== 202) throw await failure(res);
}

export async function verifyCode(email: string, code: string): Promise<VerifyCodeResponse> {
  const res = await postJson('/api/auth/verify', { email, code, client: 'web' });
  if (!res.ok) throw await failure(res);
  return VerifyCodeResponse.parse(await res.json());
}

// Null when signed out.
export async function getMe(): Promise<MeResponse | null> {
  const res = await fetch('/api/me');
  if (res.status === 401) return null;
  if (!res.ok) throw await failure(res);
  return MeResponse.parse(await res.json());
}

export async function logout(): Promise<void> {
  const res = await postJson('/api/auth/logout', {});
  // 401 means the session was already gone; either way the user is signed out.
  if (!res.ok && res.status !== 401) throw await failure(res);
}
