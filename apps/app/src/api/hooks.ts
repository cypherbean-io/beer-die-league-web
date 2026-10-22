import type { MeResponse, MyMembership } from '@beer-die/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { browserStorage, clearAllDrafts } from '../drafts';
import { getMe, logout } from './client';

// Null when signed out.
export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: getMe });
}

// The v1 UI shows the caller's first league (SPEC §3.2).
export function currentMembership(me: MeResponse | null | undefined): MyMembership | undefined {
  return me?.memberships[0];
}

// Signed out, the device keeps nothing of the caller's: cached data and game drafts go too.
export function forgetSession(queryClient: ReturnType<typeof useQueryClient>): void {
  clearAllDrafts(browserStorage());
  queryClient.clear();
  queryClient.setQueryData(['me'], null);
}

export function useSignOut() {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: logout, onSuccess: () => forgetSession(queryClient) });
}
