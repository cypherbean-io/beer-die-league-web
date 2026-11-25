import {
  INBOX_MAX,
  type MyMembership,
  type League,
  type Season,
  type StandingsRow,
} from '@beer-die/core';
import { useQuery } from '@tanstack/react-query';
import { Link, Redirect, Stack } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  getHealth,
  getInbox,
  getLeague,
  getSeasons,
  getStandings,
  getTeams,
} from '../../src/api/client';
import { currentMembership, queryKeys, useMe, useSignOut } from '../../src/api/hooks';
import { myStanding, rankLabel } from '../../src/standings';
import { percent } from '../../src/stats';
import { colors, fonts, radius, space } from '../../src/theme';
import { Badge, Button, Card, Screen, Text, textStyles } from '../../src/ui';

export default function Home() {
  const health = useQuery({ queryKey: queryKeys.health, queryFn: getHealth });
  const me = useMe();

  if (me.data === null) return <Redirect href="/sign-in" />;
  const membership = currentMembership(me.data);

  return (
    <>
      <Stack.Screen options={{ title: 'Beer Die League' }} />
      <Header league={membership?.status === 'approved' ? membership.leagueName : null} />
      <Screen>
        {health.isError && (
          <Text testID="api-status" style={styles.offline}>
            Can’t reach the server. Check your connection.
          </Text>
        )}
        {me.data &&
          (membership?.status === 'approved' ? (
            <LeagueHome membership={membership} />
          ) : (
            <Waiting membership={membership} email={me.data.user.email} />
          ))}
      </Screen>
    </>
  );
}

// The league's name once the caller is in it. `league-name` marks being in a league.
function Header({ league }: { league: string | null }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.header, { paddingTop: insets.top + space.xl }]}>
      <Die />
      <Text
        testID={league === null ? undefined : 'league-name'}
        role="heading"
        style={styles.title}
        numberOfLines={1}
      >
        {league ?? 'Beer Die League'}
      </Text>
    </View>
  );
}

// The league's mark: a die showing three, in the accent.
function Die() {
  return (
    <View style={styles.die} aria-hidden>
      <View style={[styles.pip, { top: 4, left: 4 }]} />
      <View style={[styles.pip, { top: 10, left: 10 }]} />
      <View style={[styles.pip, { top: 16, left: 16 }]} />
    </View>
  );
}

// Signed in, but not yet in a league: there's no tab bar, so the account is reached from here.
function Waiting({ membership, email }: { membership: MyMembership | undefined; email: string }) {
  const signOut = useSignOut();
  return (
    <>
      <Card>
        {membership === undefined ? (
          <Text testID="no-league" style={styles.message}>
            You’re not in a league yet. Ask a commissioner for an invite link.
          </Text>
        ) : (
          <Text testID="awaiting-approval" style={styles.message}>
            Your request to join {membership.leagueName} is awaiting a commissioner’s approval.
          </Text>
        )}
      </Card>
      <Text testID="signed-in-as" style={textStyles.muted}>
        Signed in as {email}
      </Text>
      <Link href="/account" testID="account-link" style={textStyles.link}>
        Account
      </Link>
      <Button
        testID="sign-out"
        label="Sign out"
        variant="secondary"
        disabled={signOut.isPending}
        onPress={() => signOut.mutate()}
      />
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

function LeagueHome({ membership }: { membership: MyMembership }) {
  const { leagueId } = membership;
  const league = useQuery({
    queryKey: queryKeys.league(leagueId),
    queryFn: () => getLeague(leagueId),
  });
  const seasons = useQuery({
    queryKey: queryKeys.seasons(leagueId),
    queryFn: () => getSeasons(leagueId),
  });
  const season = seasons.data ? currentSeason(seasons.data) : null;
  const standings = useQuery({
    queryKey: queryKeys.seasonStandings(leagueId, season?.id),
    queryFn: () => getStandings(leagueId, season!.id),
    enabled: season !== null,
  });
  const teams = useQuery({
    queryKey: queryKeys.teams(leagueId, season?.id),
    queryFn: () => getTeams(leagueId, season!.id),
    enabled: season !== null,
  });
  const rows = standings.data?.standings ?? [];
  const mine = teams.data ? myStanding(teams.data, rows, membership.id) : null;

  return (
    <>
      {season && mine && <MyTeam season={season} row={mine} />}
      <InboxStrip leagueId={leagueId} />
      {season && <StandingsSnapshot season={season} rows={rows} loaded={standings.isSuccess} />}
      {league.data && <RulesLine rules={league.data.rules} />}
    </>
  );
}

function MyTeam({ season, row }: { season: Season; row: StandingsRow }) {
  return (
    <Card testID="my-team">
      <View style={styles.spread}>
        <Text style={textStyles.kicker}>{row.team.name}</Text>
        <Text style={textStyles.kicker}>{season.name}</Text>
      </View>
      <View style={styles.scoreline}>
        <Text style={styles.record} aria-label={`${row.wins} wins, ${row.losses} losses`}>
          {row.wins}–{row.losses}
        </Text>
        <View style={styles.figures}>
          <Figure label="Rank" value={rankLabel(row)} />
          <Figure
            label="Diff"
            value={row.pointDiff > 0 ? `+${row.pointDiff}` : String(row.pointDiff)}
          />
        </View>
      </View>
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.figure}>
      <Text style={styles.figureValue}>{value}</Text>
      <Text style={textStyles.kicker}>{label}</Text>
    </View>
  );
}

function InboxStrip({ leagueId }: { leagueId: string }) {
  const inbox = useQuery({
    queryKey: queryKeys.inbox(leagueId),
    queryFn: () => getInbox(leagueId),
  });
  const waiting = inbox.data?.length ?? 0;
  // The inbox is capped, so a full one may hold more.
  const badge = waiting >= INBOX_MAX ? `${INBOX_MAX}+` : String(waiting);

  return (
    // `Link asChild` hands its child's style straight to the DOM on web, so it must be one
    // object: an array throws, and a function is dropped.
    <Link href="/inbox" asChild>
      <Pressable
        testID="inbox-link"
        role="link"
        style={StyleSheet.flatten([styles.inbox, waiting > 0 && styles.inboxWaiting])}
      >
        {waiting > 0 && (
          <Badge testID="inbox-badge" label={badge} ariaLabel={`${badge} to confirm`} />
        )}
        <Text style={[styles.inboxText, waiting > 0 && styles.inboxTextWaiting]}>
          {waiting === 0 ? 'Inbox' : waiting === 1 ? 'Result to confirm' : 'Results to confirm'}
        </Text>
        <Text style={[styles.arrow, waiting > 0 && styles.inboxTextWaiting]} aria-hidden>
          →
        </Text>
      </Pressable>
    </Link>
  );
}

const SNAPSHOT_ROWS = 5;

function StandingsSnapshot({
  season,
  rows,
  loaded,
}: {
  season: Season;
  rows: StandingsRow[];
  loaded: boolean;
}) {
  const top = rows.filter((r) => r.rank !== null).slice(0, SNAPSHOT_ROWS);
  return (
    <Card testID="standings-snapshot" style={styles.table}>
      <View style={[styles.spread, styles.tableHead]}>
        <Text role="heading" style={styles.tableTitle}>
          {season.name}
        </Text>
        <Link
          href={{ pathname: '/standings/[sid]', params: { sid: season.id } }}
          testID="standings-link"
          style={textStyles.link}
        >
          Standings
        </Link>
      </View>
      {loaded && top.length === 0 && (
        <Text style={[textStyles.muted, styles.tablePad]}>No team is ranked yet.</Text>
      )}
      {top.length > 0 && (
        <View style={styles.tableRow}>
          <Text style={[textStyles.kicker, styles.rk]}>Rk</Text>
          <Text style={[textStyles.kicker, styles.teamCol]}>Team</Text>
          <Text style={[textStyles.kicker, styles.num]}>W</Text>
          <Text style={[textStyles.kicker, styles.num]}>L</Text>
          <Text style={[textStyles.kicker, styles.pct]}>Pct</Text>
        </View>
      )}
      {top.map((r, i) => (
        <View
          key={r.team.id}
          testID={`snapshot-row-${r.team.id}`}
          style={[styles.tableRow, styles.divided, i === 0 && styles.leader]}
        >
          <Text style={[styles.rk, styles.rankText, i === 0 && styles.accent]}>{rankLabel(r)}</Text>
          <Text style={styles.teamCol} numberOfLines={1}>
            {r.team.name}
          </Text>
          <Text style={[styles.num, styles.numText]}>{r.wins}</Text>
          <Text style={[styles.num, styles.numText, styles.dim]}>{r.losses}</Text>
          <Text style={[styles.pct, styles.numText]}>{percent(r.winPct)}</Text>
        </View>
      ))}
    </Card>
  );
}

function RulesLine({ rules }: { rules: League['rules'] }) {
  return (
    <Text testID="league-rules" style={[textStyles.muted, styles.rules]}>
      First to {rules.targetScore}, win by {rules.winBy}.
      {rules.sinkPoints > 0 ? ` A sink is worth ${rules.sinkPoints}.` : ''}
      {rules.sinkEndsGame ? ' A sink ends the game.' : ''}
    </Text>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    backgroundColor: colors.bg,
  },
  title: {
    flexShrink: 1,
    fontFamily: fonts.display,
    fontWeight: '700',
    fontSize: 24,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  die: {
    width: 26,
    height: 26,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.accent,
  },
  pip: {
    position: 'absolute',
    width: 4,
    height: 4,
    marginLeft: -1,
    marginTop: -1,
    borderRadius: 2,
    backgroundColor: colors.accent,
  },
  offline: { color: colors.danger },
  message: { fontSize: 17, lineHeight: 24 },
  spread: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  scoreline: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  record: {
    fontFamily: fonts.display,
    fontWeight: '700',
    fontSize: 80,
    lineHeight: 80,
    color: colors.accent,
    fontVariant: ['tabular-nums'],
  },
  figures: { flexDirection: 'row', gap: space.xl, paddingBottom: space.sm },
  figure: { alignItems: 'flex-end' },
  figureValue: {
    fontFamily: fonts.display,
    fontWeight: '700',
    fontSize: 28,
    fontVariant: ['tabular-nums'],
  },
  inbox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 56,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  inboxWaiting: { borderColor: colors.accent },
  inboxText: {
    flex: 1,
    fontFamily: fonts.display,
    fontWeight: '700',
    fontSize: 18,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  inboxTextWaiting: { color: colors.accent },
  arrow: { fontSize: 20 },
  table: { padding: 0, gap: 0, overflow: 'hidden' },
  tableHead: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm },
  tableTitle: {
    fontFamily: fonts.display,
    fontWeight: '700',
    fontSize: 18,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  tablePad: { paddingHorizontal: space.lg, paddingBottom: space.lg },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 34,
    paddingHorizontal: space.lg,
  },
  divided: { minHeight: 46, borderTopWidth: 1, borderColor: colors.divider },
  leader: { backgroundColor: colors.raised },
  rk: { width: 36 },
  teamCol: { flex: 1, fontWeight: '500' },
  num: { width: 34, textAlign: 'right' },
  pct: { width: 64, textAlign: 'right' },
  rankText: { fontFamily: fonts.display, fontWeight: '700', color: colors.muted },
  numText: {
    fontFamily: fonts.display,
    fontWeight: '600',
    fontSize: 18,
    fontVariant: ['tabular-nums'],
  },
  dim: { color: colors.muted },
  accent: { color: colors.accent },
  rules: { textAlign: 'center', fontWeight: '500' },
});
