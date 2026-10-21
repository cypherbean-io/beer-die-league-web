import {
  AuditResponse,
  type CorrectGameBody,
  CreateInviteResponse,
  ErrorBody,
  type Game,
  GameResponse,
  HealthResponse,
  InboxResponse,
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
  type PartnershipStats,
  PartnershipStatsResponse,
  type PlayerStats,
  PlayerStatResponse,
  PlayerStatsResponse,
  type RulesBody,
  type Season,
  SeasonResponse,
  SeasonsResponse,
  type SettingsBody,
  type StandingsConfigBody,
  StandingsResponse,
  type StatsScope,
  type SubmitGameBody,
  type Team,
  TeamResponse,
  TeamsResponse,
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
function sendJson(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<Response> {
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

// Send only the fields that changed, so a concurrent edit to another field survives.
export async function updateRules(leagueId: string, patch: RulesBody): Promise<League> {
  const res = await sendJson('PATCH', `${leaguePath(leagueId)}/rules`, patch);
  if (!res.ok) throw await failure(res);
  return LeagueResponse.parse(await res.json()).league;
}

export async function updateSettings(leagueId: string, patch: SettingsBody): Promise<League> {
  const res = await sendJson('PATCH', `${leaguePath(leagueId)}/settings`, patch);
  if (!res.ok) throw await failure(res);
  return LeagueResponse.parse(await res.json()).league;
}

// Newest first; pass the previous page's `nextBefore` to read further back.
export async function getAudit(leagueId: string, before?: string): Promise<AuditResponse> {
  const query = before === undefined ? '' : `?before=${encodeURIComponent(before)}`;
  return getJson(`${leaguePath(leagueId)}/audit${query}`, AuditResponse);
}

// Retrying with the same body (and so the same idempotency key) returns the original game
// rather than recording a second one.
export async function submitGame(leagueId: string, body: SubmitGameBody): Promise<Game> {
  const res = await postJson(`${leaguePath(leagueId)}/games`, body);
  if (!res.ok) throw await failure(res);
  return GameResponse.parse(await res.json()).game;
}

// Based on the revision the player was shown: if the game changed since, the server refuses
// it with STALE_REVISION rather than overwrite numbers the player hasn't seen.
export async function correctGame(
  leagueId: string,
  gameId: string,
  body: CorrectGameBody,
): Promise<Game> {
  const res = await postJson(
    `${leaguePath(leagueId)}/games/${encodeURIComponent(gameId)}/revisions`,
    body,
  );
  if (!res.ok) throw await failure(res);
  return GameResponse.parse(await res.json()).game;
}

// Games whose open revision awaits my confirmation, soonest to expire first.
export async function getInbox(leagueId: string): Promise<Game[]> {
  return (await getJson(`${leaguePath(leagueId)}/inbox`, InboxResponse)).games;
}

// Always the revision the player was shown, so nobody confirms numbers they haven't seen.
export async function confirmRevision(
  leagueId: string,
  gameId: string,
  revisionId: string,
): Promise<Game> {
  const path = `${leaguePath(leagueId)}/games/${encodeURIComponent(gameId)}/revisions/${encodeURIComponent(revisionId)}/confirm`;
  const res = await postJson(path, {});
  if (!res.ok) throw await failure(res);
  return GameResponse.parse(await res.json()).game;
}

// Everyone with a counted game in the scope, by wins, then points, then name.
export async function getPlayerStats(leagueId: string, scope: StatsScope): Promise<PlayerStats[]> {
  const path = `${leaguePath(leagueId)}/stats/players?scope=${encodeURIComponent(scope)}`;
  return (await getJson(path, PlayerStatsResponse)).players;
}

// Every pair with a counted game in the scope, by wins, then points, then names.
export async function getPartnershipStats(
  leagueId: string,
  scope: StatsScope,
): Promise<PartnershipStats[]> {
  const path = `${leaguePath(leagueId)}/stats/partnerships?scope=${encodeURIComponent(scope)}`;
  return (await getJson(path, PartnershipStatsResponse)).partnerships;
}

export async function getPlayerProfile(
  leagueId: string,
  membershipId: string,
  scope: StatsScope,
): Promise<PlayerStats> {
  const path = `${leaguePath(leagueId)}/stats/players/${encodeURIComponent(membershipId)}?scope=${encodeURIComponent(scope)}`;
  return (await getJson(path, PlayerStatResponse)).player;
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

// Commissioners only. Voids the open games the member plays in and takes them off their teams.
export async function removeMember(leagueId: string, membershipId: string): Promise<void> {
  await expectOk(await postJson(memberPath(leagueId, membershipId, 'remove'), {}));
}

// Voids my open games and takes me off my teams. The last commissioner can't leave.
export async function leaveLeague(leagueId: string): Promise<void> {
  await expectOk(await postJson(`${leaguePath(leagueId)}/leave`, {}));
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

// Newest first.
export async function getSeasons(leagueId: string): Promise<Season[]> {
  return (await getJson(`${leaguePath(leagueId)}/seasons`, SeasonsResponse)).seasons;
}

export async function createSeason(leagueId: string, name: string): Promise<Season> {
  const res = await postJson(`${leaguePath(leagueId)}/seasons`, { name });
  if (!res.ok) throw await failure(res);
  return SeasonResponse.parse(await res.json()).season;
}

function seasonPath(leagueId: string, seasonId: string, action: string): string {
  return `${leaguePath(leagueId)}/seasons/${encodeURIComponent(seasonId)}/${action}`;
}

export async function startSeason(leagueId: string, seasonId: string): Promise<Season> {
  const res = await postJson(seasonPath(leagueId, seasonId, 'start'), {});
  if (!res.ok) throw await failure(res);
  return SeasonResponse.parse(await res.json()).season;
}

export async function endSeason(leagueId: string, seasonId: string): Promise<Season> {
  const res = await postJson(seasonPath(leagueId, seasonId, 'end'), {});
  if (!res.ok) throw await failure(res);
  return SeasonResponse.parse(await res.json()).season;
}

// Send only the fields that changed, so a concurrent edit to the other one survives.
export async function updateStandingsConfig(
  leagueId: string,
  seasonId: string,
  patch: StandingsConfigBody,
): Promise<Season> {
  const res = await sendJson('PATCH', seasonPath(leagueId, seasonId, 'standings-config'), patch);
  if (!res.ok) throw await failure(res);
  return SeasonResponse.parse(await res.json()).season;
}

// The season's approved teams, ranked by its standings config, with the season itself.
export async function getStandings(leagueId: string, seasonId: string): Promise<StandingsResponse> {
  return getJson(seasonPath(leagueId, seasonId, 'standings'), StandingsResponse);
}

// Every team in the season, by name.
export async function getTeams(leagueId: string, seasonId: string): Promise<Team[]> {
  return (await getJson(seasonPath(leagueId, seasonId, 'teams'), TeamsResponse)).teams;
}

// Puts me and my partner on a new team, which waits for my partner to accept.
export async function proposeTeam(
  leagueId: string,
  seasonId: string,
  name: string,
  partnerId: string,
): Promise<Team> {
  const res = await postJson(seasonPath(leagueId, seasonId, 'teams'), { name, partnerId });
  if (!res.ok) throw await failure(res);
  return TeamResponse.parse(await res.json()).team;
}

export type TeamAction = 'accept' | 'withdraw' | 'approve' | 'reject';

export async function actOnTeam(
  leagueId: string,
  teamId: string,
  action: TeamAction,
): Promise<Team> {
  const res = await postJson(
    `${leaguePath(leagueId)}/teams/${encodeURIComponent(teamId)}/${action}`,
    {},
  );
  if (!res.ok) throw await failure(res);
  return TeamResponse.parse(await res.json()).team;
}

// Commissioners only: an approved team's two players.
export async function setTeamRoster(
  leagueId: string,
  teamId: string,
  membershipIds: [string, string],
): Promise<Team> {
  const res = await sendJson(
    'PUT',
    `${leaguePath(leagueId)}/teams/${encodeURIComponent(teamId)}/roster`,
    { membershipIds },
  );
  if (!res.ok) throw await failure(res);
  return TeamResponse.parse(await res.json()).team;
}
