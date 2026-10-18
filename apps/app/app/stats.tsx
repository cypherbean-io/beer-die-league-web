import type { MyMembership, PlayerStats, StatsScope } from '@beer-die/core';
import { useQuery } from '@tanstack/react-query';
import { Link, Redirect, Stack } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { getPlayerStats } from '../src/api/client';
import { currentMembership, useMe } from '../src/api/hooks';
import { percent, perGame, SCOPE_NOTES, ScopeTabs } from '../src/stats';

type Column = { label: string; title: string; value: (p: PlayerStats) => string };

const COLUMNS: Column[] = [
  { label: 'GP', title: 'Games played', value: (p) => String(p.gamesPlayed) },
  { label: 'W', title: 'Wins', value: (p) => String(p.wins) },
  { label: 'L', title: 'Losses', value: (p) => String(p.losses) },
  { label: 'Win%', title: 'Win percentage', value: (p) => percent(p.winPct) },
  { label: 'Pts', title: 'Points, sink points included', value: (p) => String(p.points) },
  { label: 'PPG', title: 'Points per game', value: (p) => perGame(p.pointsPerGame, 1) },
  { label: 'Sinks', title: 'Sinks', value: (p) => String(p.sinks) },
  { label: 'S/G', title: 'Sinks per game', value: (p) => perGame(p.sinksPerGame, 2) },
];

export default function Stats() {
  const me = useMe();
  const membership = currentMembership(me.data);

  if (me.data === null) return <Redirect href="/sign-in" />;
  if (me.data && membership?.status !== 'approved') return <Redirect href="/" />;
  if (!membership) return null;
  return <StatsTable membership={membership} />;
}

function StatsTable({ membership }: { membership: MyMembership }) {
  const { leagueId } = membership;
  const [scope, setScope] = useState<StatsScope>('combined');
  const stats = useQuery({
    queryKey: ['stats', leagueId, 'players', scope],
    queryFn: () => getPlayerStats(leagueId, scope),
  });
  const players = stats.data ?? [];

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Stats' }} />
      <ScopeTabs value={scope} onChange={setScope} />
      <Text style={styles.muted}>
        {SCOPE_NOTES[scope]} A game counts once all four players confirm it.
      </Text>
      {stats.isError && (
        <Text style={styles.error}>
          Couldn’t load the stats. Check your connection and try again.
        </Text>
      )}
      {stats.isSuccess && players.length === 0 && (
        <Text testID="stats-empty" style={styles.muted}>
          No counted games here yet.
        </Text>
      )}
      {players.length > 0 && (
        <ScrollView horizontal>
          <View testID="stats-table">
            <View style={styles.row}>
              <Text style={[styles.name, styles.heading]}>Player</Text>
              {COLUMNS.map((c) => (
                <Text key={c.label} style={[styles.cell, styles.heading]} aria-label={c.title}>
                  {c.label}
                </Text>
              ))}
            </View>
            {players.map((p) => (
              <View key={p.membershipId} style={styles.row} testID={`stats-row-${p.membershipId}`}>
                <Link
                  href={{ pathname: '/players/[mid]', params: { mid: p.membershipId } }}
                  style={[styles.name, styles.link]}
                >
                  {p.displayName}
                  {p.membershipId === membership.id ? ' (you)' : ''}
                </Link>
                {COLUMNS.map((c) => (
                  <Text key={c.label} style={styles.cell}>
                    {c.value(p)}
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
  name: { width: 150, paddingRight: 8 },
  cell: { width: 56, textAlign: 'right', fontVariant: ['tabular-nums'] },
  heading: { fontWeight: '700' },
  link: { color: '#1d4ed8' },
  muted: { color: '#555' },
  error: { color: '#b91c1c' },
});
