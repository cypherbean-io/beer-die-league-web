import {
  type Member,
  type MyMembership,
  ProposeTeamBody,
  type Season,
  type Team,
} from '@beer-die/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  actOnTeam,
  ApiRequestError,
  getMembers,
  getSeasons,
  getTeams,
  proposeTeam,
  setTeamRoster,
  type TeamAction,
} from '../../src/api/client';
import { currentMembership, useMe } from '../../src/api/hooks';
import { playerName } from '../../src/gameText';
import { Button } from '../../src/ui';

function messageFor(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'ALREADY_ON_TEAM') return `${error.message}.`;
    if (error.code === 'TEAM_NAME_TAKEN') return 'A team in this season already has that name.';
    if (error.code === 'SEASON_ENDED') return 'This season has ended, so no more teams can form.';
    if (error.code === 'PROPOSAL_LIMIT') {
      return 'You’ve proposed as many teams as allowed this season.';
    }
    if (error.code === 'SEASON_FINALIZED') {
      return 'This season is finalized, so its teams are locked.';
    }
    if (
      error.code === 'TEAM_NOT_PROPOSED' ||
      error.code === 'TEAM_NOT_ACCEPTED' ||
      error.code === 'TEAM_NOT_PENDING' ||
      error.code === 'TEAM_NOT_APPROVED'
    ) {
      return 'This team has changed since you loaded it. Refresh and try again.';
    }
    if (error.code === 'RATE_LIMITED') return 'Too many teams proposed. Try again later.';
    if (error.code === 'FORBIDDEN') return 'You can’t do that for this team.';
    if (error.code === 'VALIDATION') return 'Check the name and players and try again.';
    if (error.status === 404) return 'That season doesn’t exist.';
  }
  return 'Something went wrong. Check your connection and try again.';
}

const STATUS_LABELS: Record<Team['status'], string> = {
  proposed: 'Waiting for the partner to accept',
  accepted: 'Waiting for a commissioner to approve',
  approved: 'Approved',
  rejected: 'Rejected by a commissioner',
  withdrawn: 'Withdrawn',
};

const live = (team: Team) =>
  team.status === 'proposed' || team.status === 'accepted' || team.status === 'approved';

const names = (team: Team) => team.players.map(playerName).join(' and ');

export default function Teams() {
  const { sid } = useLocalSearchParams<{ sid: string }>();
  const me = useMe();
  const membership = currentMembership(me.data);

  if (me.data === null) return <Redirect href="/sign-in" />;
  if (me.data && membership?.status !== 'approved') return <Redirect href="/" />;
  if (!membership) return null;
  return <SeasonTeams membership={membership} seasonId={sid} />;
}

// Every write can change the season's teams and the league log.
function useTeamWrite<A>(leagueId: string, seasonId: string, write: (args: A) => Promise<Team>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['teams', leagueId, seasonId] }),
        queryClient.invalidateQueries({ queryKey: ['audit', leagueId] }),
      ]),
  });
}

type Context = {
  leagueId: string;
  season: Season;
  me: string;
  commissioner: boolean;
  // Approved members, and which of them have joined a team this season.
  members: Member[];
  onTeam: Set<string>;
};

// Who has joined a team: the proposer from the start, and the partner once they accept. A
// partner who hasn't accepted is still free.
const joined = (team: Team) =>
  team.status === 'proposed'
    ? [team.proposedBy]
    : team.status === 'accepted' || team.status === 'approved'
      ? team.players.map((p) => p.membershipId)
      : [];

function SeasonTeams({ membership, seasonId }: { membership: MyMembership; seasonId: string }) {
  const { leagueId } = membership;
  const seasons = useQuery({
    queryKey: ['seasons', leagueId],
    queryFn: () => getSeasons(leagueId),
  });
  const teams = useQuery({
    queryKey: ['teams', leagueId, seasonId],
    queryFn: () => getTeams(leagueId, seasonId),
  });
  const members = useQuery({
    queryKey: ['members', leagueId],
    queryFn: () => getMembers(leagueId),
  });
  const season = seasons.data?.find((s) => s.id === seasonId);
  const failed = seasons.error ?? teams.error ?? members.error;

  if (failed) return <Text style={[styles.container, styles.error]}>{messageFor(failed)}</Text>;
  if (seasons.isSuccess && !season) {
    return <Text style={styles.container}>That season doesn&apos;t exist.</Text>;
  }
  if (!season || !teams.data || !members.data) return null;

  const current = teams.data.filter(live);
  const ctx: Context = {
    leagueId,
    season,
    me: membership.id,
    commissioner: membership.role === 'commissioner',
    members: members.data.filter((m) => m.status === 'approved'),
    onTeam: new Set(teams.data.flatMap(joined)),
  };
  const forming = season.status === 'draft' || season.status === 'active';
  const gone = teams.data.filter((team) => !live(team));

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: `Teams: ${season.name}` }} />
      {forming && !ctx.onTeam.has(ctx.me) && <ProposeTeam ctx={ctx} />}
      {!forming && (
        <Text style={styles.muted}>
          This season has ended, so no new teams can form. Until it is finalized, a team still
          awaiting approval can be withdrawn or rejected, and a commissioner can change an approved
          team&apos;s players.
        </Text>
      )}
      <Text style={styles.heading}>Teams</Text>
      {current.length === 0 && <Text style={styles.muted}>No teams yet.</Text>}
      {current.map((team) => (
        <TeamCard key={team.id} ctx={ctx} team={team} />
      ))}
      {gone.length > 0 && (
        <>
          <Text style={styles.subheading}>Rejected or withdrawn</Text>
          {gone.map((team) => (
            <Text key={team.id} style={styles.muted} testID="closed-team">
              {team.name} ({names(team)}): {STATUS_LABELS[team.status]}
            </Text>
          ))}
        </>
      )}
    </ScrollView>
  );
}

function ProposeTeam({ ctx }: { ctx: Context }) {
  const [name, setName] = useState('');
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const propose = useTeamWrite(ctx.leagueId, ctx.season.id, (body: ProposeTeamBody) =>
    proposeTeam(ctx.leagueId, ctx.season.id, body.name, body.partnerId),
  );
  const partners = ctx.members.filter((m) => m.id !== ctx.me && !ctx.onTeam.has(m.id));
  const body = { name, partnerId: partnerId ?? '' };
  // Same validator as the server, for instant feedback; the server checks again.
  const valid = ProposeTeamBody.safeParse(body).success;

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>Propose a team</Text>
      <Text style={styles.muted}>
        Your partner accepts, then a commissioner approves the team. Until your partner accepts,
        only the two of you and the commissioners can see it.
      </Text>
      <Text nativeID="team-name-label" style={styles.label}>
        Team name
      </Text>
      <TextInput
        testID="team-name-input"
        aria-labelledby="team-name-label"
        style={styles.input}
        value={name}
        onChangeText={setName}
        maxLength={40}
        placeholder="Table Kings"
      />
      <Text style={styles.label}>Partner</Text>
      {partners.length === 0 && (
        <Text style={styles.muted}>Everyone else is already on a team this season.</Text>
      )}
      <View style={[styles.row, styles.wrap]}>
        {partners.map((m) => (
          <Button
            key={m.id}
            testID="partner-option"
            label={m.displayName}
            variant={m.id === partnerId ? 'primary' : 'secondary'}
            onPress={() => setPartnerId(m.id)}
          />
        ))}
      </View>
      <Button
        testID="propose-team"
        label={propose.isPending ? 'Proposing…' : 'Propose team'}
        disabled={!valid || propose.isPending}
        onPress={() =>
          propose.mutate(body, {
            onSuccess: () => {
              setName('');
              setPartnerId(null);
            },
          })
        }
      />
      {propose.isError && <Text style={styles.error}>{messageFor(propose.error)}</Text>}
    </View>
  );
}

function TeamCard({ ctx, team }: { ctx: Context; team: Team }) {
  const [editing, setEditing] = useState(false);
  const act = useTeamWrite(ctx.leagueId, ctx.season.id, (action: TeamAction) =>
    actOnTeam(ctx.leagueId, team.id, action),
  );
  const forming = ctx.season.status === 'draft' || ctx.season.status === 'active';
  const open = ctx.season.status !== 'finalized';
  const pending = team.status === 'proposed' || team.status === 'accepted';
  const onIt = team.players.some((p) => p.membershipId === ctx.me);
  const asked = onIt && team.proposedBy !== ctx.me && team.status === 'proposed';

  const action = (label: string, which: TeamAction, variant?: 'secondary') => (
    <Button
      testID={`team-${which}`}
      label={label}
      variant={variant}
      disabled={act.isPending}
      onPress={() => act.mutate(which)}
    />
  );

  return (
    <View style={styles.card} testID="team">
      <Text style={styles.name}>{team.name}</Text>
      <Text>{names(team)}</Text>
      <Text testID="team-status" style={styles.muted}>
        {STATUS_LABELS[team.status]}
      </Text>
      {open && (
        <View style={[styles.row, styles.wrap]}>
          {forming && asked && action('Accept', 'accept')}
          {onIt && pending && action(asked ? 'Decline' : 'Withdraw', 'withdraw', 'secondary')}
          {forming &&
            ctx.commissioner &&
            team.status === 'accepted' &&
            action('Approve', 'approve')}
          {ctx.commissioner && pending && action('Reject', 'reject', 'secondary')}
        </View>
      )}
      {act.isError && <Text style={styles.error}>{messageFor(act.error)}</Text>}
      {ctx.commissioner &&
        team.status === 'approved' &&
        ctx.season.status !== 'finalized' &&
        (editing ? (
          <RosterEditor ctx={ctx} team={team} onDone={() => setEditing(false)} />
        ) : (
          <Button
            testID="edit-roster"
            label="Change players"
            variant="secondary"
            onPress={() => setEditing(true)}
          />
        ))}
    </View>
  );
}

function RosterEditor({ ctx, team, onDone }: { ctx: Context; team: Team; onDone: () => void }) {
  const current = team.players.map((p) => p.membershipId);
  const [picked, setPicked] = useState(current);
  const save = useTeamWrite(ctx.leagueId, ctx.season.id, (ids: [string, string]) =>
    setTeamRoster(ctx.leagueId, team.id, ids),
  );
  // This team's players, and anyone not on another team this season.
  const choices = ctx.members.filter((m) => current.includes(m.id) || !ctx.onTeam.has(m.id));
  const changed = picked.length === 2 && picked.some((id) => !current.includes(id));

  const toggle = (id: string) =>
    setPicked(picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id].slice(-2));

  return (
    <View style={styles.section}>
      <Text style={styles.subheading}>Players</Text>
      <Text style={styles.muted}>
        Pick two. Games already recorded keep the players who played them. This is recorded in the
        league log.
      </Text>
      <View style={[styles.row, styles.wrap]}>
        {choices.map((m) => (
          <Button
            key={m.id}
            testID="roster-option"
            label={m.displayName}
            variant={picked.includes(m.id) ? 'primary' : 'secondary'}
            onPress={() => toggle(m.id)}
          />
        ))}
      </View>
      <View style={styles.row}>
        <Button
          testID="save-roster"
          label={save.isPending ? 'Saving…' : 'Save players'}
          disabled={!changed || save.isPending}
          onPress={() => save.mutate([picked[0]!, picked[1]!], { onSuccess: onDone })}
        />
        <Button label="Cancel" variant="secondary" onPress={onDone} />
      </View>
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
  muted: { color: '#555' },
  error: { color: '#b91c1c' },
});
