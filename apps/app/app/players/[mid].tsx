import type { MyMembership, PlayerStats, StatsScope } from '@beer-die/core';
import { useQuery } from '@tanstack/react-query';
import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiRequestError, getPlayerProfile } from '../../src/api/client';
import { currentMembership, useMe } from '../../src/api/hooks';
import { percent, perGame, ScopeTabs, scopeNote, useStatsSeasons } from '../../src/stats';

const LINES: Array<{ label: string; value: (p: PlayerStats) => string }> = [
  { label: 'Games played', value: (p) => String(p.gamesPlayed) },
  { label: 'Wins', value: (p) => String(p.wins) },
  { label: 'Losses', value: (p) => String(p.losses) },
  { label: 'Win %', value: (p) => percent(p.winPct) },
  { label: 'Points (sink points included)', value: (p) => String(p.points) },
  { label: 'Points per game', value: (p) => perGame(p.pointsPerGame, 1) },
  { label: 'Sinks', value: (p) => String(p.sinks) },
  { label: 'Sinks per game', value: (p) => perGame(p.sinksPerGame, 2) },
];

export default function PlayerProfile() {
  const { mid } = useLocalSearchParams<{ mid: string }>();
  const me = useMe();
  const membership = currentMembership(me.data);

  if (me.data === null) return <Redirect href="/sign-in" />;
  if (me.data && membership?.status !== 'approved') return <Redirect href="/" />;
  if (!membership) return null;
  return <Profile membership={membership} membershipId={mid} />;
}

function Profile({ membership, membershipId }: { membership: MyMembership; membershipId: string }) {
  const { leagueId } = membership;
  const [scope, setScope] = useState<StatsScope>('combined');
  const seasons = useStatsSeasons(leagueId);
  const profile = useQuery({
    queryKey: ['stats', leagueId, 'player', membershipId, scope],
    queryFn: () => getPlayerProfile(leagueId, membershipId, scope),
  });
  const player = profile.data;
  const missing = profile.error instanceof ApiRequestError && profile.error.status === 404;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: player?.displayName ?? 'Player' }} />
      {player && (
        <Text testID="profile-name" style={styles.title}>
          {player.displayName}
          {player.membershipId === membership.id ? ' (you)' : ''}
        </Text>
      )}
      <ScopeTabs value={scope} seasons={seasons} onChange={setScope} />
      <Text style={styles.muted}>
        {scopeNote(scope, seasons)} A game counts once all four players confirm it.
      </Text>
      {missing && <Text style={styles.error}>That player isn’t in this league.</Text>}
      {profile.isError && !missing && (
        <Text style={styles.error}>
          Couldn’t load the stats. Check your connection and try again.
        </Text>
      )}
      {player && (
        <View testID="profile-stats">
          {LINES.map((l) => (
            <View key={l.label} style={styles.line}>
              <Text>{l.label}</Text>
              <Text style={styles.value}>{l.value(player)}</Text>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 16, maxWidth: 480 },
  title: { fontSize: 22, fontWeight: '700' },
  line: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderColor: '#eee',
  },
  value: { fontWeight: '600', fontVariant: ['tabular-nums'] },
  muted: { color: '#555' },
  error: { color: '#b91c1c' },
});
