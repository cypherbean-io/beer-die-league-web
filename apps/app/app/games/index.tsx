import { Redirect, Stack } from 'expo-router';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { currentMembership, useMe } from '../../src/api/hooks';
import { GameList } from '../../src/gameList';

export default function Games() {
  const me = useMe();
  const membership = currentMembership(me.data);

  if (me.data === null) return <Redirect href="/sign-in" />;
  if (me.data && membership?.status !== 'approved') return <Redirect href="/" />;
  if (!membership) return null;
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Games' }} />
      <Text style={styles.muted}>
        Every game recorded in the league, newest first, whether or not it counts yet.
      </Text>
      <GameList leagueId={membership.leagueId} empty="No games recorded yet." />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 12, maxWidth: 560 },
  muted: { color: '#555' },
});
