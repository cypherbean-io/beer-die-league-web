import {
  checkRules,
  checkStructure,
  type CorrectGameBody,
  type Game,
  type GameRevision,
  type Member,
  type MyMembership,
  type PlayerLine,
  type RuleViolation,
  type Side,
  type StructureError,
  type SubmitGameBody,
  type Team,
} from '@beer-die/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  ApiRequestError,
  correctGame,
  getInbox,
  getLeague,
  getMembers,
  getSeasons,
  getTeams,
  submitGame,
} from '../src/api/client';
import { currentMembership, useMe } from '../src/api/hooks';
import { Button } from '../src/ui';

const MAX_LINE_VALUE = 99;

// Seats 0 and 1 are side A; seats 2 and 3 are side B. The author's own seat is fixed (seat 0
// for a new game), because the server records a result only from one of its players.
type Seat = { membershipId: string | null; points: number; sinks: number };

// What the form sends, for a new game or a correction.
type Result = Omit<CorrectGameBody, 'baseRevisionId'>;

// A pending game being corrected, and the open revision whose numbers fill the form.
type Base = { game: Game; revision: GameRevision };

type Kind = Game['kind'];

// The team a side of a season game plays for. A new game also has its roster, which decides
// who is a sub; a correction keeps the game's teams and subs, so it needs none.
type SideTeam = { id: string; name: string; roster?: string[] };

const SEATS_BY_SIDE: Record<Side, [number, number]> = { A: [0, 1], B: [2, 3] };
const sideOf = (seat: number): Side => (seat < 2 ? 'A' : 'B');
const otherSide = (side: Side): Side => (side === 'A' ? 'B' : 'A');

const sideTeamOf = (team: Team): SideTeam => ({
  id: team.id,
  name: team.name,
  roster: team.players.map((p) => p.membershipId),
});

function messageFor(error: unknown, correcting: boolean): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'RULES_VIOLATION') {
      return correcting
        ? 'This result breaks the game’s rules. Check the numbers, or submit it for commissioner review.'
        : 'This result breaks the league rules, which may have just changed. Check the numbers, or submit it for commissioner review.';
    }
    if (error.code === 'IDEMPOTENCY_MISMATCH') {
      return 'This game was already submitted with different numbers.';
    }
    if (error.code === 'STALE_REVISION') {
      return 'This game changed after you opened it, so your correction wasn’t saved. Check the latest numbers in your inbox.';
    }
    if (error.code === 'WINDOW_CLOSED') {
      return 'The window to correct this game has closed, so it won’t count.';
    }
    if (error.code === 'SEASON_NOT_ACTIVE') {
      return 'The season isn’t active anymore, so this can’t be recorded as a season game. Record it as an exhibition game instead.';
    }
    // Fixed server messages, which never contain user data.
    if (error.code === 'VALIDATION' || error.code === 'FORBIDDEN') return `${error.message}.`;
  }
  return correcting
    ? 'Couldn’t send the correction. Check your connection and try again.'
    : 'Couldn’t submit the game. Check your connection and try again. It won’t be recorded twice.';
}

export default function RecordGame() {
  const me = useMe();
  const membership = currentMembership(me.data);
  // Set when the form is opened from the inbox to correct a pending game.
  const { correct } = useLocalSearchParams<{ correct?: string }>();

  if (me.data === null) return <Redirect href="/sign-in" />;
  if (me.data && membership?.status !== 'approved') return <Redirect href="/" />;
  if (!membership) return null;
  if (correct !== undefined) return <CorrectionForm membership={membership} gameId={correct} />;
  return <RecordForm membership={membership} />;
}

// The inbox is where pending games are listed, so a correction starts from a game there. The
// game is fetched once and then held, so the numbers can't change under the player; if the
// game moves on meanwhile, the server refuses the correction.
function CorrectionForm({ membership, gameId }: { membership: MyMembership; gameId: string }) {
  const { leagueId } = membership;
  const game = useQuery({
    queryKey: ['correction', leagueId, gameId],
    queryFn: async () => (await getInbox(leagueId)).find((g) => g.id === gameId) ?? null,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  if (game.isPending) return null;
  const revision = game.data?.openRevision;
  if (!game.data || !revision) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: 'Correct game' }} />
        <Text testID="correction-unavailable" style={game.isError ? styles.error : undefined}>
          {game.isError
            ? 'Couldn’t load the game. Check your connection and try again.'
            : 'This game is no longer waiting for your confirmation, so it can’t be corrected here.'}
        </Text>
        <Link href="/inbox" style={styles.link}>
          Back to inbox
        </Link>
      </View>
    );
  }
  return <RecordForm membership={membership} correcting={{ game: game.data, revision }} />;
}

function RecordForm({ membership, correcting }: { membership: MyMembership; correcting?: Base }) {
  const { leagueId } = membership;
  const queryClient = useQueryClient();
  // Held from the first render: a correction names the revision whose numbers filled the form.
  const [base] = useState(correcting);
  const league = useQuery({ queryKey: ['league', leagueId], queryFn: () => getLeague(leagueId) });
  const members = useQuery({
    queryKey: ['members', leagueId],
    queryFn: () => getMembers(leagueId),
  });
  // A new season game is my approved team against another in the active season.
  const seasons = useQuery({
    queryKey: ['seasons', leagueId],
    queryFn: () => getSeasons(leagueId),
    enabled: base === undefined,
  });
  const season = seasons.data?.find((s) => s.status === 'active');
  const teams = useQuery({
    queryKey: ['teams', leagueId, season?.id],
    queryFn: () => getTeams(leagueId, season!.id),
    enabled: season !== undefined,
  });
  const approvedTeams = teams.data?.filter((t) => t.status === 'approved') ?? [];
  const myTeam = approvedTeams.find((t) => t.players.some((p) => p.membershipId === membership.id));
  // One key and play time per form, so submitting again after a failure resends the same
  // game, which the server records at most once. A correction keeps the game's play time.
  const [draft] = useState(() => ({
    idempotencyKey: crypto.randomUUID(),
    playedAt: base?.revision.playedAt ?? new Date().toISOString(),
  }));
  // A correction keeps the game's kind.
  const [kind, setKind] = useState<Kind>(base?.game.kind ?? 'exhibition');
  const [opponentId, setOpponentId] = useState<string | null>(null);
  const [choosingOpponent, setChoosingOpponent] = useState(false);
  const [seats, setSeats] = useState<Seat[]>(() =>
    base
      ? base.revision.players.map((p) => ({
          membershipId: p.membershipId,
          points: p.points,
          sinks: p.sinks,
        }))
      : [
          { membershipId: membership.id, points: 0, sinks: 0 },
          { membershipId: null, points: 0, sinks: 0 },
          { membershipId: null, points: 0, sinks: 0 },
          { membershipId: null, points: 0, sinks: 0 },
        ],
  );
  const [mySeat] = useState(() =>
    base ? base.revision.players.findIndex((p) => p.membershipId === membership.id) : 0,
  );
  const [winner, setWinner] = useState<Side | null>(base?.revision.winner ?? null);
  const [picking, setPicking] = useState<number | null>(null);
  const submit = useMutation({
    mutationFn: (body: CorrectGameBody | SubmitGameBody) =>
      'baseRevisionId' in body
        ? correctGame(leagueId, base!.game.id, body)
        : submitGame(leagueId, body),
    onSuccess: () => {
      if (base) void queryClient.invalidateQueries({ queryKey: ['inbox', leagueId] });
    },
  });
  const title = base ? 'Correct game' : 'Record game';

  if (submit.isSuccess) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title }} />
        <Text testID={base ? 'game-corrected' : 'game-recorded'} style={styles.heading}>
          {base ? 'Correction sent' : 'Game recorded'}
        </Text>
        <Text>
          {base
            ? 'It counts once the other three players confirm the new numbers.'
            : 'It counts once the other three players confirm it.'}
        </Text>
        <Link href={base ? '/inbox' : '/'} style={styles.link}>
          {base ? 'Back to inbox' : 'Back to home'}
        </Link>
      </View>
    );
  }

  // A correction is checked against the rules the game was first submitted under.
  const rules = base ? base.game.rulesSnapshot : league.data?.rules;
  const approved = members.data?.filter((m) => m.status === 'approved') ?? [];
  const nameOf = (id: string | null) =>
    approved.find((m) => m.id === id)?.displayName ??
    base?.revision.players.find((p) => p.membershipId === id)?.displayName;
  const update = (index: number, patch: Partial<Seat>) =>
    setSeats((current) => current.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  const opponent = approvedTeams.find((t) => t.id === opponentId);
  // The team each side plays for, in a season game.
  const sideTeams: Record<Side, SideTeam | undefined> | null =
    kind !== 'season'
      ? null
      : base
        ? { A: base.revision.teams?.A, B: base.revision.teams?.B }
        : { A: myTeam && sideTeamOf(myTeam), B: opponent && sideTeamOf(opponent) };
  // The server decides who is a sub, and a correction keeps the game's subs; this is the same
  // rule, for showing the form: a player who isn't on the roster of the team they play for.
  const isSub = (i: number): boolean => {
    if (kind !== 'season') return false;
    if (base) return base.revision.players[i]?.isSub ?? false;
    const roster = sideTeams?.[sideOf(i)]?.roster;
    const id = seats[i]!.membershipId;
    return roster !== undefined && id !== null && !roster.includes(id);
  };
  const subsOn = (side: Side) => SEATS_BY_SIDE[side].filter(isSub).length;
  // A seat can take a sub unless the other seat on its side already has one.
  const canSwap = (i: number) => !SEATS_BY_SIDE[sideOf(i)].some((j) => j !== i && isSub(j));
  // In a season game, nobody from the other side's team can be picked.
  const candidates = (i: number) =>
    approved.filter(
      (m) =>
        !seats.some((s) => s.membershipId === m.id) &&
        !sideTeams?.[otherSide(sideOf(i))]?.roster?.includes(m.id),
    );

  const chooseKind = (next: Kind) => {
    if (next === kind) return;
    submit.reset();
    setKind(next);
    setOpponentId(null);
    setChoosingOpponent(false);
    setPicking(null);
    // A season game starts with my partner beside me; the numbers entered so far stay.
    const partner =
      next === 'season'
        ? (myTeam?.players.find((p) => p.membershipId !== membership.id)?.membershipId ?? null)
        : null;
    setSeats((current) =>
      current.map((s, i) => ({
        ...s,
        membershipId: i === 0 ? membership.id : i === 1 ? partner : null,
      })),
    );
  };
  const chooseOpponent = (team: Team) => {
    setOpponentId(team.id);
    setChoosingOpponent(false);
    setPicking(null);
    setSeats((current) =>
      current.map((s, i) =>
        sideOf(i) === 'B' ? { ...s, membershipId: team.players[i - 2]?.membershipId ?? null } : s,
      ),
    );
  };

  // Same validators as the server, for instant feedback; the server checks again. Empty
  // seats get placeholder ids so they aren't reported as the same player.
  const lines: PlayerLine[] = seats.map((s, i) => ({
    membershipId: s.membershipId ?? `empty-seat-${i}`,
    side: sideOf(i),
    points: s.points,
    sinks: s.sinks,
  }));
  const needsOpponent = kind === 'season' && !base && opponent === undefined;
  const allSeated = seats.every((s) => s.membershipId !== null);
  const seasonProblems =
    kind !== 'season' || base
      ? []
      : [
          ...(myTeam === undefined ? ['You’re no longer on an approved team this season.'] : []),
          ...(['A', 'B'] as const).flatMap((side) =>
            subsOn(side) > 1 ? [`Side ${side} can have at most one sub.`] : [],
          ),
          ...seats.flatMap((s, i) => {
            const rival = sideTeams?.[otherSide(sideOf(i))];
            return s.membershipId !== null && rival?.roster?.includes(s.membershipId)
              ? [`${nameOf(s.membershipId) ?? 'A player'} plays for ${rival.name}.`]
              : [];
          }),
        ];
  const structure = rules ? checkStructure(rules, { players: lines, winner }) : [];
  const violations =
    rules && winner && structure.length === 0 ? checkRules(rules, { players: lines, winner }) : [];
  const complete =
    rules !== undefined &&
    !needsOpponent &&
    allSeated &&
    seasonProblems.length === 0 &&
    structure.length === 0;

  const send = (requestOverride: boolean) => {
    const result: Result = {
      playedAt: draft.playedAt,
      sides: {
        A: { players: SEATS_BY_SIDE.A.map((i) => lineOf(seats[i]!)) },
        B: { players: SEATS_BY_SIDE.B.map((i) => lineOf(seats[i]!)) },
      },
      winner: winner!,
      ...(requestOverride ? { requestOverride } : {}),
    };
    if (base) {
      // A season game keeps its teams, so a correction names none.
      submit.mutate({ baseRevisionId: base.revision.id, ...result });
    } else if (kind === 'season') {
      submit.mutate({
        idempotencyKey: draft.idempotencyKey,
        kind: 'season',
        seasonId: season!.id,
        ...result,
        sides: {
          A: { teamId: myTeam!.id, ...result.sides.A },
          B: { teamId: opponent!.id, ...result.sides.B },
        },
      });
    } else {
      submit.mutate({ idempotencyKey: draft.idempotencyKey, kind: 'exhibition', ...result });
    }
  };
  const labels = base
    ? { send: 'Send correction', pending: 'Sending…' }
    : { send: 'Submit game', pending: 'Submitting…' };
  // The game moved on or its window closed, so resending this form can only fail again.
  const refused =
    submit.error instanceof ApiRequestError &&
    (submit.error.code === 'STALE_REVISION' || submit.error.code === 'WINDOW_CLOSED');
  const blocked = submit.isPending || refused;
  // Why there is no season game to record, once that is known.
  const noSeasonGame =
    base || myTeam || !seasons.isSuccess || (season && !teams.isSuccess)
      ? null
      : season
        ? 'You’re not on an approved team this season, so you can record exhibition games only.'
        : 'No season is active, so you can record exhibition games only.';

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title }} />
      {!base && (
        <View style={styles.row}>
          <Button
            testID="kind-season"
            label="Season game"
            variant={kind === 'season' ? 'primary' : 'secondary'}
            disabled={myTeam === undefined || blocked}
            onPress={() => chooseKind('season')}
          />
          <Button
            testID="kind-exhibition"
            label="Exhibition"
            variant={kind === 'exhibition' ? 'primary' : 'secondary'}
            disabled={blocked}
            onPress={() => chooseKind('exhibition')}
          />
        </View>
      )}
      {noSeasonGame && (
        <Text testID="no-season-game" style={styles.muted}>
          {noSeasonGame}
        </Text>
      )}
      <Text style={styles.muted}>
        {kind === 'season'
          ? `Season game${season ? ` in ${season.name}` : ''}. A player who isn’t on their side’s team is its sub; each side can have one.`
          : 'Exhibition game.'}{' '}
        Enter each player&apos;s final points (sink points included) and sinks.
      </Text>
      {base && (
        <Text testID="correction-note" style={styles.muted}>
          Correcting the numbers resets everyone else’s confirmation. The window to confirm doesn’t
          restart.
        </Text>
      )}
      {(league.isError || members.isError || seasons.isError || teams.isError) && (
        <Text style={styles.error}>Couldn’t load the league. Check your connection.</Text>
      )}
      {(['A', 'B'] as const).map((side) => {
        const team = sideTeams?.[side];
        const picksOpponent = kind === 'season' && !base && side === 'B';
        return (
          <View key={side} style={styles.section} testID={`side-${side}`}>
            <Text style={styles.heading}>
              Side {side}
              {team ? ` · ${team.name}` : ''}
            </Text>
            {picksOpponent && (
              <Button
                testID="choose-opponent"
                label={
                  choosingOpponent
                    ? 'Cancel'
                    : opponent
                      ? 'Change team'
                      : 'Choose the opposing team'
                }
                variant="secondary"
                onPress={() => setChoosingOpponent(!choosingOpponent)}
              />
            )}
            {picksOpponent && choosingOpponent && (
              <TeamPicker
                teams={approvedTeams.filter((t) => t.id !== myTeam?.id)}
                onChoose={chooseOpponent}
              />
            )}
            {!(picksOpponent && opponent === undefined) &&
              SEATS_BY_SIDE[side].map((i) => (
                <SeatRow
                  key={i}
                  index={i}
                  seat={seats[i]!}
                  // A correction keeps the game's four players (the server refuses anyone else).
                  fixed={base !== undefined || i === mySeat}
                  name={
                    i === mySeat
                      ? `${membership.displayName} (you)`
                      : nameOf(seats[i]!.membershipId)
                  }
                  season={kind === 'season' ? { sub: isSub(i), canSwap: canSwap(i) } : undefined}
                  picking={picking === i}
                  onPick={() => setPicking(picking === i ? null : i)}
                  onChange={(patch) => update(i, patch)}
                />
              ))}
            {picking !== null && sideOf(picking) === side && (
              <MemberPicker
                members={candidates(picking)}
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
        );
      })}

      <Feedback
        needsOpponent={needsOpponent}
        allSeated={allSeated}
        winner={winner}
        seasonProblems={seasonProblems}
        structure={structure}
        violations={violations}
      />

      <Button
        testID="submit-game"
        label={
          submit.isPending ? labels.pending : submit.isError && !refused ? 'Retry' : labels.send
        }
        disabled={!complete || violations.length > 0 || blocked}
        onPress={() => send(false)}
      />
      {complete && violations.length > 0 && (
        <Button
          testID="submit-for-review"
          label="Submit for commissioner review"
          variant="secondary"
          disabled={blocked}
          onPress={() => send(true)}
        />
      )}
      {submit.isError && (
        <Text testID="submit-error" style={styles.error}>
          {messageFor(submit.error, base !== undefined)}
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
  // A seat whose player can't be changed: the author's own, or any seat in a correction.
  fixed: boolean;
  name: string | undefined;
  // In a season game a seat holds its team's player, or a sub swapped in for one.
  season?: { sub: boolean; canSwap: boolean };
  picking: boolean;
  onPick: () => void;
  onChange: (patch: Partial<Seat>) => void;
};

function SeatRow({ index, seat, fixed, name, season, picking, onPick, onChange }: SeatRowProps) {
  const who = name ?? `Player ${index + 1}`;
  return (
    <View style={styles.seat} testID={`seat-${index}`}>
      {fixed || season ? (
        <View style={styles.row}>
          <Text style={styles.name}>
            {who}
            {season?.sub ? ' (sub)' : ''}
          </Text>
          {!fixed && season?.canSwap && (
            <Button
              testID={`seat-${index}-sub`}
              label={picking ? 'Cancel' : seat.membershipId === null ? 'Choose sub' : 'Swap in sub'}
              variant="secondary"
              onPress={onPick}
            />
          )}
        </View>
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

function TeamPicker({ teams, onChoose }: { teams: Team[]; onChoose: (team: Team) => void }) {
  if (teams.length === 0) {
    return <Text style={styles.muted}>No other approved teams this season.</Text>;
  }
  return (
    <View style={styles.picker} testID="team-picker">
      {teams.map((t) => (
        <Button key={t.id} label={t.name} variant="secondary" onPress={() => onChoose(t)} />
      ))}
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
  needsOpponent: boolean;
  allSeated: boolean;
  winner: Side | null;
  seasonProblems: string[];
  structure: StructureError[];
  violations: RuleViolation[];
};

// What still stands between the form and a valid submission, most basic first.
function Feedback({
  needsOpponent,
  allSeated,
  winner,
  seasonProblems,
  structure,
  violations,
}: FeedbackProps) {
  if (needsOpponent) return <Text style={styles.muted}>Choose the opposing team.</Text>;
  if (!allSeated) return <Text style={styles.muted}>Choose all four players.</Text>;
  if (seasonProblems.length > 0) {
    return (
      <View testID="season-problems">
        {seasonProblems.map((problem) => (
          <Text key={problem} style={styles.error}>
            {problem}
          </Text>
        ))}
      </View>
    );
  }
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
