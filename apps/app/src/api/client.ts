import { HealthResponse } from '@beer-die/core';

// Same-origin in both dev (Metro proxy) and production (Caddy).
export async function getHealth(): Promise<HealthResponse> {
  const res = await fetch('/api/health');
  if (!res.ok) throw new Error(`Health check failed with ${res.status}`);
  return HealthResponse.parse(await res.json());
}
