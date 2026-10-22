import { expect, test } from '@playwright/test';
import { exhibitionForm, league, myLeague } from './support.ts';

type StoredDrafts = Record<string, { idempotencyKey: string; attempted: boolean }>;

test('a game submitted offline stays as a draft and is recorded exactly once on retry', async ({
  browser,
}) => {
  const { players } = await league(browser, 'offline-retry', ['Bo', 'Cy', 'Di']);
  const bo = players[0]!;
  const { page, context } = bo;
  // Bo and the commissioner beat Cy and Di 11–9.
  await exhibitionForm(page, ['Commish', 'Cy', 'Di'], [6, 5, 5, 4], 'A');

  await context.setOffline(true);
  await page.getByTestId('submit-game').click();

  await expect(page.getByTestId('submit-error')).toBeVisible();
  await expect(page.getByTestId('submit-game')).toHaveText('Retry');
  const drafts = async () =>
    JSON.parse(
      (await page.evaluate(() => localStorage.getItem('beerdie:drafts'))) ?? '{}',
    ) as StoredDrafts;
  const [kept] = Object.values(await drafts());
  expect(kept).toMatchObject({ attempted: true });

  // Back online, after a reload the draft is still there, with the same key.
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByTestId('draft-restored')).toBeVisible();
  await expect(page.getByTestId('seat-3-points')).toHaveText('4');
  expect(Object.values(await drafts())[0]?.idempotencyKey).toBe(kept!.idempotencyKey);
  await expect(page.getByTestId('submit-game')).toHaveText('Retry');

  await page.getByTestId('submit-game').click();

  await expect(page.getByTestId('game-recorded')).toBeVisible();
  expect(await drafts()).toEqual({});
  const res = await page.request.get(`/api/leagues/${await myLeague(page)}/games`);
  expect(res.ok()).toBe(true);
  expect(((await res.json()) as { games: unknown[] }).games).toHaveLength(1);
});
