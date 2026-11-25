import { Redirect, Stack } from 'expo-router';
import { currentMembership, useMe } from '../../src/api/hooks';
import { GameList } from '../../src/gameList';
import { Screen, TabHeader, Text, textStyles } from '../../src/ui';

export default function Games() {
  const me = useMe();
  const membership = currentMembership(me.data);

  if (me.data === null) return <Redirect href="/sign-in" />;
  if (me.data && membership?.status !== 'approved') return <Redirect href="/" />;
  if (!membership) return null;
  return (
    <>
      <Stack.Screen options={{ title: 'Games' }} />
      <TabHeader title="Games" />
      <Screen>
        <Text style={textStyles.muted}>
          Every game recorded in the league, newest first, whether or not it counts yet.
        </Text>
        <GameList leagueId={membership.leagueId} empty="No games recorded yet." />
      </Screen>
    </>
  );
}
