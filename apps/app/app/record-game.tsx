import {
  checkRules,
  checkStructure,
  type Member,
  type MyMembership,
  type PlayerLine,
  type RuleViolation,
  type Side,
  type StructureError,
  type SubmitGameBody,
} from '@beer-die/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, Redirect, Stack } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiRequestError, getLeague, getMembers, submitGame } from '../src/api/client';
import { currentMembership, useMe } from '../src/api/hooks';
import { Button } from '../src/ui';

const MAX_LINE_VALUE = 99;

// Seats 0 and 1 are side A; seats 2 and 3 are side B. The submitter always holds seat 0,
// because the server records a game only from one of its players.
type Seat = { membershipId: string | null; points: number; sinks: number };

const SEATS_BY_SIDE: Record<Side, [number, number]> = { A: [0, 1], B: [2, 3] };
const sideOf = (seat: number): Side => (seat < 2 ? 'A' : 'B');

function messageFor(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'RULES_VIOLATION') {
      return 'This result breaks the league rules, which may have just changed. Check the numbers, or submit it for commissioner review.';
    }
    if (error.code === 'IDEMPOTENCY_MISMATCH') {
      return 'This game was already submitted with different numbers.';
    }
    // Fixed server messages, which never contain user data.
    if (error.code === 'VALIDATION' || error.code === 'FORBIDDEN') return `${error.message}.`;
  }
  return 'Couldn’t submit the game. Check your connection and try again. It won’t be recorded twice.';
}

export default function RecordGame() {
  const me = useMe();
  const membership = currentMembership(me.data);

  if (me.data === null) return <Redirect href="/sign-in" />;
  if (me.data && membership?.status !== 'approved') return <Redirect href="/" />;
  if (!membership) return null;
  return <RecordForm membership={membership} />;
}

function RecordForm({ membership }: { membership: MyMembership }) {
  const { leagueId } = membership;
  const league = useQuery({ queryKey: ['league', leagueId], queryFn: () => getLeague(leagueId) });
  const members = useQuery({
    queryKey: ['members', leagueId],
    queryFn: () => getMembers(leagueId),
  });
  // One key and play time per form, so submitting again after a failure resends the same
  // game, which the server records at most once.
  const [draft] = useState(() => ({
    idempotencyKey: crypto.randomUUID(),
    playedAt: new Date().toISOString(),
  }));
  const [seats, setSeats] = useState<Seat[]>(() => [
    { membershipId: membership.id, points: 0, sinks: 0 },
    { membershipId: null, points: 0, sinks: 0 },
    { membershipId: null, points: 0, sinks: 0 },
    { membershipId: null, points: 0, sinks: 0 },
  ]);
  const [winner, setWinner] = useState<Side | null>(null);
  const [picking, setPicking] = useState<number | null>(null);
  const submit = useMutation({
    mutationFn: (body: SubmitGameBody) => submitGame(leagueId, body),
  });

  if (submit.isSuccess) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: 'Record game' }} />
        <Text testID="game-recorded" style={styles.heading}>
          Game recorded
        </Text>
        <Text>It counts once the other three players confirm it.</Text>
        <Link href="/" style={styles.link}>
          Back to home
        </Link>
      </View>
    );
  }

  const rules = league.data?.rules;
  const approved = members.data?.filter((m) => m.status === 'approved') ?? [];
  const nameOf = (id: string | null) => approved.find((m) => m.id === id)?.displayName;
  const update = (index: number, patch: Partial<Seat>) =>
    setSeats((current) => current.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  // Same validators as the server, for instant feedback; the server checks again. Empty
  // seats get placeholder ids so they aren't reported as the same player.
  const lines: PlayerLine[] = seats.map((s, i) => ({
    membershipId: s.membershipId ?? `empty-seat-${i}`,
    side: sideOf(i),
    points: s.points,
    sinks: s.sinks,
  }));
  const allSeated = seats.every((s) => s.membershipId !== null);
  const structure = rules ? checkStructure(rules, { players: lines, winner }) : [];
  const violations =
    rules && winner && structure.length === 0 ? checkRules(rules, { players: lines, winner }) : [];
  const complete = rules !== undefined && allSeated && structure.length === 0;

  const send = (requestOverride: boolean) =>
    submit.mutate({
      ...draft,
      kind: 'exhibition',
      sides: {
        A: { players: SEATS_BY_SIDE.A.map((i) => lineOf(seats[i]!)) },
        B: { players: SEATS_BY_SIDE.B.map((i) => lineOf(seats[i]!)) },
      },
      winner: winner!,
      ...(requestOverride ? { requestOverride } : {}),
    });

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Record game' }} />
      <Text style={styles.muted}>
        Exhibition game. Enter each player&apos;s final points (sink points included) and sinks.
      </Text>
      {(league.isError || members.isError) && (
        <Text style={styles.error}>Couldn’t load the league. Check your connection.</Text>
      )}
      {(['A', 'B'] as const).map((side) => (
        <View key={side} style={styles.section} testID={`side-${side}`}>
          <Text style={styles.heading}>Side {side}</Text>
          {SEATS_BY_SIDE[side].map((i) => (
            <SeatRow
              key={i}
              index={i}
              seat={seats[i]!}
              name={i === 0 ? `${membership.displayName} (you)` : nameOf(seats[i]!.membershipId)}
              picking={picking === i}
              onPick={() => setPicking(picking === i ? null : i)}
              onChange={(patch) => update(i, patch)}
            />
          ))}
          {picking !== null && sideOf(picking) === side && (
            <MemberPicker
              members={approved.filter((m) => !seats.some((s) => s.membershipId === m.id))}
              onChoose={(m) => {
                update(picking, { membershipId: m.id });
                setPicking(null);
              }}
            />
          )}
          <Button
            testID={`winner-${side}`}
            label={winner === side ? `Side ${side} won ✓` : `Side ${side} won`}
            variant={winner === side ? 'primary' : 'secondary'}
            onPress={() => setWinner(side)}
          />
        </View>
      ))}

      <Feedback
        allSeated={allSeated}
        winner={winner}
        structure={structure}
        violations={violations}
      />

      <Button
        testID="submit-game"
        label={submit.isPending ? 'Submitting…' : submit.isError ? 'Retry' : 'Submit game'}
        disabled={!complete || violations.length > 0 || submit.isPending}
        onPress={() => send(false)}
      />
      {complete && violations.length > 0 && (
        <Button
          testID="submit-for-review"
          label="Submit for commissioner review"
          variant="secondary"
          disabled={submit.isPending}
          onPress={() => send(true)}
        />
      )}
      {submit.isError && (
        <Text testID="submit-error" style={styles.error}>
          {messageFor(submit.error)}
        </Text>
      )}
    </ScrollView>
  );
}

function lineOf(seat: Seat) {
  return { membershipId: seat.membershipId!, points: seat.points, sinks: seat.sinks };
}

type SeatRowProps = {
  index: number;
  seat: Seat;
  name: string | undefined;
  picking: boolean;
  onPick: () => void;
  onChange: (patch: Partial<Seat>) => void;
};

function SeatRow({ index, seat, name, picking, onPick, onChange }: SeatRowProps) {
  const who = name ?? `Player ${index + 1}`;
  return (
    <View style={styles.seat} testID={`seat-${index}`}>
      {index === 0 ? (
        <Text style={styles.name}>{who}</Text>
      ) : (
        <Button
          testID={`seat-${index}-player`}
          label={picking ? 'Cancel' : (name ?? 'Choose player')}
          variant="secondary"
          onPress={onPick}
        />
      )}
      <View style={styles.row}>
        <Stepper
          testID={`seat-${index}-points`}
          label="Points"
          who={who}
          value={seat.points}
          onChange={(points) => onChange({ points })}
        />
        <Stepper
          testID={`seat-${index}-sinks`}
          label="Sinks"
          who={who}
          value={seat.sinks}
          onChange={(sinks) => onChange({ sinks })}
        />
      </View>
    </View>
  );
}

function MemberPicker({
  members,
  onChoose,
}: {
  members: Member[];
  onChoose: (member: Member) => void;
}) {
  if (members.length === 0) {
    return <Text style={styles.muted}>No other approved members to choose.</Text>;
  }
  return (
    <View style={styles.picker} testID="member-picker">
      {members.map((m) => (
        <Button key={m.id} label={m.displayName} variant="secondary" onPress={() => onChoose(m)} />
      ))}
    </View>
  );
}

type StepperProps = {
  testID: string;
  label: string;
  who: string;
  value: number;
  onChange: (value: number) => void;
};

function Stepper({ testID, label, who, value, onChange }: StepperProps) {
  return (
    <View style={styles.stepper}>
      <Text style={styles.muted}>{label}</Text>
      <View style={styles.row}>
        <Pressable
          testID={`${testID}-minus`}
          role="button"
          aria-label={`${who}: one less ${label.toLowerCase()}`}
          disabled={value <= 0}
          onPress={() => onChange(value - 1)}
          style={[styles.step, value <= 0 && styles.disabled]}
        >
          <Text style={styles.stepText}>−</Text>
        </Pressable>
        <Text testID={testID} style={styles.value}>
          {value}
        </Text>
        <Pressable
          testID={`${testID}-plus`}
          role="button"
          aria-label={`${who}: one more ${label.toLowerCase()}`}
          disabled={value >= MAX_LINE_VALUE}
          onPress={() => onChange(value + 1)}
          style={[styles.step, value >= MAX_LINE_VALUE && styles.disabled]}
        >
          <Text style={styles.stepText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

type FeedbackProps = {
  allSeated: boolean;
  winner: Side | null;
  structure: StructureError[];
  violations: RuleViolation[];
};

// What still stands between the form and a valid submission, most basic first.
function Feedback({ allSeated, winner, structure, violations }: FeedbackProps) {
  if (!allSeated) return <Text style={styles.muted}>Choose all four players.</Text>;
  const errors = structure.filter((e) => e.code !== 'MISSING_WINNER');
  if (errors.length > 0) {
    return (
      <View testID="structure-errors">
        {errors.map((e, i) => (
          <Text key={i} style={styles.error}>
            {e.message}
          </Text>
        ))}
      </View>
    );
  }
  if (winner === null) return <Text style={styles.muted}>Tap the side that won.</Text>;
  if (violations.length === 0) return null;
  return (
    <View testID="rule-violations" style={styles.violations}>
      <Text style={styles.error}>This result breaks the league rules:</Text>
      {violations.map((v) => (
        <Text key={v.code} style={styles.error}>
          • {v.message}
        </Text>
      ))}
      <Text style={styles.muted}>
        Fix the numbers, or submit it for a commissioner to review. It counts only if a commissioner
        approves it.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 16, maxWidth: 560 },
  section: { gap: 12 },
  heading: { fontSize: 18, fontWeight: '700' },
  seat: { gap: 8, paddingVertical: 4 },
  name: { fontSize: 16, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  picker: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stepper: { gap: 4 },
  step: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#1d4ed8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepText: { color: '#1d4ed8', fontSize: 24, fontWeight: '600' },
  value: { minWidth: 32, textAlign: 'center', fontSize: 22, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  violations: { gap: 4 },
  muted: { color: '#555' },
  error: { color: '#b91c1c' },
  link: { color: '#1d4ed8', padding: 8 },
});
