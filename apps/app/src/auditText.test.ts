import type { AuditEvent } from '@beer-die/core';
import { describe, expect, it } from 'vitest';
import { describeEvent, participation } from './auditText';

const ANA = '0199f3a2-5c1e-7a00-8000-00000000000a';
const BO = '0199f3a2-5c1e-7a00-8000-00000000000b';

const base = {
  id: '0199f3a2-5c1e-7a00-8000-0000000000e1',
  createdAt: '2026-10-17T12:00:00.000Z',
  actor: { membershipId: ANA, displayName: 'Ana' },
  actorWasParticipant: false,
  targetType: 'membership',
} as const;

function roleChange(player: string, name: string, after: 'member' | 'commissioner'): AuditEvent {
  return {
    ...base,
    action: 'member.role_changed',
    targetId: player,
    player: { membershipId: player, displayName: name },
    details: { before: after === 'member' ? 'commissioner' : 'member', after },
  };
}

describe('describeEvent', () => {
  it('says who an approval let into the league', () => {
    const event: AuditEvent = {
      ...base,
      action: 'member.approved',
      targetId: BO,
      player: { membershipId: BO, displayName: 'Bo' },
      details: {},
    };

    expect(describeEvent(event)).toEqual({
      summary: 'approved Bo to join the league',
      lines: [],
    });
    expect(participation(event)).toBe('');
  });

  it('says who was made a commissioner', () => {
    expect(describeEvent(roleChange(BO, 'Bo', 'commissioner')).summary).toBe(
      'made Bo a commissioner',
    );
  });

  it('says who was made a member again', () => {
    expect(describeEvent(roleChange(BO, 'Bo', 'member')).summary).toBe('made Bo a member');
  });

  it('says a commissioner who demoted themselves stepped down', () => {
    expect(describeEvent(roleChange(ANA, 'Ana', 'member')).summary).toBe(
      'stepped down as commissioner',
    );
  });
});
