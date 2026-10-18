import type { MeResponse, MyMembership } from '@beer-die/core';
import { useQuery } from '@tanstack/react-query';
import { getMe } from './client';

// Null when signed out.
export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: getMe });
}

// The v1 UI shows the caller's first league (SPEC §3.2).
export function currentMembership(me: MeResponse | null | undefined): MyMembership | undefined {
  return me?.memberships[0];
}
