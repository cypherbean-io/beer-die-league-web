import { INBOX_MAX, type MyMembership, type Season } from '@beer-die/core';
import { useQuery } from '@tanstack/react-query';
import { Link, Redirect, Stack } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { getHealth, getInbox, getLeague, getSeasons, getStandings } from '../src/api/client';
import { currentMembership, useMe, useSignOut } from '../src/api/hooks';
import { rankLabel } from '../src/standings';

export default function Home() {
  const health = useQuery({ queryKey: ['health'], queryFn: getHealth });
  const me = useMe();
  const signOut = useSignOut();

  if (me.data === null) return <Redirect href="/sign-in" />;
  const membership = currentMembership(me.data);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Beer Die League' }} />
      <Text testID="api-status">
        {health.isPending ? 'Checking API…' : health.isError ? 'API unreachable' : 'API ok'}
      </Text>
      {me.data && (
        <>
          <Text testID="signed-in-as">Signed in as {me.data.user.email}</Text>
          {membership === undefined ? (
            <Text testID="no-league" style={styles.message}>
              You&apos;re not in a league yet. Ask a commissioner for an invite link.
            </Text>
          ) : membership.status === 'pending' ? (
            <Text testID="awaiting-approval" style={styles.message}>
              Your request to join {membership.leagueName} is awaiting a commissioner&apos;s
              approval.
            </Text>
          ) : (
            <LeagueHome membership={membership} />
          )}
          <Link href="/account" testID="account-link" style={styles.link}>
            Account
          </Link>
          <Pressable
            testID="sign-out"
            role="button"
            disabled={signOut.isPending}
            onPress={() => signOut.mutate()}
          >
            <Text style={styles.link}>Sign out</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

function LeagueHome({ membership }: { membership: MyMembership }) {
  const league = useQuery({
    queryKey: ['league', membership.leagueId],
    queryFn: () => getLeague(membership.leagueId),
  });
  const inbox = useQuery({
    queryKey: ['inbox', membership.leagueId],
    queryFn: () => getInbox(membership.leagueId),
  });
  const rules = league.data?.rules;
  const waiting = inbox.data?.length ?? 0;
  // The inbox is capped, so a full one may hold more.
  const badge = waiting >= INBOX_MAX ? `${INBOX_MAX}+` : String(waiting);

  return (
    <>
      <Text testID="league-name" style={styles.title}>
        {membership.leagueName}
      </Text>
      {rules && (
        <Text testID="league-rules">
          First to {rules.targetScore}, win by {rules.winBy}.
          {rules.sinkPoints > 0 ? ` A sink is worth ${rules.sinkPoints}.` : ''}
          {rules.sinkEndsGame ? ' A sink ends the game.' : ''}
        </Text>
      )}
      <Link href="/inbox" testID="inbox-link" style={styles.link}>
        Inbox
        {waiting > 0 && (
          <Text testID="inbox-badge" style={styles.badge} aria-label={`${badge} to confirm`}>
            {' '}
            {badge}{' '}
          </Text>
        )}
      </Link>
      <Link href="/record-game" testID="record-game-link" style={styles.link}>
        Record game
      </Link>
      <Link href="/games" testID="games-link" style={styles.link}>
        Games
      </Link>
      <StandingsSnapshot leagueId={membership.leagueId} />
      <Link href="/stats" testID="stats-link" style={styles.link}>
        Stats
      </Link>
      <Link href="/seasons" testID="seasons-link" style={styles.link}>
        Seasons
      </Link>
      <Link href="/members" testID="members-link" style={styles.link}>
        Members
      </Link>
      <Link href="/audit" testID="audit-link" style={styles.link}>
        League log
      </Link>
      {membership.role === 'commissioner' && (
        <>
          <Link href="/overrides" testID="overrides-link" style={styles.link}>
            Games to review
          </Link>
          <Link href="/invites" testID="invites-link" style={styles.link}>
            Invite players
          </Link>
          <Link href="/league-settings" testID="league-settings-link" style={styles.link}>
            Rules and settings
          </Link>
        </>
      )}
    </>
  );
}

// The active season, or else the one started most recently. Null before any has started.
function currentSeason(seasons: Season[]): Season | null {
  const active = seasons.find((s) => s.status === 'active');
  if (active) return active;
  const started = seasons.filter((s) => s.startedAt !== null);
  started.sort((a, b) => (a.startedAt! < b.startedAt! ? 1 : -1));
  return started[0] ?? null;
}

const SNAPSHOT_ROWS = 3;

function StandingsSnapshot({ leagueId }: { leagueId: string }) {
  const seasons = useQuery({
    queryKey: ['seasons', leagueId],
    queryFn: () => getSeasons(leagueId),
  });
  const season = seasons.data ? currentSeason(seasons.data) : null;
  const standings = useQuery({
    queryKey: ['standings', leagueId, season?.id],
    queryFn: () => getStandings(leagueId, season!.id),
    enabled: season !== null,
  });
  if (!season) return null;
  const top = (standings.data?.standings ?? []).filter((r) => r.rank !== null);

  return (
    <View testID="standings-snapshot" style={styles.snapshot}>
      <Text style={styles.subtitle}>{season.name}</Text>
      {standings.isSuccess && top.length === 0 && (
        <Text style={styles.muted}>No team is ranked yet.</Text>
      )}
      {top.slice(0, SNAPSHOT_ROWS).map((r) => (
        <Text key={r.team.id} testID={`snapshot-row-${r.team.id}`}>
          {rankLabel(r)} {r.team.name}, {r.wins}–{r.losses}
        </Text>
      ))}
      <Link
        href={{ pathname: '/standings/[sid]', params: { sid: season.id } }}
        testID="standings-link"
        style={styles.link}
      >
        Standings
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  title: { fontSize: 22, fontWeight: '700' },
  subtitle: { fontSize: 16, fontWeight: '700' },
  snapshot: { alignItems: 'center', gap: 4 },
  muted: { color: '#555' },
  message: { textAlign: 'center', maxWidth: 420 },
  link: { color: '#1d4ed8', padding: 8 },
  badge: { backgroundColor: '#b91c1c', color: '#fff', fontWeight: '700', borderRadius: 10 },
});
