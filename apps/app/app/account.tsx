import { DisplayName, type MeResponse, type MyMembership } from '@beer-die/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Redirect, Stack } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { ApiRequestError, deleteAccount, updateMe } from '../src/api/client';
import { currentMembership, forgetSession, useMe, useSignOut } from '../src/api/hooks';
import { Button } from '../src/ui';

function settingsMessageFor(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'NAME_TAKEN') return 'That name is taken in your league. Try another.';
    if (error.code === 'RATE_LIMITED') return 'Too many name changes. Try again in an hour.';
    if (error.code === 'VALIDATION') return 'Check your display name and try again.';
  }
  return 'Couldn’t save. Check your connection and try again.';
}

function messageFor(error: unknown): string {
  if (error instanceof ApiRequestError && error.code === 'LAST_COMMISSIONER') {
    return 'A league needs at least one commissioner. Promote someone else in each league you run before you delete your account.';
  }
  return 'Something went wrong. Check your connection and try again.';
}

export default function Account() {
  const queryClient = useQueryClient();
  const me = useMe();
  const [confirming, setConfirming] = useState(false);
  const [keepDisplayName, setKeepDisplayName] = useState(false);
  // Every session is gone afterwards, so the caller is signed out.
  const remove = useMutation({
    mutationFn: () => deleteAccount(keepDisplayName),
    onSuccess: () => forgetSession(queryClient),
  });
  const signOut = useSignOut();

  if (me.data === null) return <Redirect href="/sign-in" />;
  if (!me.data) return null;
  const membership = currentMembership(me.data);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Account' }} />
      <Text testID="account-email">Signed in as {me.data.user.email}</Text>
      {membership && <Settings membership={membership} />}
      <Button
        testID="account-sign-out"
        label={signOut.isPending ? 'Signing out…' : 'Sign out'}
        variant="secondary"
        disabled={signOut.isPending}
        onPress={() => signOut.mutate()}
      />
      <Text style={styles.heading}>Delete account</Text>
      <Text>
        Your email, sign-in sessions, and pending mail are erased, and you leave every league. Your
        games still awaiting confirmation are voided. Your confirmed games still count, so other
        players&apos; records don&apos;t change. They show you as &quot;Deleted player&quot; unless
        you keep your name on them. Backups keep deleted data for up to 14 days.
      </Text>
      <View style={styles.row}>
        <Text style={styles.grow}>Keep my name on my games</Text>
        <Switch
          testID="keep-display-name"
          aria-label="Keep my name on my games"
          value={keepDisplayName}
          onValueChange={setKeepDisplayName}
        />
      </View>
      {confirming ? (
        <View style={styles.confirm}>
          <Text>Delete your account? This can&apos;t be undone.</Text>
          <View style={styles.row}>
            <Button
              testID="confirm-delete-account"
              label={remove.isPending ? 'Deleting…' : 'Delete'}
              disabled={remove.isPending}
              onPress={() => remove.mutate(undefined, { onSettled: () => setConfirming(false) })}
            />
            <Button label="Cancel" variant="secondary" onPress={() => setConfirming(false)} />
          </View>
        </View>
      ) : (
        <Button
          testID="delete-account"
          label="Delete account"
          variant="secondary"
          onPress={() => setConfirming(true)}
        />
      )}
      {remove.isError && (
        <Text testID="delete-account-error" style={styles.error}>
          {messageFor(remove.error)}
        </Text>
      )}
    </ScrollView>
  );
}

// My display name and email setting. Both apply in every league I belong to.
function Settings({ membership }: { membership: MyMembership }) {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(membership.displayName);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: updateMe,
    onSuccess: (me: MeResponse) => {
      setSaved(true);
      queryClient.setQueryData(['me'], me);
      // Names appear on games, stats, and the member list.
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    },
  });

  // Same validator as the server, for instant feedback; the server checks again.
  const parsed = DisplayName.safeParse(displayName);
  const hint =
    displayName.length > 0 && !parsed.success ? parsed.error.issues[0]?.message : undefined;
  const unchanged = parsed.success && parsed.data === membership.displayName;

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>Settings</Text>
      <Text nativeID="account-name-label">Your display name, which other players see</Text>
      <TextInput
        testID="account-display-name-input"
        aria-labelledby="account-name-label"
        style={styles.input}
        value={displayName}
        onChangeText={(text) => {
          setDisplayName(text);
          setSaved(false);
        }}
        autoComplete="nickname"
      />
      {hint && (
        <Text testID="account-display-name-hint" style={styles.hint}>
          {hint}
        </Text>
      )}
      <Button
        testID="save-display-name"
        label={save.isPending ? 'Saving…' : 'Save name'}
        disabled={!parsed.success || unchanged || save.isPending}
        onPress={() => parsed.success && save.mutate({ displayName: parsed.data })}
      />
      <View style={styles.row}>
        <Text style={styles.grow} nativeID="email-notifications-label">
          Email me when a game I played is recorded or corrected
        </Text>
        <Switch
          testID="email-notifications"
          aria-labelledby="email-notifications-label"
          value={membership.emailNotifications}
          disabled={save.isPending}
          onValueChange={(emailNotifications) => save.mutate({ emailNotifications })}
        />
      </View>
      {saved && !save.isPending && (
        <Text testID="settings-saved" style={styles.notice}>
          Saved.
        </Text>
      )}
      {save.isError && (
        <Text testID="settings-error" style={styles.error}>
          {settingsMessageFor(save.error)}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 12, maxWidth: 560 },
  heading: { fontSize: 18, fontWeight: '700', marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  confirm: { gap: 8, paddingLeft: 12 },
  grow: { flex: 1 },
  section: { gap: 8 },
  input: { borderWidth: 1, borderColor: '#999', borderRadius: 6, padding: 10, fontSize: 16 },
  hint: { color: '#555' },
  notice: { color: '#14532d' },
  error: { color: '#b91c1c' },
});
