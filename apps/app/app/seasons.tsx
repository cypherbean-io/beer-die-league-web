import {
  CreateSeasonBody,
  type MyMembership,
  type Season,
  StandingsConfigBody,
  StandingsMetric,
} from '@beer-die/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Redirect, Stack } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  ApiRequestError,
  createSeason,
  endSeason,
  getSeasons,
  startSeason,
  updateStandingsConfig,
} from '../src/api/client';
import { currentMembership, useMe } from '../src/api/hooks';
import { describeOrder, METRIC_LABELS } from '../src/standings';
import { Button } from '../src/ui';

function messageFor(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'SEASON_ALREADY_ACTIVE') {
      return 'Another season is active. End it before starting a new one.';
    }
    if (error.code === 'SEASON_NOT_DRAFT') return 'That season has already started.';
    if (error.code === 'SEASON_NOT_ACTIVE') return 'That season isn’t active.';
    if (error.code === 'SEASON_FINALIZED') {
      return 'This season is finalized, so its standings settings are locked.';
    }
    if (error.code === 'FORBIDDEN') return 'Only a commissioner can do that.';
    if (error.code === 'VALIDATION') return 'Check the values and try again.';
  }
  return 'Something went wrong. Check your connection and try again.';
}

const STATUS_LABELS: Record<Season['status'], string> = {
  draft: 'Draft',
  active: 'Active',
  ended: 'Ended, waiting for open games to settle',
  finalized: 'Finalized',
};

const day = (iso: string) => new Date(iso).toLocaleDateString();

export default function Seasons() {
  const me = useMe();
  const membership = currentMembership(me.data);

  if (me.data === null) return <Redirect href="/sign-in" />;
  if (me.data && membership?.status !== 'approved') return <Redirect href="/" />;
  if (!membership) return null;
  return <SeasonList membership={membership} />;
}

// Every write can change the list and the league log.
function useSeasonWrite<A>(leagueId: string, write: (args: A) => Promise<Season>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['seasons', leagueId] }),
        queryClient.invalidateQueries({ queryKey: ['audit', leagueId] }),
      ]),
  });
}

function SeasonList({ membership }: { membership: MyMembership }) {
  const { leagueId } = membership;
  const seasons = useQuery({
    queryKey: ['seasons', leagueId],
    queryFn: () => getSeasons(leagueId),
  });
  const commissioner = membership.role === 'commissioner';

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Seasons' }} />
      {seasons.isError && <Text style={styles.error}>{messageFor(seasons.error)}</Text>}
      {commissioner && <NewSeason leagueId={leagueId} />}
      {seasons.data?.length === 0 && <Text style={styles.muted}>No seasons yet.</Text>}
      {seasons.data?.map((season) => (
        <SeasonCard
          key={season.id}
          leagueId={leagueId}
          season={season}
          commissioner={commissioner}
        />
      ))}
    </ScrollView>
  );
}

function NewSeason({ leagueId }: { leagueId: string }) {
  const [name, setName] = useState('');
  const create = useSeasonWrite(leagueId, (n: string) => createSeason(leagueId, n));
  // Same validator as the server, for instant feedback; the server checks again.
  const valid = CreateSeasonBody.safeParse({ name }).success;

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>New season</Text>
      <Text nativeID="season-name-label" style={styles.label}>
        Name
      </Text>
      <TextInput
        testID="season-name-input"
        aria-labelledby="season-name-label"
        style={styles.input}
        value={name}
        onChangeText={setName}
        maxLength={60}
        placeholder="Fall 2026"
      />
      <Button
        testID="create-season"
        label={create.isPending ? 'Creating…' : 'Create draft season'}
        disabled={!valid || create.isPending}
        onPress={() => create.mutate(name, { onSuccess: () => setName('') })}
      />
      {create.isError && <Text style={styles.error}>{messageFor(create.error)}</Text>}
    </View>
  );
}

type CardProps = { leagueId: string; season: Season; commissioner: boolean };

function SeasonCard({ leagueId, season, commissioner }: CardProps) {
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const start = useSeasonWrite(leagueId, () => startSeason(leagueId, season.id));
  const end = useSeasonWrite(leagueId, () => endSeason(leagueId, season.id));
  const failed = start.error ?? end.error;

  return (
    <View style={styles.card} testID="season">
      <Text style={styles.name}>{season.name}</Text>
      <Text testID="season-status">{STATUS_LABELS[season.status]}</Text>
      <Text style={styles.muted}>
        {[
          season.startedAt && `Started ${day(season.startedAt)}`,
          season.endedAt && `ended ${day(season.endedAt)}`,
          season.finalizedAt && `finalized ${day(season.finalizedAt)}`,
        ]
          .filter(Boolean)
          .join(', ')}
      </Text>
      <Link
        href={{ pathname: '/teams/[sid]', params: { sid: season.id } }}
        testID="season-teams-link"
        style={styles.link}
      >
        Teams
      </Link>
      <Link
        href={{ pathname: '/standings/[sid]', params: { sid: season.id } }}
        testID="season-standings-link"
        style={styles.link}
      >
        Standings
      </Link>
      <Text>Ranked by {describeOrder(season.standingsConfig.order)}</Text>
      <Text>Minimum games to be ranked: {season.standingsConfig.minGames}</Text>

      {commissioner && season.status === 'draft' && (
        <Button
          testID="start-season"
          label={start.isPending ? 'Starting…' : 'Start season'}
          disabled={start.isPending}
          onPress={() => start.mutate(undefined)}
        />
      )}
      {commissioner && season.status === 'active' && !confirmingEnd && (
        <Button
          testID="end-season"
          label="End season"
          variant="secondary"
          onPress={() => setConfirmingEnd(true)}
        />
      )}
      {commissioner && season.status === 'active' && confirmingEnd && (
        <View style={styles.section}>
          <Text>
            End {season.name}? No new games can be recorded in it. Games already waiting for
            confirmation can still be confirmed, and it finalizes once they settle. This can&apos;t
            be undone.
          </Text>
          <View style={styles.row}>
            <Button
              testID="confirm-end-season"
              label={end.isPending ? 'Ending…' : 'End season'}
              disabled={end.isPending}
              onPress={() => end.mutate(undefined, { onSettled: () => setConfirmingEnd(false) })}
            />
            <Button label="Cancel" variant="secondary" onPress={() => setConfirmingEnd(false)} />
          </View>
        </View>
      )}
      {failed && <Text style={styles.error}>{messageFor(failed)}</Text>}

      {commissioner && season.status !== 'finalized' && (
        // Keyed on the saved config, so a successful save resets the form to it.
        <StandingsEditor
          key={JSON.stringify(season.standingsConfig)}
          leagueId={leagueId}
          season={season}
        />
      )}
      {commissioner && season.status === 'finalized' && (
        <Text style={styles.muted}>The season is finalized, so its standings are locked.</Text>
      )}
    </View>
  );
}

function StandingsEditor({ leagueId, season }: { leagueId: string; season: Season }) {
  const saved = season.standingsConfig;
  const [order, setOrder] = useState(saved.order);
  const [minGames, setMinGames] = useState(String(saved.minGames));
  const save = useSeasonWrite(leagueId, (patch: StandingsConfigBody) =>
    updateStandingsConfig(leagueId, season.id, patch),
  );

  // Only the fields that differ from what the server holds.
  const min = /^[0-9]+$/.test(minGames) ? Number(minGames) : Number.NaN;
  const orderChanged =
    order.length !== saved.order.length || order.some((m, i) => m !== saved.order[i]);
  const patch: StandingsConfigBody = {
    ...(orderChanged && { order }),
    ...(!Object.is(min, saved.minGames) && { minGames: min }),
  };
  const dirty = Object.keys(patch).length > 0;
  const valid = StandingsConfigBody.safeParse(patch).success;
  const unused = StandingsMetric.options.filter((m) => !order.includes(m));

  const move = (i: number, by: -1 | 1) => {
    const next = [...order];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    setOrder(next);
  };

  return (
    <View style={styles.section}>
      <Text style={styles.subheading}>Standings settings</Text>
      <Text style={styles.muted}>
        Teams are ranked by the first metric; each later one breaks ties left by those before it.
      </Text>
      {order.map((metric, i) => (
        <View key={metric} style={styles.row} testID="standings-metric">
          <Text style={[styles.label, styles.grow]}>
            {i + 1}. {METRIC_LABELS[metric]}
          </Text>
          <Button label="↑" variant="secondary" disabled={i === 0} onPress={() => move(i, -1)} />
          <Button
            label="↓"
            variant="secondary"
            disabled={i === order.length - 1}
            onPress={() => move(i, 1)}
          />
          <Button
            label="Remove"
            variant="secondary"
            disabled={order.length === 1}
            onPress={() => setOrder(order.filter((m) => m !== metric))}
          />
        </View>
      ))}
      {unused.length > 0 && (
        <View style={[styles.row, styles.wrap]}>
          {unused.map((metric) => (
            <Button
              key={metric}
              label={`+ ${METRIC_LABELS[metric]}`}
              variant="secondary"
              onPress={() => setOrder([...order, metric])}
            />
          ))}
        </View>
      )}
      <Text nativeID={`min-games-label-${season.id}`} style={styles.label}>
        Minimum games to be ranked (0–99)
      </Text>
      <TextInput
        testID="min-games-input"
        aria-labelledby={`min-games-label-${season.id}`}
        style={styles.input}
        value={minGames}
        onChangeText={(text) => setMinGames(text.replace(/\D/g, '').slice(0, 2))}
        inputMode="numeric"
        maxLength={2}
      />
      {dirty && !valid && <Text style={styles.error}>Enter a whole number from 0 to 99.</Text>}
      <Button
        testID="save-standings"
        label={save.isPending ? 'Saving…' : 'Save standings settings'}
        disabled={!dirty || !valid || save.isPending}
        onPress={() => save.mutate(patch)}
      />
      {save.isError && <Text style={styles.error}>{messageFor(save.error)}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 16, maxWidth: 560 },
  section: { gap: 8 },
  card: { gap: 8, borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12 },
  heading: { fontSize: 18, fontWeight: '700' },
  subheading: { fontSize: 16, fontWeight: '700', marginTop: 8 },
  name: { fontSize: 18, fontWeight: '600' },
  label: { fontSize: 16 },
  input: { borderWidth: 1, borderColor: '#888', borderRadius: 8, padding: 10, fontSize: 18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  wrap: { flexWrap: 'wrap' },
  grow: { flex: 1 },
  muted: { color: '#555' },
  link: { color: '#1d4ed8', fontSize: 16 },
  error: { color: '#b91c1c' },
});
