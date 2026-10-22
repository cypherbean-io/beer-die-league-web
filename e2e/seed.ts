// What scripts/e2e.ts creates before the suite runs, and the specs then sign in as. The
// Playwright container can't run the CLI, so each spec's league is bootstrapped from the
// host, with emails unique to the run: the stack's database outlives a run.
export const SPECS = ['season-flow', 'offline-retry', 'override', 'xss'] as const;
export type Spec = (typeof SPECS)[number];

export const COMMISSIONER_NAME = 'Commish';

export function runId(): string {
  const run = process.env.E2E_RUN;
  if (!run || !/^[a-z0-9]{1,16}$/.test(run)) {
    throw new Error('E2E_RUN is not set; run the suite with `npm run e2e`');
  }
  return run;
}

export const leagueName = (spec: Spec, run: string) => `E2E ${spec} ${run}`;

export const emailFor = (spec: Spec, who: string, run: string) =>
  `${who}-${spec}-${run}@e2e.example.com`;

export const commissionerEmail = (spec: Spec, run: string) => emailFor(spec, 'commish', run);
