import { expect, test } from '@playwright/test';
import { league, type Player } from './support.ts';

const COMMISSIONER_LINKS = ['overrides-link', 'invites-link', 'league-settings-link'];

test('the tab bar takes a member between the tabs, and to record a game', async ({ browser }) => {
  const { commissioner: c, players } = await league(browser, 'navigation', ['Bo']);
  const [bo] = players as [Player];

  await bo.page.goto('/');
  await expect(bo.page.getByTestId('tab-home')).toHaveAttribute('aria-current', 'page');

  await bo.page.getByTestId('tab-games').click();
  await expect(bo.page).toHaveURL(/\/games$/);
  await expect(bo.page.getByTestId('tab-games')).toHaveAttribute('aria-current', 'page');
  await expect(bo.page.getByTestId('tab-home')).not.toHaveAttribute('aria-current', 'page');

  await bo.page.getByTestId('tab-stats').click();
  await expect(bo.page).toHaveURL(/\/stats$/);
  await expect(bo.page.getByTestId('scope-combined')).toBeVisible();

  // Members see the league's pages, but not the commissioner's.
  await bo.page.getByTestId('tab-league').click();
  await expect(bo.page).toHaveURL(/\/league$/);
  await expect(bo.page.getByTestId('members-link')).toBeVisible();
  for (const id of COMMISSIONER_LINKS) await expect(bo.page.getByTestId(id)).toHaveCount(0);
  await bo.page.getByTestId('members-link').click();
  await expect(bo.page).toHaveURL(/\/members$/);

  // Recording a game is its own screen, without the tab bar.
  await bo.page.goto('/');
  await bo.page.getByTestId('tab-record').click();
  await expect(bo.page).toHaveURL(/\/record-game$/);
  await expect(bo.page.getByTestId('tab-home')).toBeHidden();

  await c.page.goto('/league');
  for (const id of COMMISSIONER_LINKS) await expect(c.page.getByTestId(id)).toBeVisible();
});

test('signed out, there is no tab bar', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByTestId('email-input')).toBeVisible();
  await expect(page.getByTestId('tab-home')).toBeHidden();
});
