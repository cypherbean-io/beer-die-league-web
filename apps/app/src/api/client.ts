import {
  CreateInviteResponse,
  ErrorBody,
  HealthResponse,
  type Invite,
  InvitesResponse,
  JoinResponse,
  type League,
  LeagueResponse,
  type Member,
  MembersResponse,
  type MembershipRole,
  MeResponse,
  type MyMembership,
  VerifyCodeResponse,
} from '@beer-die/core';

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

// Writes are always JSON: the API refuses anything else as a CSRF defence, even a bodiless
// DELETE.
function sendJson(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function postJson(path: string, body: unknown): Promise<Response> {
  return sendJson('POST', path, body);
}

async function getJson<T>(path: string, schema: { parse(data: unknown): T }): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw await failure(res);
  return schema.parse(await res.json());
}

async function expectOk(res: Response): Promise<void> {
  if (!res.ok) throw await failure(res);
}

const leaguePath = (leagueId: string) => `/api/leagues/${encodeURIComponent(leagueId)}`;

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

export async function joinLeague(token: string, displayName: string): Promise<MyMembership> {
  const res = await postJson(`/api/invites/${encodeURIComponent(token)}/join`, { displayName });
  if (!res.ok) throw await failure(res);
  return JoinResponse.parse(await res.json()).membership;
}

export async function getLeague(leagueId: string): Promise<League> {
  return (await getJson(leaguePath(leagueId), LeagueResponse)).league;
}

export async function getMembers(leagueId: string): Promise<Member[]> {
  return (await getJson(`${leaguePath(leagueId)}/members`, MembersResponse)).members;
}

function memberPath(leagueId: string, membershipId: string, action: string): string {
  return `${leaguePath(leagueId)}/members/${encodeURIComponent(membershipId)}/${action}`;
}

export async function approveMember(leagueId: string, membershipId: string): Promise<void> {
  await expectOk(await postJson(memberPath(leagueId, membershipId, 'approve'), {}));
}

export async function rejectMember(leagueId: string, membershipId: string): Promise<void> {
  await expectOk(await postJson(memberPath(leagueId, membershipId, 'reject'), {}));
}

export async function setMemberRole(
  leagueId: string,
  membershipId: string,
  role: MembershipRole,
): Promise<void> {
  await expectOk(await postJson(memberPath(leagueId, membershipId, 'role'), { role }));
}

export async function createInvite(leagueId: string): Promise<CreateInviteResponse> {
  const res = await postJson(`${leaguePath(leagueId)}/invites`, {});
  if (!res.ok) throw await failure(res);
  return CreateInviteResponse.parse(await res.json());
}

export async function listInvites(leagueId: string): Promise<Invite[]> {
  return (await getJson(`${leaguePath(leagueId)}/invites`, InvitesResponse)).invites;
}

export async function revokeInvite(leagueId: string, inviteId: string): Promise<void> {
  const path = `${leaguePath(leagueId)}/invites/${encodeURIComponent(inviteId)}`;
  await expectOk(await sendJson('DELETE', path));
}
