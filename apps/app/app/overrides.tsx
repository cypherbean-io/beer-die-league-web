import { Redirect, Stack } from 'expo-router';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { currentMembership, useMe } from '../src/api/hooks';
import { GameList } from '../src/gameList';

// Commissioners only: games sent for review because they break the league rules.
export default function Overrides() {
  const me = useMe();
  const membership = currentMembership(me.data);

  if (me.data === null) return <Redirect href="/sign-in" />;
  if (me.data && (membership?.status !== 'approved' || membership.role !== 'commissioner')) {
    return <Redirect href="/" />;
  }
  if (!membership) return null;
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Games to review' }} />
      <Text style={styles.muted}>
        Games that break the league rules and were sent for a commissioner&apos;s review. Open one
        to approve or reject it. A game counts only if it is approved and all four players confirm
        it.
      </Text>
      <GameList leagueId={membership.leagueId} awaiting="override" empty="Nothing to review." />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 12, maxWidth: 560 },
  muted: { color: '#555' },
});
