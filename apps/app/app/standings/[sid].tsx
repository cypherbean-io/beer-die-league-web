import type { MyMembership, StandingsRow } from '@beer-die/core';
import { useQuery } from '@tanstack/react-query';
import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiRequestError, getStandings } from '../../src/api/client';
import { currentMembership, useMe } from '../../src/api/hooks';
import { describeOrder, rankLabel } from '../../src/standings';
import { percent } from '../../src/stats';

type Column = { label: string; title: string; value: (row: StandingsRow) => string };

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

const COLUMNS: Column[] = [
  { label: 'GP', title: 'Games played', value: (r) => String(r.gamesPlayed) },
  { label: 'W', title: 'Wins', value: (r) => String(r.wins) },
  { label: 'L', title: 'Losses', value: (r) => String(r.losses) },
  { label: 'Win%', title: 'Win percentage', value: (r) => percent(r.winPct) },
  { label: 'PF', title: 'Points for, sink points included', value: (r) => String(r.pointsFor) },
  { label: 'PA', title: 'Points against', value: (r) => String(r.pointsAgainst) },
  { label: 'Diff', title: 'Point difference', value: (r) => signed(r.pointDiff) },
  { label: 'Sinks', title: 'Sinks', value: (r) => String(r.sinks) },
];

export default function Standings() {
  const { sid } = useLocalSearchParams<{ sid: string }>();
  const me = useMe();
  const membership = currentMembership(me.data);

  if (me.data === null) return <Redirect href="/sign-in" />;
  if (me.data && membership?.status !== 'approved') return <Redirect href="/" />;
  if (!membership) return null;
  return <SeasonStandings membership={membership} seasonId={sid} />;
}

function SeasonStandings({ membership, seasonId }: { membership: MyMembership; seasonId: string }) {
  const { leagueId } = membership;
  const standings = useQuery({
    queryKey: ['standings', leagueId, seasonId],
    queryFn: () => getStandings(leagueId, seasonId),
  });
  const season = standings.data?.season;
  const rows = standings.data?.standings ?? [];

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: season ? `${season.name} standings` : 'Standings' }} />
      {standings.isError && (
        <Text style={styles.error}>
          {standings.error instanceof ApiRequestError && standings.error.status === 404
            ? 'That season doesn’t exist.'
            : 'Couldn’t load the standings. Check your connection and try again.'}
        </Text>
      )}
      {season && (
        <>
          {season.status === 'finalized' && <Text testID="standings-final">Final standings.</Text>}
          <Text style={styles.muted}>
            Ranked by {describeOrder(season.standingsConfig.order)}. A game counts once all four
            players confirm it.{' '}
            {season.standingsConfig.minGames > 1
              ? `Teams with fewer than ${season.standingsConfig.minGames} games aren’t ranked yet.`
              : 'Teams without a game aren’t ranked yet.'}
          </Text>
        </>
      )}
      {standings.isSuccess && rows.length === 0 && (
        <Text testID="standings-empty" style={styles.muted}>
          No approved teams in this season yet.
        </Text>
      )}
      {rows.length > 0 && (
        <ScrollView horizontal>
          <View testID="standings-table">
            <View style={styles.row}>
              <Text style={[styles.rank, styles.heading]} aria-label="Rank">
                #
              </Text>
              <Text style={[styles.team, styles.heading]}>Team</Text>
              {COLUMNS.map((c) => (
                <Text key={c.label} style={[styles.cell, styles.heading]} aria-label={c.title}>
                  {c.label}
                </Text>
              ))}
            </View>
            {rows.map((r) => (
              <View key={r.team.id} style={styles.row} testID={`standings-row-${r.team.id}`}>
                <Text style={styles.rank}>{rankLabel(r)}</Text>
                <Text style={styles.team} testID="cell-team">
                  {r.team.name}
                </Text>
                {COLUMNS.map((c) => (
                  <Text key={c.label} style={styles.cell} testID={`cell-${c.label.toLowerCase()}`}>
                    {c.value(r)}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 16, maxWidth: 720 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderColor: '#eee',
  },
  rank: { width: 44, fontVariant: ['tabular-nums'] },
  team: { width: 150, paddingRight: 8 },
  cell: { width: 56, textAlign: 'right', fontVariant: ['tabular-nums'] },
  heading: { fontWeight: '700' },
  muted: { color: '#555' },
  error: { color: '#b91c1c' },
});
