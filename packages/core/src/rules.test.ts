import { describe, expect, it } from 'vitest';
import {
  checkRules,
  checkStructure,
  type PlayerLine,
  type ResultInput,
  type RuleViolation,
  type Rules,
  type Side,
} from './rules.ts';

const DEFAULTS: Rules = { targetScore: 11, winBy: 2, sinkPoints: 0, sinkEndsGame: false };

type Totals = { points: number; sinks: number };

const t = (points: number, sinks = 0): Totals => ({ points, sinks });

const other = (side: Side): Side => (side === 'A' ? 'B' : 'A');

// Splits a team total across two players. The first player takes every sink plus the points
// those sinks are worth, so the lines stay structurally valid.
function lines(rules: Rules, side: Side, { points, sinks }: Totals): PlayerLine[] {
  const second = Math.floor((points - sinks * rules.sinkPoints) / 2);
  return [
    { membershipId: `${side}1`, side, points: points - second, sinks },
    { membershipId: `${side}2`, side, points: second, sinks: 0 },
  ];
}

function result(rules: Rules, winner: Side, w: Totals, l: Totals): ResultInput {
  return { winner, players: [...lines(rules, winner, w), ...lines(rules, other(winner), l)] };
}

function withPlayer(input: ResultInput, index: number, patch: Partial<PlayerLine>): ResultInput {
  return { ...input, players: input.players.map((p, i) => (i === index ? { ...p, ...patch } : p)) };
}

describe('checkRules', () => {
  const sink3 = { sinkPoints: 3 };
  const sinkEnds = { sinkEndsGame: true };

  // SPEC.md §5.1, followed by cases for the "either side" and multi-violation edges.
  const table: Array<{
    label: string;
    rules: Partial<Rules>;
    w: Totals;
    l: Totals;
    expected: RuleViolation['code'][];
  }> = [
    { label: 'defaults, 11–9', rules: {}, w: t(11), l: t(9), expected: [] },
    { label: 'defaults, 11–10', rules: {}, w: t(11), l: t(10), expected: ['MARGIN_TOO_SMALL'] },
    { label: 'defaults, 10–8', rules: {}, w: t(10), l: t(8), expected: ['BELOW_TARGET'] },
    { label: 'defaults, 12–10', rules: {}, w: t(12), l: t(10), expected: [] },
    { label: 'defaults, 13–11', rules: {}, w: t(13), l: t(11), expected: [] },
    {
      label: 'defaults, 13–10 (12–10 was final)',
      rules: {},
      w: t(13),
      l: t(10),
      expected: ['ALREADY_OVER'],
    },
    { label: 'defaults, 15–3', rules: {}, w: t(15), l: t(3), expected: ['ALREADY_OVER'] },
    { label: 'defaults, 11–0', rules: {}, w: t(11), l: t(0), expected: [] },
    {
      label: 'sink = 3, 13–10 with a winner sink (10–10 before it)',
      rules: sink3,
      w: t(13, 1),
      l: t(10),
      expected: [],
    },
    {
      label: 'sink = 3, 13–10 with no winner sink',
      rules: sink3,
      w: t(13),
      l: t(10),
      expected: ['ALREADY_OVER'],
    },
    {
      label: 'sink = 3, 14–10 with a winner sink (11–10 before it)',
      rules: sink3,
      w: t(14, 1),
      l: t(10),
      expected: [],
    },
    {
      label: 'sink = 3, 15–9 with a winner sink',
      rules: sink3,
      w: t(15, 1),
      l: t(9),
      expected: ['ALREADY_OVER'],
    },
    {
      label: 'sink ends game, 4–9 with a winner sink (winner trailing)',
      rules: sinkEnds,
      w: t(4, 1),
      l: t(9),
      expected: [],
    },
    {
      label: 'sink ends game, 11–5 with a winner sink',
      rules: sinkEnds,
      w: t(11, 1),
      l: t(5),
      expected: ['SINK_AFTER_GAME_OVER'],
    },
    {
      label: 'sink ends game, 11–9 with a loser sink',
      rules: sinkEnds,
      w: t(11),
      l: t(9, 1),
      expected: ['LOSER_SINK_WHEN_SINK_ENDS'],
    },
    {
      label: 'sink ends game, 11–9 with 2 winner sinks',
      rules: sinkEnds,
      w: t(11, 2),
      l: t(9),
      expected: ['MULTIPLE_SINKS_WHEN_SINK_ENDS'],
    },
    {
      label: 'sink ends game, 11–9 with no sinks',
      rules: sinkEnds,
      w: t(11),
      l: t(9),
      expected: [],
    },
    {
      label: 'sink ends game, sink = 3, 12–9 with a winner sink (9–9 before it)',
      rules: { ...sinkEnds, ...sink3 },
      w: t(12, 1),
      l: t(9),
      expected: [],
    },
    {
      label: 'target 7, win-by 1, 7–6',
      rules: { targetScore: 7, winBy: 1 },
      w: t(7),
      l: t(6),
      expected: [],
    },
    {
      label: 'target 7, win-by 1, 8–6',
      rules: { targetScore: 7, winBy: 1 },
      w: t(8),
      l: t(6),
      expected: ['ALREADY_OVER'],
    },
    {
      label: 'defaults, 10–9',
      rules: {},
      w: t(10),
      l: t(9),
      expected: ['BELOW_TARGET', 'MARGIN_TOO_SMALL'],
    },
    {
      label: 'sink = 5, 16–13 with a winner sink (the loser had won 13–11 before it)',
      rules: { sinkPoints: 5 },
      w: t(16, 1),
      l: t(13),
      expected: ['ALREADY_OVER'],
    },
    {
      label: 'sink ends game, 4–11 with a winner sink (the loser had already won)',
      rules: sinkEnds,
      w: t(4, 1),
      l: t(11),
      expected: ['SINK_AFTER_GAME_OVER'],
    },
    {
      label: 'sink ends game, 11–9 with 2 winner sinks and a loser sink',
      rules: sinkEnds,
      w: t(11, 2),
      l: t(9, 1),
      expected: ['LOSER_SINK_WHEN_SINK_ENDS', 'MULTIPLE_SINKS_WHEN_SINK_ENDS'],
    },
  ];

  describe.each(['A', 'B'] as const)('when side %s wins', (winner) => {
    it.each(table)('$label → $expected', ({ rules: overrides, w, l, expected }) => {
      const rules = { ...DEFAULTS, ...overrides };
      const input = result(rules, winner, w, l);
      expect(checkStructure(rules, input)).toEqual([]);

      const violations = checkRules(rules, input);

      expect(violations.map((v) => v.code)).toEqual(expected);
      for (const v of violations) expect(v.message).not.toBe('');
    });
  });

  it('sums points across both players on a side', () => {
    const input: ResultInput = {
      winner: 'A',
      players: [
        { membershipId: 'A1', side: 'A', points: 6, sinks: 0 },
        { membershipId: 'A2', side: 'A', points: 5, sinks: 0 },
        { membershipId: 'B1', side: 'B', points: 9, sinks: 0 },
        { membershipId: 'B2', side: 'B', points: 1, sinks: 0 },
      ],
    };

    expect(checkRules(DEFAULTS, input).map((v) => v.code)).toEqual(['MARGIN_TOO_SMALL']);
  });
});

describe('checkStructure', () => {
  const valid = () => result(DEFAULTS, 'A', t(11), t(9));

  it('accepts four distinct players, two per side, and a winner', () => {
    expect(checkStructure(DEFAULTS, valid())).toEqual([]);
  });

  it('accepts 0 and 99 for points and sinks', () => {
    const input = withPlayer(withPlayer(valid(), 0, { points: 99, sinks: 99 }), 1, {
      points: 0,
      sinks: 0,
    });

    expect(checkStructure(DEFAULTS, input)).toEqual([]);
  });

  it('rejects a duplicate player', () => {
    const input = withPlayer(valid(), 3, { membershipId: 'A1' });

    expect(checkStructure(DEFAULTS, input)).toEqual([
      {
        code: 'DUPLICATE_PLAYER',
        message: expect.any(String),
        path: ['players', 3, 'membershipId'],
      },
    ]);
  });

  it('rejects the same player listed again with differently cased ID', () => {
    const id = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';
    const input = withPlayer(withPlayer(valid(), 0, { membershipId: id }), 2, {
      membershipId: id.toUpperCase(),
    });

    expect(checkStructure(DEFAULTS, input)).toEqual([
      {
        code: 'DUPLICATE_PLAYER',
        message: expect.any(String),
        path: ['players', 2, 'membershipId'],
      },
    ]);
  });

  it('rejects three players on one side', () => {
    const input = withPlayer(valid(), 2, { side: 'A' });

    expect(checkStructure(DEFAULTS, input)).toEqual([
      { code: 'SIDE_SIZE', message: expect.any(String), path: ['players'] },
    ]);
  });

  it('rejects a side value other than A or B', () => {
    const input = withPlayer(valid(), 3, { side: 'C' as Side });

    expect(checkStructure(DEFAULTS, input).map((e) => e.code)).toEqual(['SIDE_SIZE']);
  });

  it.each([3, 5])('rejects %i players', (count) => {
    const players = valid().players;
    const input: ResultInput = {
      winner: 'A',
      players:
        count < 4
          ? players.slice(0, count)
          : [...players, { membershipId: 'B3', side: 'B', points: 0, sinks: 0 }],
    };

    expect(checkStructure(DEFAULTS, input)).toEqual([
      { code: 'PLAYER_COUNT', message: expect.any(String), path: ['players'] },
    ]);
  });

  it.each([
    ['points', -1],
    ['points', 100],
    ['points', 2.5],
    ['points', Number.NaN],
    ['sinks', -1],
    ['sinks', 100],
    ['sinks', 2.5],
    ['sinks', Number.NaN],
  ] as const)('rejects %s = %d', (field, value) => {
    const input = withPlayer(valid(), 1, { [field]: value });

    expect(checkStructure(DEFAULTS, input)).toEqual([
      { code: 'INVALID_NUMBER', message: expect.any(String), path: ['players', 1, field] },
    ]);
  });

  it('with a sink worth 3, rejects a player with 1 sink and 2 points', () => {
    const rules = { ...DEFAULTS, sinkPoints: 3 };
    const input = withPlayer(valid(), 2, { points: 2, sinks: 1 });

    expect(checkStructure(rules, input)).toEqual([
      {
        code: 'POINTS_BELOW_SINK_POINTS',
        message: expect.any(String),
        path: ['players', 2, 'points'],
      },
    ]);
  });

  it('with a sink worth 3, accepts a player with 1 sink and 3 points', () => {
    const rules = { ...DEFAULTS, sinkPoints: 3 };
    const input = withPlayer(valid(), 2, { points: 3, sinks: 1 });

    expect(checkStructure(rules, input)).toEqual([]);
  });

  it.each([undefined, null])('rejects a missing winner (%s)', (winner) => {
    const input = { players: valid().players, winner };

    expect(checkStructure(DEFAULTS, input)).toEqual([
      { code: 'MISSING_WINNER', message: expect.any(String), path: ['winner'] },
    ]);
  });

  it('reports every error at once', () => {
    const input = withPlayer(withPlayer(valid(), 1, { points: -1 }), 3, { sinks: 2.5 });

    expect(checkStructure(DEFAULTS, { players: input.players }).map((e) => e.code)).toEqual([
      'INVALID_NUMBER',
      'INVALID_NUMBER',
      'MISSING_WINNER',
    ]);
  });
});
