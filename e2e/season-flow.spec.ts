import { expect, type Page, test } from '@playwright/test';
import { runId } from './seed.ts';
import { confirmFromInbox, league, type Player, seatOf, statsRow, step } from './support.ts';

async function proposeTeam(page: Page, name: string, partner: string): Promise<void> {
  await page.getByTestId('team-name-input').fill(name);
  await page.getByTestId('partner-option').filter({ hasText: partner }).click();
  await page.getByTestId('propose-team').click();
  await expect(page.getByTestId('team').filter({ hasText: name })).toBeVisible();
}

// Presses a team's action button and waits for it to go.
async function onTeam(page: Page, team: string, action: 'accept' | 'approve'): Promise<void> {
  const button = page.getByTestId('team').filter({ hasText: team }).getByTestId(`team-${action}`);
  await button.click();
  await expect(button).toHaveCount(0);
}

async function seasonStats(page: Page, season: string, name: string) {
  await page.goto('/stats');
  await page.getByRole('tab', { name: season }).click();
  return statsRow(page, name);
}

test('a season game counts for its teams and players, and a correction replaces it once all four confirm', async ({
  browser,
}) => {
  const { commissioner: c, players } = await league(browser, 'season-flow', ['Bo', 'Cy', 'Di']);
  const [bo, cy, di] = players as [Player, Player, Player];
  const season = `Fall ${runId()}`;

  // The commissioner and Bo are the Sharks; Cy and Di the Jets.
  await c.page.goto('/seasons');
  await c.page.getByTestId('season-name-input').fill(season);
  await c.page.getByTestId('create-season').click();
  const card = c.page.getByTestId('season').filter({ hasText: season });
  await card.getByTestId('season-teams-link').click();
  await expect(c.page).toHaveURL(/\/teams\//);
  const teams = new URL(c.page.url()).pathname;
  await proposeTeam(c.page, 'Sharks', 'Bo');
  await cy.page.goto(teams);
  await proposeTeam(cy.page, 'Jets', 'Di');
  await bo.page.goto(teams);
  await onTeam(bo.page, 'Sharks', 'accept');
  await di.page.goto(teams);
  await onTeam(di.page, 'Jets', 'accept');
  await c.page.goto(teams);
  await onTeam(c.page, 'Sharks', 'approve');
  await onTeam(c.page, 'Jets', 'approve');
  await c.page.goto('/seasons');
  await card.getByTestId('start-season').click();
  await expect(card.getByTestId('season-status')).toHaveText(/active/i);

  // Bo records it: the Sharks beat the Jets 11–9, with a sink for Bo.
  const page = bo.page;
  await page.goto('/record-game');
  await page.getByTestId('kind-season').click();
  await page.getByTestId('choose-opponent').click();
  await page.getByTestId('team-picker').getByRole('button', { name: 'Jets' }).click();
  const lines: Array<[string, number, number]> = [
    ['Bo', 6, 1],
    ['Commish', 5, 0],
    ['Cy', 5, 0],
    ['Di', 4, 0],
  ];
  for (const [name, points, sinks] of lines) {
    const i = await seatOf(page, name);
    await step(page, `seat-${i}-points`, points);
    await step(page, `seat-${i}-sinks`, sinks);
  }
  await page.getByTestId('winner-A').click();
  await page.getByTestId('submit-game').click();
  await expect(page.getByTestId('game-recorded')).toBeVisible();

  for (const p of [c, cy, di]) await confirmFromInbox(p);

  await page.goto(teams.replace('/teams/', '/standings/'));
  const sharks = page.getByTestId(/^standings-row-/).filter({ hasText: 'Sharks' });
  const jets = page.getByTestId(/^standings-row-/).filter({ hasText: 'Jets' });
  await expect(sharks.getByTestId('cell-w')).toHaveText('1');
  await expect(jets.getByTestId('cell-l')).toHaveText('1');
  const boLine = await seasonStats(page, season, 'Bo');
  await expect(boLine.getByTestId('cell-pts')).toHaveText('6');
  await expect(boLine.getByTestId('cell-sinks')).toHaveText('1');

  // Cy reopens the game to fix Di's 4 points to 3.
  await cy.page.goto('/games');
  await cy.page.getByTestId(/^game-row-/).click();
  await cy.page.getByTestId('propose-correction').click();
  await expect(cy.page.getByTestId('correction-note')).toBeVisible();
  const diSeat = await seatOf(cy.page, 'Di');
  await cy.page.getByTestId(`seat-${diSeat}-points-minus`).click();
  await expect(cy.page.getByTestId(`seat-${diSeat}-points`)).toHaveText('3');
  await cy.page.getByTestId('submit-game').click();
  await expect(cy.page.getByTestId('game-corrected')).toBeVisible();

  // The other three see it waiting in their inbox, and the confirmed numbers still count.
  for (const p of [bo, c, di]) {
    await p.page.goto('/');
    await expect(p.page.getByTestId('inbox-badge')).toHaveText(/1/);
  }
  await expect((await seasonStats(di.page, season, 'Di')).getByTestId('cell-pts')).toHaveText('4');
  await confirmFromInbox(bo);
  await confirmFromInbox(c);
  await expect((await seasonStats(di.page, season, 'Di')).getByTestId('cell-pts')).toHaveText('4');

  await confirmFromInbox(di);

  await expect((await seasonStats(di.page, season, 'Di')).getByTestId('cell-pts')).toHaveText('3');
  await expect((await seasonStats(di.page, season, 'Bo')).getByTestId('cell-pts')).toHaveText('6');
});
