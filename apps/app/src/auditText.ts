import type { AuditEvent, LeagueSettings, Rules } from '@beer-die/core';
import { describeOrder } from './standings';

// How the league log and a game's page describe an entry.
const RULE_LABELS: Record<keyof Rules, string> = {
  targetScore: 'Target score',
  winBy: 'Win by',
  sinkPoints: 'Points for a sink',
  sinkEndsGame: 'A sink ends the game',
};

const SETTING_LABELS: Record<keyof LeagueSettings, string> = {
  confirmationWindowDays: 'Days to confirm a game',
  exhibitionCorrectionWindowDays: 'Days to reopen an exhibition game',
};

const show = (value: unknown) =>
  typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value);

function changeLines<T extends object>(
  details: { before: T; after: T },
  labels: Record<keyof T, string>,
): string[] {
  return (Object.keys(labels) as Array<keyof T>)
    .filter((key) => details.before[key] !== details.after[key])
    .map((key) => `${labels[key]}: ${show(details.before[key])} → ${show(details.after[key])}`);
}

export function describeEvent(event: AuditEvent): { summary: string; lines: string[] } {
  switch (event.action) {
    case 'league.rules_updated':
      return { summary: 'changed the rules', lines: changeLines(event.details, RULE_LABELS) };
    case 'league.settings_updated':
      return {
        summary: 'changed the league settings',
        lines: changeLines(event.details, SETTING_LABELS),
      };
    case 'game.confirmation_forced':
      return { summary: `confirmed a game on behalf of ${event.player.displayName}`, lines: [] };
    case 'game.override_decided':
      return {
        summary:
          event.details.decision === 'approve'
            ? 'approved a game that breaks the league rules'
            : 'rejected a game that breaks the league rules',
        lines: [],
      };
    case 'season.started':
      return { summary: `started ${event.season.name}`, lines: [] };
    case 'season.ended':
      return { summary: `ended ${event.season.name}`, lines: [] };
    case 'season.standings_config_updated': {
      const { before, after } = event.details;
      return {
        summary: `changed the standings settings for ${event.season.name}`,
        lines: [
          ...(describeOrder(before.order) === describeOrder(after.order)
            ? []
            : [`Ranked by: ${describeOrder(before.order)} → ${describeOrder(after.order)}`]),
          ...(before.minGames === after.minGames
            ? []
            : [`Minimum games: ${before.minGames} → ${after.minGames}`]),
        ],
      };
    }
    case 'team.approved':
      return { summary: `approved ${event.team.name} for ${event.season.name}`, lines: [] };
    case 'team.rejected':
      return {
        summary: `rejected ${event.team?.name ?? 'a proposed team'} for ${event.season.name}`,
        lines: [],
      };
    case 'team.roster_updated': {
      const names = (players: Array<{ displayName: string }>) =>
        players.map((p) => p.displayName).join(' and ');
      return {
        summary: `changed the roster of ${event.team.name} in ${event.season.name}`,
        lines: [`${names(event.roster.before)} → ${names(event.roster.after)}`],
      };
    }
    case 'member.removed': {
      const voided = event.details.voidedGameIds.length;
      return {
        summary: `removed ${event.player.displayName} from the league`,
        lines:
          voided === 0
            ? []
            : [`Voided ${voided} game${voided === 1 ? '' : 's'} awaiting confirmation`],
      };
    }
  }
}

// Why a commissioner's action is flagged: they had a stake in what it changed.
export function participation(event: AuditEvent): string {
  if (!event.actorWasParticipant) return '';
  if (event.targetType === 'team') return ' (on this team)';
  if (event.targetType === 'membership') return ' (played in a voided game)';
  return ' (played in this game)';
}
