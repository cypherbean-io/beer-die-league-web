import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  request as apiRequest,
} from '@playwright/test';
import { COMMISSIONER_NAME, commissionerEmail, emailFor, runId, type Spec } from './seed.ts';

// APP_ORIGIN in compose.test.yaml. Mailpit's HTTP API, on the stack's network.
export const ORIGIN = 'https://localhost';
const MAILPIT = 'http://mailpit:8025';

export type Player = { name: string; email: string; context: BrowserContext; page: Page };

type MailpitSearch = { messages: Array<{ ID: string }> };
type MailpitMessage = { Text: string };

// The sign-in code Mailpit received for `email`. Polled, not slept on: the worker delivers
// within a few seconds. Each address signs in once per run, so its newest message is the one.
async function codeFor(email: string): Promise<string> {
  const mail = await apiRequest.newContext({ baseURL: MAILPIT });
  try {
    let code: string | undefined;
    await expect
      .poll(
        async () => {
          const found = await mail.get('/api/v1/search', {
            params: { query: `to:"${email}"`, limit: '1' },
          });
          if (!found.ok()) return undefined;
          const [latest] = ((await found.json()) as MailpitSearch).messages;
          if (!latest) return undefined;
          const message = (await (
            await mail.get(`/api/v1/message/${latest.ID}`)
          ).json()) as MailpitMessage;
          code = /sign-in code is (\d{6})/.exec(message.Text)?.[1];
          return code;
        },
        { message: `a sign-in code for ${email}`, timeout: 30_000 },
      )
      .toMatch(/^\d{6}$/);
    return code!;
  } finally {
    await mail.dispose();
  }
}

// From the sign-in screen, with the code read from Mailpit as a player would read it.
export async function signIn(page: Page, email: string): Promise<void> {
  await page.getByTestId('email-input').fill(email);
  await page.getByTestId('send-code').click();
  await page.getByTestId('code-input').fill(await codeFor(email));
  await page.getByTestId('verify-code').click();
}

// A separate browser, as each player brings their own phone.
export async function newPlayer(browser: Browser, name: string, email: string): Promise<Player> {
  const context = await browser.newContext({ baseURL: ORIGIN, ignoreHTTPSErrors: true });
  return { name, email, context, page: await context.newPage() };
}

// The commissioner scripts/e2e.ts created for the spec through the CLI, signed in.
export async function commissioner(browser: Browser, spec: Spec): Promise<Player> {
  const c = await newPlayer(browser, COMMISSIONER_NAME, commissionerEmail(spec, runId()));
  await c.page.goto('/sign-in');
  await signIn(c.page, c.email);
  await expect(c.page.getByTestId('league-name')).toBeVisible();
  return c;
}

export async function inviteUrl(c: Player): Promise<string> {
  await c.page.goto('/invites');
  await c.page.getByTestId('create-invite').click();
  const url = (await c.page.getByTestId('invite-url').first().textContent())?.trim();
  expect(url).toMatch(/^https:\/\/localhost\/join\//);
  return url!;
}

// Follows the invite link through sign-in, picks a name, and waits for approval.
export async function join(player: Player, url: string, displayName = player.name) {
  await player.page.goto(url);
  await signIn(player.page, player.email);
  await player.page.getByTestId('display-name-input').fill(displayName);
  await player.page.getByTestId('join').click();
  await expect(player.page.getByTestId('awaiting-approval')).toBeVisible();
}

export async function approve(c: Player, names: string[]): Promise<void> {
  await c.page.goto('/members');
  for (const name of names) {
    const row = c.page.getByTestId('pending-member').filter({ hasText: name });
    await row.getByTestId('approve').click();
    await expect(row).toHaveCount(0);
  }
}

// The spec's seeded commissioner and the named players, all approved members.
export async function league(
  browser: Browser,
  spec: Spec,
  names: string[],
): Promise<{ commissioner: Player; players: Player[] }> {
  const c = await commissioner(browser, spec);
  const url = await inviteUrl(c);
  const players: Player[] = [];
  for (const name of names) {
    const player = await newPlayer(browser, name, emailFor(spec, name.toLowerCase(), runId()));
    await join(player, url);
    players.push(player);
  }
  await approve(c, names);
  return { commissioner: c, players };
}

// Taps a stepper's + from zero up to `value`.
export async function step(page: Page, testID: string, value: number): Promise<void> {
  for (let i = 0; i < value; i++) await page.getByTestId(`${testID}-plus`).click();
  await expect(page.getByTestId(testID)).toHaveText(String(value));
}

// Seats a member from the picker that opens under a seat.
export async function seat(page: Page, index: number, name: string): Promise<void> {
  await page.getByTestId(`seat-${index}-player`).click();
  await page.getByTestId('member-picker').getByRole('button', { name, exact: true }).click();
}

// Fills a new exhibition game: the author in seat 0, `others` in seats 1–3, then the points.
export async function exhibitionForm(
  page: Page,
  others: [string, string, string],
  points: [number, number, number, number],
  winner: 'A' | 'B',
): Promise<void> {
  await page.goto('/record-game');
  for (const [i, name] of others.entries()) await seat(page, i + 1, name);
  for (const [i, value] of points.entries()) await step(page, `seat-${i}-points`, value);
  await page.getByTestId(`winner-${winner}`).click();
}

// Confirms the one game in the player's inbox.
export async function confirmFromInbox(player: Player): Promise<void> {
  await player.page.goto('/inbox');
  await player.page.getByTestId('confirm-game').click();
  await expect(player.page.getByTestId('inbox-notice')).toContainText('Confirmed');
}

// The caller's league, as /api/me reports it, through the browser's own session.
export async function myLeague(page: Page): Promise<string> {
  const res = await page.request.get('/api/me');
  expect(res.ok()).toBe(true);
  const me = (await res.json()) as { memberships: Array<{ leagueId: string }> };
  return me.memberships[0]!.leagueId;
}

// The seat a player sits in, whatever order their team's roster lists them in.
export async function seatOf(page: Page, name: string): Promise<number> {
  for (let i = 0; i < 4; i++) {
    const label = await page.getByTestId(`seat-${i}`).textContent();
    if (label?.startsWith(name)) return i;
  }
  throw new Error(`${name} has no seat`);
}

// A player's row in the stats table.
export function statsRow(page: Page, name: string) {
  return page
    .getByTestId(/^stats-row-/)
    .filter({ has: page.getByRole('link', { name: new RegExp(`^${name}\\b`) }) });
}
