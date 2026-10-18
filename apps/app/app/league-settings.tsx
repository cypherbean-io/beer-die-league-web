import {
  type League,
  type LeagueSettings,
  type Rules,
  RulesBody,
  SettingsBody,
} from '@beer-die/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Redirect, Stack } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { ApiRequestError, getLeague, updateRules, updateSettings } from '../src/api/client';
import { currentMembership, useMe } from '../src/api/hooks';
import { Button } from '../src/ui';

function messageFor(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'FORBIDDEN') return 'Only a commissioner can do that.';
    if (error.code === 'VALIDATION') return 'Enter whole numbers in the ranges shown.';
  }
  return 'Something went wrong. Check your connection and try again.';
}

// Digits only; anything else (including an empty field) is NaN, which validation refuses.
const toInt = (text: string) => (/^[0-9]+$/.test(text) ? Number(text) : Number.NaN);

// Only the fields that differ from what the server holds, so saving one field never
// overwrites another commissioner's concurrent edit to a different one.
function changes<T extends Record<string, number | boolean>>(saved: T, draft: T): Partial<T> {
  const keys = Object.keys(draft) as Array<keyof T>;
  return Object.fromEntries(
    keys.filter((key) => !Object.is(draft[key], saved[key])).map((key) => [key, draft[key]]),
  ) as Partial<T>;
}

export default function LeagueSettingsScreen() {
  const me = useMe();
  const membership = currentMembership(me.data);

  if (me.data === null) return <Redirect href="/sign-in" />;
  if (me.data && (membership?.status !== 'approved' || membership.role !== 'commissioner')) {
    return <Redirect href="/" />;
  }
  if (!membership) return null;
  return <Editor leagueId={membership.leagueId} />;
}

function Editor({ leagueId }: { leagueId: string }) {
  const league = useQuery({ queryKey: ['league', leagueId], queryFn: () => getLeague(leagueId) });

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Rules and settings' }} />
      {league.isError && <Text style={styles.error}>{messageFor(league.error)}</Text>}
      {league.data && (
        <>
          {/* Keyed on the saved values, so a successful save resets the form to them. */}
          <RulesForm key={JSON.stringify(league.data.rules)} league={league.data} />
          <SettingsForm
            key={`${league.data.confirmationWindowDays}/${league.data.exhibitionCorrectionWindowDays}`}
            league={league.data}
          />
        </>
      )}
    </ScrollView>
  );
}

function useSave<P>(leagueId: string, send: (patch: P) => Promise<League>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (updated) => queryClient.setQueryData(['league', leagueId], updated),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['audit', leagueId] }),
  });
}

function RulesForm({ league }: { league: League }) {
  const saved = league.rules;
  const [targetScore, setTargetScore] = useState(String(saved.targetScore));
  const [winBy, setWinBy] = useState(String(saved.winBy));
  const [sinkPoints, setSinkPoints] = useState(String(saved.sinkPoints));
  const [sinkEndsGame, setSinkEndsGame] = useState(saved.sinkEndsGame);
  const save = useSave(league.id, (patch: Partial<Rules>) => updateRules(league.id, patch));

  const draft: Rules = {
    targetScore: toInt(targetScore),
    winBy: toInt(winBy),
    sinkPoints: toInt(sinkPoints),
    sinkEndsGame,
  };
  const patch = changes(saved, draft);
  const dirty = Object.keys(patch).length > 0;
  // Same validator as the server, for instant feedback; the server checks again.
  const valid = RulesBody.safeParse(patch).success;

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>Rules</Text>
      <Text style={styles.muted}>
        Changes apply to games submitted from now on. A game already submitted keeps the rules it
        was submitted under.
      </Text>
      <NumberField
        id="target-score"
        label="Target score (1–99)"
        value={targetScore}
        onChange={setTargetScore}
      />
      <NumberField id="win-by" label="Win by (1–99)" value={winBy} onChange={setWinBy} />
      <NumberField
        id="sink-points"
        label="Points for a sink (0–99)"
        value={sinkPoints}
        onChange={setSinkPoints}
      />
      <View style={styles.row}>
        <Text style={[styles.label, styles.grow]}>A sink ends the game</Text>
        <Switch
          testID="sink-ends-game"
          aria-label="A sink ends the game"
          value={sinkEndsGame}
          onValueChange={setSinkEndsGame}
        />
      </View>
      {dirty && !valid && (
        <Text style={styles.error}>Enter whole numbers in the ranges shown.</Text>
      )}
      <Button
        testID="save-rules"
        label={save.isPending ? 'Saving…' : 'Save rules'}
        disabled={!dirty || !valid || save.isPending}
        onPress={() => save.mutate(patch)}
      />
      {save.isError && <Text style={styles.error}>{messageFor(save.error)}</Text>}
    </View>
  );
}

function SettingsForm({ league }: { league: League }) {
  const saved: LeagueSettings = {
    confirmationWindowDays: league.confirmationWindowDays,
    exhibitionCorrectionWindowDays: league.exhibitionCorrectionWindowDays,
  };
  const [confirmation, setConfirmation] = useState(String(saved.confirmationWindowDays));
  const [correction, setCorrection] = useState(String(saved.exhibitionCorrectionWindowDays));
  const save = useSave(league.id, (patch: Partial<LeagueSettings>) =>
    updateSettings(league.id, patch),
  );

  const patch = changes(saved, {
    confirmationWindowDays: toInt(confirmation),
    exhibitionCorrectionWindowDays: toInt(correction),
  });
  const dirty = Object.keys(patch).length > 0;
  const valid = SettingsBody.safeParse(patch).success;

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>Settings</Text>
      <NumberField
        id="confirmation-window"
        label="Days players have to confirm a game (1–30)"
        value={confirmation}
        onChange={setConfirmation}
      />
      <NumberField
        id="correction-window"
        label="Days an exhibition game can be reopened after it is confirmed (0–365)"
        value={correction}
        onChange={setCorrection}
      />
      <Text style={styles.muted}>
        A game&apos;s confirmation window is set when it is submitted, so changing it doesn&apos;t
        affect games already waiting for confirmation.
      </Text>
      {dirty && !valid && (
        <Text style={styles.error}>Enter whole numbers in the ranges shown.</Text>
      )}
      <Button
        testID="save-settings"
        label={save.isPending ? 'Saving…' : 'Save settings'}
        disabled={!dirty || !valid || save.isPending}
        onPress={() => save.mutate(patch)}
      />
      {save.isError && <Text style={styles.error}>{messageFor(save.error)}</Text>}
    </View>
  );
}

type NumberFieldProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
};

function NumberField({ id, label, value, onChange }: NumberFieldProps) {
  return (
    <View style={styles.field}>
      <Text nativeID={`${id}-label`} style={styles.label}>
        {label}
      </Text>
      <TextInput
        testID={`${id}-input`}
        aria-labelledby={`${id}-label`}
        style={styles.input}
        value={value}
        onChangeText={(text) => onChange(text.replace(/\D/g, '').slice(0, 3))}
        inputMode="numeric"
        maxLength={3}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 24, maxWidth: 560 },
  section: { gap: 12 },
  heading: { fontSize: 18, fontWeight: '700' },
  field: { gap: 4 },
  label: { fontSize: 16 },
  input: { borderWidth: 1, borderColor: '#888', borderRadius: 8, padding: 10, fontSize: 18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  grow: { flex: 1 },
  muted: { color: '#555' },
  error: { color: '#b91c1c' },
});
