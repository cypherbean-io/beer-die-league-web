import type { MyMembership } from '@beer-die/core';
import { type Href, Link, Redirect, Stack } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { currentMembership, useMe, useSignOut } from '../../src/api/hooks';
import { colors, fonts, space } from '../../src/theme';
import { Button, Card, Screen, TabHeader, Text, textStyles } from '../../src/ui';

type Entry = { href: Href; label: string; detail: string; testID: string };

const EVERYONE: Entry[] = [
  {
    href: '/seasons',
    label: 'Seasons',
    detail: 'Teams, schedules and standings',
    testID: 'seasons-link',
  },
  { href: '/members', label: 'Members', detail: 'Who plays in the league', testID: 'members-link' },
  {
    href: '/audit',
    label: 'League log',
    detail: 'Every commissioner action',
    testID: 'audit-link',
  },
];

const COMMISSIONER: Entry[] = [
  {
    href: '/overrides',
    label: 'Games to review',
    detail: 'Results that break the rules',
    testID: 'overrides-link',
  },
  {
    href: '/invites',
    label: 'Invite players',
    detail: 'Links to join the league',
    testID: 'invites-link',
  },
  {
    href: '/league-settings',
    label: 'Rules and settings',
    detail: 'Scoring and the confirmation window',
    testID: 'league-settings-link',
  },
];

// Everything about the league besides its games and stats, and the signed-in account.
export default function League() {
  const me = useMe();
  const membership = currentMembership(me.data);

  if (me.data === null) return <Redirect href="/sign-in" />;
  if (me.data && membership?.status !== 'approved') return <Redirect href="/" />;
  if (!me.data || !membership) return null;
  return <LeagueHub membership={membership} email={me.data.user.email} />;
}

function LeagueHub({ membership, email }: { membership: MyMembership; email: string }) {
  const signOut = useSignOut();
  return (
    <>
      <Stack.Screen options={{ title: 'League' }} />
      <TabHeader title="League" />
      <Screen>
        <Text style={textStyles.kicker}>{membership.leagueName}</Text>
        <Menu entries={EVERYONE} />
        {membership.role === 'commissioner' && (
          <>
            <Text style={textStyles.kicker}>Commissioner</Text>
            <Menu entries={COMMISSIONER} />
          </>
        )}
        <Text style={textStyles.kicker}>You</Text>
        <Card style={styles.menu}>
          <MenuRow
            entry={{
              href: '/account',
              label: 'Account',
              detail: 'Your name, sessions and data',
              testID: 'account-link',
            }}
            first
          />
        </Card>
        <Text testID="signed-in-as" style={textStyles.muted}>
          Signed in as {email}
        </Text>
        <Button
          testID="sign-out"
          label="Sign out"
          variant="secondary"
          disabled={signOut.isPending}
          onPress={() => signOut.mutate()}
        />
      </Screen>
    </>
  );
}

function Menu({ entries }: { entries: Entry[] }) {
  return (
    <Card style={styles.menu}>
      {entries.map((entry, i) => (
        <MenuRow key={entry.testID} entry={entry} first={i === 0} />
      ))}
    </Card>
  );
}

function MenuRow({ entry, first }: { entry: Entry; first: boolean }) {
  return (
    <Link href={entry.href} asChild>
      <Pressable
        testID={entry.testID}
        role="link"
        style={StyleSheet.flatten([styles.row, !first && styles.divided])}
      >
        <View style={styles.rowText}>
          <Text style={styles.label}>{entry.label}</Text>
          <Text style={styles.detail}>{entry.detail}</Text>
        </View>
        <Text style={styles.chevron} aria-hidden>
          ›
        </Text>
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  menu: { padding: 0, gap: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 60,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.md,
  },
  divided: { borderTopWidth: 1, borderColor: colors.divider },
  rowText: { flex: 1, gap: 2 },
  label: { fontWeight: '600', fontSize: 17 },
  detail: { color: colors.muted, fontSize: 14 },
  chevron: { fontFamily: fonts.display, fontWeight: '600', fontSize: 26, color: colors.muted },
});
