import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Redirect, Stack } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { ApiRequestError, deleteAccount } from '../src/api/client';
import { useMe } from '../src/api/hooks';
import { Button } from '../src/ui';

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
    onSuccess: () => {
      queryClient.clear();
      queryClient.setQueryData(['me'], null);
    },
  });

  if (me.data === null) return <Redirect href="/sign-in" />;
  if (!me.data) return null;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Account' }} />
      <Text testID="account-email">Signed in as {me.data.user.email}</Text>
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

const styles = StyleSheet.create({
  container: { padding: 24, gap: 12, maxWidth: 560 },
  heading: { fontSize: 18, fontWeight: '700', marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  confirm: { gap: 8, paddingLeft: 12 },
  grow: { flex: 1 },
  error: { color: '#b91c1c' },
});
