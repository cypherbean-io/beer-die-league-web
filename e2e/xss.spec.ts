import { expect, test } from '@playwright/test';
import { emailFor, runId } from './seed.ts';
import { approve, commissioner, inviteUrl, newPlayer, ORIGIN, signIn } from './support.ts';

const MARKUP = '<img src=x onerror=alert(1)>';

test('a display name with markup is refused, and one with an apostrophe renders as text', async ({
  browser,
}) => {
  const c = await commissioner(browser, 'xss');
  const url = await inviteUrl(c);
  const player = await newPlayer(browser, "O'Neil", emailFor('xss', 'oneil', runId()));
  const dialogs: string[] = [];
  for (const page of [c.page, player.page]) {
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
  }

  await player.page.goto(url);
  await signIn(player.page, player.email);
  const name = player.page.getByTestId('display-name-input');
  await name.fill(MARKUP);
  await expect(player.page.getByTestId('display-name-hint')).toBeVisible();
  await expect(player.page.getByTestId('join')).toBeDisabled();

  // The server refuses it too, whatever a client sends.
  const token = url.slice(`${ORIGIN}/join/`.length);
  const refused = await player.page.request.post(`/api/invites/${token}/join`, {
    data: { displayName: MARKUP },
    headers: { origin: ORIGIN },
  });
  expect(refused.status()).toBe(422);

  await name.fill("O'Neil");
  await player.page.getByTestId('join').click();
  await expect(player.page.getByTestId('awaiting-approval')).toBeVisible();

  await c.page.goto('/members');
  await expect(c.page.getByTestId('pending-member').filter({ hasText: "O'Neil" })).toBeVisible();
  await approve(c, ["O'Neil"]);
  await expect(c.page.getByTestId('member').filter({ hasText: "O'Neil" })).toBeVisible();

  for (const page of [c.page, player.page]) {
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
  }
  expect(dialogs).toEqual([]);
});
