import { DisplayName, type MeResponse, type MyMembership, SignInCode } from '@beer-die/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Redirect, Stack } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { ApiRequestError, deleteAccount, requestDeletionCode, updateMe } from '../src/api/client';
import {
  currentMembership,
  forgetSession,
  useMe,
  useSignOut,
  useSignOutEverywhere,
} from '../src/api/hooks';
import { Button } from '../src/ui';

function settingsMessageFor(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'NAME_TAKEN') return 'That name is taken in your league. Try another.';
    if (error.code === 'RATE_LIMITED') return 'Too many name changes. Try again in an hour.';
    if (error.code === 'TOO_MANY_NAME_CHANGES') {
      return 'You’ve changed your name too many times lately. Go back to a name you used before, or try again later.';
    }
    if (error.code === 'VALIDATION') return 'Check your display name and try again.';
  }
  return 'Couldn’t save. Check your connection and try again.';
}

function messageFor(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'LAST_COMMISSIONER') {
      return 'A league needs at least one commissioner. Promote someone else in each league you run, then enter the same code again.';
    }
    if (error.code === 'INVALID_CODE') return 'That code is wrong or has expired.';
    if (error.code === 'RATE_LIMITED') return 'Too many attempts. Wait a while and try again.';
  }
  return 'Something went wrong. Check your connection and try again.';
}

export default function Account() {
  const queryClient = useQueryClient();
  const me = useMe();
  const [keepDisplayName, setKeepDisplayName] = useState(false);
  const [code, setCode] = useState('');
  // Answers the request for a deletion code, and is null until one is asked for. The mailed
  // code works only with it, so it stays in memory: after a reload, ask for a new code.
  const [requestToken, setRequestToken] = useState<string | null>(null);
  // Being signed in isn't enough to delete the account: the server also wants a code it mails
  // to the account's address, so someone holding only this session can't do it.
  const sendCode = useMutation({
    mutationFn: requestDeletionCode,
    onSuccess: (token) => {
      setCode('');
      setRequestToken(token);
    },
  });
  // Every session is gone afterwards, so the caller is signed out.
  const remove = useMutation({
    mutationFn: (token: string) => deleteAccount({ keepDisplayName, code, requestToken: token }),
    onSuccess: () => forgetSession(queryClient),
  });
  const signOut = useSignOut();
  const signOutEverywhere = useSignOutEverywhere();
  // Same validator as the server, for instant feedback; the server checks again.
  const codeValid = SignInCode.safeParse(code).success;
  const cancelDelete = () => {
    remove.reset();
    setRequestToken(null);
  };

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
      <Text>
        Lost a device, or think someone else is signed in as you? This signs you out everywhere,
        here included.
      </Text>
      <Button
        testID="account-sign-out-everywhere"
        label={signOutEverywhere.isPending ? 'Signing out…' : 'Sign out everywhere'}
        variant="secondary"
        disabled={signOutEverywhere.isPending}
        onPress={() => signOutEverywhere.mutate()}
      />
      {signOutEverywhere.isError && (
        <Text testID="sign-out-everywhere-error" style={styles.error}>
          Couldn’t sign you out everywhere. Check your connection and try again.
        </Text>
      )}
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
      {requestToken ? (
        <View style={styles.confirm}>
          <Text nativeID="delete-code-label">
            We emailed a code to {me.data.user.email}. Enter it to delete your account. This
            can&apos;t be undone.
          </Text>
          <TextInput
            testID="delete-account-code-input"
            aria-labelledby="delete-code-label"
            style={styles.input}
            value={code}
            // As mailed, "ABCD-EFGH"; the server reads it without the hyphen or in lower case too.
            onChangeText={(text) => setCode(text.toUpperCase().replace(/[^0-9A-Z-]/g, ''))}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={9}
          />
          <View style={styles.row}>
            <Button
              testID="confirm-delete-account"
              label={remove.isPending ? 'Deleting…' : 'Delete my account'}
              disabled={!codeValid || remove.isPending}
              onPress={() => remove.mutate(requestToken)}
            />
            <Button label="Cancel" variant="secondary" onPress={cancelDelete} />
          </View>
          {remove.isError && (
            <Text testID="delete-account-error" style={styles.error}>
              {messageFor(remove.error)}
            </Text>
          )}
        </View>
      ) : (
        <Button
          testID="delete-account"
          label={sendCode.isPending ? 'Sending a code…' : 'Delete account'}
          variant="secondary"
          disabled={sendCode.isPending}
          onPress={() => sendCode.mutate()}
        />
      )}
      {sendCode.isError && !requestToken && (
        <Text testID="delete-account-code-error" style={styles.error}>
          {messageFor(sendCode.error)}
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
