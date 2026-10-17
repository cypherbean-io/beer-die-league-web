export type Side = 'A' | 'B';

export type Rules = {
  targetScore: number;
  winBy: number;
  sinkPoints: number;
  sinkEndsGame: boolean;
};

export type PlayerLine = { membershipId: string; side: Side; points: number; sinks: number };

export type ResultInput = { players: PlayerLine[]; winner: Side };

// A result whose winner may not be chosen yet, as on the record-game form.
export type ResultDraft = { players: PlayerLine[]; winner?: Side | null };

export type StructureError = {
  code:
    | 'PLAYER_COUNT'
    | 'SIDE_SIZE'
    | 'DUPLICATE_PLAYER'
    | 'INVALID_NUMBER'
    | 'POINTS_BELOW_SINK_POINTS'
    | 'MISSING_WINNER';
  message: string;
  path: Array<string | number>;
};

export type RuleViolation = {
  code:
    | 'BELOW_TARGET'
    | 'MARGIN_TOO_SMALL'
    | 'ALREADY_OVER'
    | 'LOSER_SINK_WHEN_SINK_ENDS'
    | 'MULTIPLE_SINKS_WHEN_SINK_ENDS'
    | 'SINK_AFTER_GAME_OVER';
  message: string;
};

const MAX_LINE_VALUE = 99;

const isLineValue = (n: number) => Number.isInteger(n) && n >= 0 && n <= MAX_LINE_VALUE;

// Errors that make a result meaningless. Never overridable (422 VALIDATION).
export function checkStructure(rules: Rules, input: ResultDraft): StructureError[] {
  const errors: StructureError[] = [];
  const { players } = input;

  if (players.length !== 4) {
    errors.push({
      code: 'PLAYER_COUNT',
      message: 'A game needs exactly 4 players.',
      path: ['players'],
    });
  } else if (
    players.filter((p) => p.side === 'A').length !== 2 ||
    players.filter((p) => p.side === 'B').length !== 2
  ) {
    errors.push({
      code: 'SIDE_SIZE',
      message: 'Each side needs exactly 2 players.',
      path: ['players'],
    });
  }

  // Compared case-insensitively, because Postgres treats UUIDs that differ only in case as equal.
  const seen = new Set<string>();
  players.forEach((p, i) => {
    const id = p.membershipId.toLowerCase();
    if (seen.has(id)) {
      errors.push({
        code: 'DUPLICATE_PLAYER',
        message: 'A player appears more than once.',
        path: ['players', i, 'membershipId'],
      });
    }
    seen.add(id);

    for (const field of ['points', 'sinks'] as const) {
      if (!isLineValue(p[field])) {
        errors.push({
          code: 'INVALID_NUMBER',
          message: `${field === 'points' ? 'Points' : 'Sinks'} must be a whole number from 0 to ${MAX_LINE_VALUE}.`,
          path: ['players', i, field],
        });
      }
    }
    if (isLineValue(p.points) && isLineValue(p.sinks) && p.points < p.sinks * rules.sinkPoints) {
      errors.push({
        code: 'POINTS_BELOW_SINK_POINTS',
        message: `Points must include ${rules.sinkPoints} for each sink.`,
        path: ['players', i, 'points'],
      });
    }
  });

  if (input.winner !== 'A' && input.winner !== 'B') {
    errors.push({ code: 'MISSING_WINNER', message: 'Choose the winning side.', path: ['winner'] });
  }

  return errors;
}

// Checks that the final score is a legal end state that wasn't already reached one scoring
// event earlier. It doesn't reconstruct the order of points. Overridable by a commissioner
// (422 RULES_VIOLATION). Assumes checkStructure returned no errors.
export function checkRules(rules: Rules, input: ResultInput): RuleViolation[] {
  const { targetScore, winBy, sinkPoints, sinkEndsGame } = rules;
  const total = (side: Side, field: 'points' | 'sinks') =>
    input.players.filter((p) => p.side === side).reduce((sum, p) => sum + p[field], 0);
  const loser: Side = input.winner === 'A' ? 'B' : 'A';
  const pw = total(input.winner, 'points');
  const pl = total(loser, 'points');
  const sw = total(input.winner, 'sinks');
  const sl = total(loser, 'sinks');

  const over = (a: number, b: number) => a >= targetScore && a - b >= winBy;
  const decided = (w: number, l: number) => over(w, l) || over(l, w);

  const violations: RuleViolation[] = [];

  if (sinkEndsGame && sl > 0) {
    violations.push({
      code: 'LOSER_SINK_WHEN_SINK_ENDS',
      message: 'A sink ends the game, so the losing side cannot have one.',
    });
  }
  if (sinkEndsGame && sw > 1) {
    violations.push({
      code: 'MULTIPLE_SINKS_WHEN_SINK_ENDS',
      message: 'A sink ends the game, so the winning side can have at most one.',
    });
  }

  if (sinkEndsGame && sw === 1) {
    // The game ended on the sink. The winner may be trailing on points.
    if (decided(pw - sinkPoints, pl)) {
      violations.push({
        code: 'SINK_AFTER_GAME_OVER',
        message: 'The game was already over before the final sink.',
      });
    }
    return violations;
  }

  // The game ended on points.
  if (pw < targetScore) {
    violations.push({
      code: 'BELOW_TARGET',
      message: `The winning side needs at least ${targetScore} points.`,
    });
  }
  if (pw - pl < winBy) {
    violations.push({
      code: 'MARGIN_TOO_SMALL',
      message: `The winning side must lead by at least ${winBy}.`,
    });
  }
  if (!over(pw, pl)) return violations;

  // Some final scoring event must have taken the game from undecided to over.
  const lastEvents: number[] = [];
  if (pw - sw * sinkPoints >= 1) lastEvents.push(1);
  if (sw >= 1 && sinkPoints >= 1) lastEvents.push(sinkPoints);
  if (!lastEvents.some((e) => !decided(pw - e, pl))) {
    violations.push({
      code: 'ALREADY_OVER',
      message: 'The game was already over before the final score.',
    });
  }

  return violations;
}
