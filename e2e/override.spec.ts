import { expect, test } from '@playwright/test';
import { confirmFromInbox, exhibitionForm, league, type Player, statsRow } from './support.ts';

test('an 11–10 game goes to a commissioner, who approves it, and counts once all four confirm', async ({
  browser,
}) => {
  const { commissioner: c, players } = await league(browser, 'override', ['Bo', 'Cy', 'Di']);
  const [bo, cy, di] = players as [Player, Player, Player];

  // Bo and the commissioner win 11–10, one point short of the default win-by of 2.
  await exhibitionForm(bo.page, ['Commish', 'Cy', 'Di'], [6, 5, 5, 5], 'A');
  await expect(bo.page.getByTestId('rule-violations')).toBeVisible();
  await expect(bo.page.getByTestId('submit-game')).toBeDisabled();
  await bo.page.getByTestId('submit-for-review').click();
  await expect(bo.page.getByTestId('game-recorded')).toBeVisible();

  await c.page.goto('/overrides');
  await c.page.getByTestId(/^game-row-/).click();
  await expect(c.page.getByTestId('game-violations')).toBeVisible();
  await c.page.getByTestId('override-approve').click();
  await expect(c.page.getByTestId('game-notice')).toContainText('Approved');
  await c.page.goto('/overrides');
  await expect(c.page.getByTestId('games-empty')).toBeVisible();

  // Approved, but it counts only once all four players have confirmed.
  await confirmFromInbox(c);
  await confirmFromInbox(cy);
  await bo.page.goto('/stats');
  await bo.page.getByTestId('scope-exhibition').click();
  await expect(bo.page.getByTestId('stats-empty')).toBeVisible();

  await confirmFromInbox(di);

  await bo.page.goto('/stats');
  await bo.page.getByTestId('scope-exhibition').click();
  const row = statsRow(bo.page, 'Bo');
  await expect(row.getByTestId('cell-gp')).toHaveText('1');
  await expect(row.getByTestId('cell-w')).toHaveText('1');
  await expect(row.getByTestId('cell-pts')).toHaveText('6');
});
