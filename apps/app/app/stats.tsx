import {
  type MyMembership,
  pairKey,
  type PartnershipStats,
  type PlayerStats,
  type StatsScope,
} from '@beer-die/core';
import { useQuery } from '@tanstack/react-query';
import { Link, Redirect, Stack } from 'expo-router';
import { Fragment, useState } from 'react';
import { ScrollView, StyleSheet, Text, type TextStyle, View } from 'react-native';
import { getPartnershipStats, getPlayerStats } from '../src/api/client';
import { currentMembership, useMe } from '../src/api/hooks';
import { percent, perGame, SCOPE_NOTES, ScopeTabs } from '../src/stats';

type Column<T> = { label: string; title: string; value: (row: T) => string };

const COLUMNS: Array<Column<PlayerStats>> = [
  { label: 'GP', title: 'Games played', value: (p) => String(p.gamesPlayed) },
  { label: 'W', title: 'Wins', value: (p) => String(p.wins) },
  { label: 'L', title: 'Losses', value: (p) => String(p.losses) },
  { label: 'Win%', title: 'Win percentage', value: (p) => percent(p.winPct) },
  { label: 'Pts', title: 'Points, sink points included', value: (p) => String(p.points) },
  { label: 'PPG', title: 'Points per game', value: (p) => perGame(p.pointsPerGame, 1) },
  { label: 'Sinks', title: 'Sinks', value: (p) => String(p.sinks) },
  { label: 'S/G', title: 'Sinks per game', value: (p) => perGame(p.sinksPerGame, 2) },
];

const PAIR_COLUMNS: Array<Column<PartnershipStats>> = [
  { label: 'GP', title: 'Games played together', value: (p) => String(p.gamesPlayed) },
  { label: 'W', title: 'Wins', value: (p) => String(p.wins) },
  { label: 'L', title: 'Losses', value: (p) => String(p.losses) },
  { label: 'Win%', title: 'Win percentage', value: (p) => percent(p.winPct) },
  {
    label: 'Pts',
    title: 'Both players’ points, sink points included',
    value: (p) => String(p.points),
  },
  { label: 'Sinks', title: 'Both players’ sinks', value: (p) => String(p.sinks) },
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
  const pairStats = useQuery({
    queryKey: ['stats', leagueId, 'partnerships', scope],
    queryFn: () => getPartnershipStats(leagueId, scope),
  });
  const players = stats.data ?? [];
  const pairs = pairStats.data ?? [];

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Stats' }} />
      <ScopeTabs value={scope} onChange={setScope} />
      <Text style={styles.muted}>
        {SCOPE_NOTES[scope]} A game counts once all four players confirm it.
      </Text>
      {(stats.isError || pairStats.isError) && (
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
            <HeaderRow first="Player" firstStyle={styles.name} columns={COLUMNS} />
            {players.map((p) => (
              <View key={p.membershipId} style={styles.row} testID={`stats-row-${p.membershipId}`}>
                <Link
                  href={{ pathname: '/players/[mid]', params: { mid: p.membershipId } }}
                  style={[styles.name, styles.link]}
                >
                  {p.displayName}
                  {p.membershipId === membership.id ? ' (you)' : ''}
                </Link>
                <Cells row={p} columns={COLUMNS} />
              </View>
            ))}
          </View>
        </ScrollView>
      )}
      {pairs.length > 0 && (
        <>
          <Text style={styles.section}>Partnerships</Text>
          <Text style={styles.muted}>Each pair’s games on the same side, subs included.</Text>
          <ScrollView horizontal>
            <View testID="partnerships-table">
              <HeaderRow first="Pair" firstStyle={styles.pair} columns={PAIR_COLUMNS} />
              {pairs.map((p) => {
                const key = pairKey(p.players[0].membershipId, p.players[1].membershipId);
                return (
                  <View key={key} style={styles.row} testID={`partnership-row-${key}`}>
                    <Text style={styles.pair}>
                      {p.players.map((x, i) => (
                        <Fragment key={x.membershipId}>
                          {i > 0 && ' & '}
                          <Link
                            href={{ pathname: '/players/[mid]', params: { mid: x.membershipId } }}
                            style={styles.link}
                          >
                            {x.displayName}
                            {x.membershipId === membership.id ? ' (you)' : ''}
                          </Link>
                        </Fragment>
                      ))}
                    </Text>
                    <Cells row={p} columns={PAIR_COLUMNS} />
                  </View>
                );
              })}
            </View>
          </ScrollView>
        </>
      )}
    </ScrollView>
  );
}

type HeaderRowProps<T> = {
  first: string;
  firstStyle: TextStyle;
  columns: Array<Column<T>>;
};

function HeaderRow<T>({ first, firstStyle, columns }: HeaderRowProps<T>) {
  return (
    <View style={styles.row}>
      <Text style={[firstStyle, styles.heading]}>{first}</Text>
      {columns.map((c) => (
        <Text key={c.label} style={[styles.cell, styles.heading]} aria-label={c.title}>
          {c.label}
        </Text>
      ))}
    </View>
  );
}

function Cells<T>({ row, columns }: { row: T; columns: Array<Column<T>> }) {
  return (
    <>
      {columns.map((c) => (
        <Text key={c.label} style={styles.cell}>
          {c.value(row)}
        </Text>
      ))}
    </>
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
  pair: { width: 220, paddingRight: 8 },
  cell: { width: 56, textAlign: 'right', fontVariant: ['tabular-nums'] },
  heading: { fontWeight: '700' },
  section: { fontSize: 18, fontWeight: '700' },
  link: { color: '#1d4ed8' },
  muted: { color: '#555' },
  error: { color: '#b91c1c' },
});
