# User guide

Beer Die League keeps a shared, trusted record of a 2v2 beer die league. After each game,
one player records the final line for each of the four players and says which side won.
The other three players then confirm it. A result counts in stats and standings only once
all four players have confirmed it.

The app doesn't keep live scores. You enter each game once, after it ends.

This guide is in two parts:

- **For everyone:** [Getting started](#getting-started),
  [How a result gets counted](#how-a-result-gets-counted),
  [Recording a game](#recording-a-game), [Confirming games](#confirming-games),
  [Corrections](#corrections), [Games and the game page](#games-and-the-game-page),
  [Seasons and teams](#seasons-and-teams), [Stats](#stats), [Standings](#standings),
  [Members and the league log](#members-and-the-league-log), [Your account](#your-account).
- **[For commissioners](#for-commissioners):** inviting and approving members, rules,
  seasons, reviewing games, and confirming for players who haven't responded.

At the end: [Emails](#emails), [Privacy](#privacy), and
[Troubleshooting](#troubleshooting).

To set up a server, see the [install guide](install.md).

## Quick start

**Players**

1. Open the invite link a commissioner sent you. Sign in with your email, choose the name
   other players will see, and wait for a commissioner to approve you.
2. After a game, one of the four players records it: **Record game** on Home.
3. The other three confirm it from their **Inbox**. Once all four have confirmed, it
   counts.

**Commissioners**

1. Sign in with the email the league was created with.
2. Choose **Invite players**, share the link, and approve each person on **Members**.
3. Check **Rules and settings**. To run a season, create one on **Seasons**, approve the
   teams that form, and start it.

## Getting started

### Signing in

There are no passwords. You sign in with a code sent to your email:

1. Enter your email and choose **Email me a code**.
2. Type in the 6-digit code from the email and choose **Sign in**.

- A code expires after 10 minutes and works only once. Each new code you request replaces
  the previous one.
- After five wrong tries, a code stops working, so request a new one. To change the
  email or get a new code, choose **Use a different email or resend**.
- You can request up to five codes an hour for one email address.
- You stay signed in on that browser until you sign out or go 30 days without using the
  app.

### Joining a league

To join, you need an invite link from a commissioner. It looks like
`https://league.example.com/join/…`.

1. Open the link. If you aren't signed in yet, sign in first; the app brings you back to
   the join screen afterwards.
2. Choose the name other players will see, then choose **Ask to join**.
3. Home shows that your request is awaiting a commissioner's approval. Once a commissioner
   approves it, Home shows the league.

Display names follow these rules:

- 2 to 24 characters.
- Only letters, digits, spaces, and `-` `_` `.` `'`.
- They start with a letter or a digit.
- They use letters from a single alphabet. For example, Latin and Cyrillic letters can't be
  mixed.
- They can't look like a web address, such as `bob.com`.
- No two members of a league can have the same name, ignoring upper and lower case.

Invite links expire after 14 days, and a commissioner can revoke one sooner. If the app
says a link is invalid or has expired, ask a commissioner for a new one.

### Home

Home shows the league's name and rules (for example, "First to 11, win by 2."), with links
to everything else:

| Link | What it's for |
| --- | --- |
| **Inbox** | Games waiting for you to confirm them. A red badge shows how many. |
| **Record game** | Enter the result of a game you played. |
| **Games** | Every game recorded in the league. |
| Standings snapshot | The top three teams of the current season, with a link to the full **Standings**. |
| **Stats** | Player and partnership stats. |
| **Seasons** | Seasons, their teams, and their standings. |
| **Members** | Who's in the league. This is also where you leave it. |
| **League log** | Every action a commissioner has taken. |
| **Account** | Your display name, email notifications, sign-out, and account deletion. |

Commissioners also see **Games to review**, **Invite players**, and **Rules and
settings**.

## How a result gets counted

1. **A player records the game.** Recording it counts as that player's confirmation.
2. **The other three players confirm it.** Everyone sees the same numbers. Anyone who
   disagrees proposes a correction instead, and then everyone confirms the corrected
   numbers.
3. **Once all four have confirmed, the game counts** in stats and standings.

Some limits apply:

- **There's a deadline.** Players have a set number of days to confirm, 7 unless your
  league changed it. The clock starts when the game is first recorded, and a correction
  doesn't restart it. If the deadline passes before all four confirm, the game expires and
  never counts.
- **Results are checked against the league rules.** A result that breaks them (for
  example, 11–10 in a win-by-2 league) can still be sent for commissioner review. It
  counts only if a commissioner approves it *and* all four players confirm it.
- **Commissioners can confirm for a silent player.** Each time they do, it's recorded in
  the league log and shown on the game. Any player can still propose a correction, which
  resets every confirmation.

## Recording a game

Record a game soon after you play it. The app saves the time you opened the form as the
time the game was played, and you can't change it.

1. On Home, choose **Record game**.
2. Choose **Season game** or **Exhibition**:
   - A **season game** is your team against another approved team in the active season.
     You can choose it only if you're on an approved team this season.
   - An **exhibition** is any four approved members. It counts toward exhibition and
     combined stats, but not toward season stats or standings.
3. Choose the players. You're always on Side A.
   - **Exhibition:** choose **Choose player** for each of the other three places. Your
     partner goes on Side A, and the opponents go on Side B.
   - **Season game:** your partner is already filled in. Choose **Choose the opposing
     team**, and its players fill Side B. If someone couldn't play, choose **Swap in sub**
     next to their name and pick who played instead. Each side can have one sub. A sub can
     be any approved member, even someone from a third team, but not a player from the
     opposing team.
4. Enter each player's **points** and **sinks** with the **−** and **+** buttons. Points
   include any points a sink is worth. Each value can be 0 to 99.
5. Choose the side that won: **Side A won** or **Side B won**.
6. Choose **Submit game**.

The app then shows "Game recorded". The other three players get the game in their inbox
and, unless they've turned email off, an email.

### What the form checks

As you fill in the form, a message under it says what's still missing, such as "Choose all
four players." or "Tap the side that won." It also lists mistakes that block submission,
for example "Points must include 3 for each sink." when sinks are worth 3 points.

Once the form is complete, it checks the result against the league rules. A result that
breaks them shows "This result breaks the league rules:", followed by one or more of
these:

| Message | What it means |
| --- | --- |
| The winning side needs at least N points. | The winning side's total is below the target score. |
| The winning side must lead by at least N. | The winning side didn't win by enough. |
| The game was already over before the final score. | The game was already won before the last point or sink was scored. For example, with the default rules (first to 11, win by 2), 13–10 isn't a possible final score, because the game ended at 12–10. |
| A sink ends the game, so the losing side cannot have one. | In leagues where a sink ends the game. |
| A sink ends the game, so the winning side can have at most one. | In leagues where a sink ends the game. |
| The game was already over before the final sink. | In leagues where a sink ends the game, a winning sink can come from behind, but it can't come after the game was already won on points. |

The app checks only that the final score is a possible end to a game. It doesn't try to
work out the order of every point.

If the numbers are wrong, fix them. If they're right (a forfeit, say, or a game played
under different rules), choose **Submit for commissioner review**. The game then counts
only if a commissioner approves it and all four players confirm it.

### If the connection drops

The form is saved on your device as you fill it in:

- **If you leave and come back,** the form says it restored the game you started.
  To throw it away, choose **Discard and start over**.
- **If submitting fails,** the button changes to **Retry**. Choose it once you're back
  online. The game is never recorded twice, however many times you retry, even after you
  reload the page.

The saved form stays on that device and browser only. Signing out deletes it.

## Confirming games

Your **Inbox** lists every game you played in that's waiting for your confirmation, with
the numbers and the deadline. For each one:

- If the numbers are right, choose **Confirm these numbers**.
- If they're wrong, choose **Propose a correction**. See [Corrections](#corrections).
- To see more, including who else has confirmed, choose **Open the game**.

You always confirm exactly the numbers on your screen. If someone corrected the game
after you loaded it, the app saves nothing and says "That game changed after you loaded
it". Check the latest numbers and confirm again.

The inbox shows up to 50 games, the ones with the nearest deadlines first.

## Corrections

### Correcting a game that's waiting for confirmation

Any of the four players can propose a correction, from the inbox or the game's page. The
form opens with the current numbers filled in, and you can change the points, the sinks,
and the winner. Choose **Send correction** when you're done.

- A correction can't change who played, and it keeps the original play time. If the
  wrong players are on a game, don't confirm it. Let it expire, and record the game again.
- A correction resets everyone else's confirmation, and your own confirmation of the new
  numbers is recorded. The other three get the game in their inbox again.
- The deadline stays the same.
- The result is checked against the rules in force when the game was first recorded, even
  if the league's rules have changed since.

### Reopening a confirmed game

If a game that already counts turns out to be wrong, any of its four players can choose
**Reopen with a correction** on its page. You can reopen:

- an **exhibition game** for up to 30 days after it was confirmed, unless your league
  changed that limit;
- a **season game** only while its season is still active.

While the correction waits for confirmation, the confirmed result keeps counting. The
correction replaces it only once all four players confirm it. Reopening starts a new
deadline. If the correction expires or is rejected, the confirmed result stands.

## Games and the game page

**Games** lists every game in the league, newest first, whether it counts yet or not. To
see older games, choose **Show older games** at the bottom.

Each game has one of these statuses:

| Status | Meaning |
| --- | --- |
| Waiting for confirmations | It counts once all four players confirm it. |
| Waiting for a commissioner's review | It breaks the league rules, and a player sent it for review. |
| Rejected by a commissioner | A commissioner rejected it on review. The players can still correct it before the deadline. |
| Confirmed | All four players confirmed it, so it counts. |
| Confirmed; a correction is waiting | Someone reopened the game. The confirmed result counts until all four confirm the correction. |
| Expired | The deadline passed before all four players confirmed it, so it never counted. |
| Voided | Before the game was confirmed, a player left the league, was removed, or deleted their account. It never counts. |

A game's page shows:

- How long is left to confirm it.
- The numbers waiting for confirmation and, for a reopened game, the result that counts
  in the meantime.
- Each player's confirmation: **✓** if they confirmed, **pending** if they haven't, or
  **✓ forced by** and a commissioner's name if a commissioner confirmed for them. If that
  commissioner played in the game, it adds "who played in this game".
- Rule problems, and whether a commissioner approved or rejected them.
- The game's **History**: each revision, who made it, and what changed. For example:
  "Sam: 9 → 11 points".
- **Commissioner actions** on the game, such as confirmations made for silent players.

## Seasons and teams

A season is a stretch of play with registered two-player teams and standings. Commissioners
start and end seasons. **Seasons** lists every season, with links to its **Teams** and
**Standings**.

A season's status is one of these:

| Status | Meaning |
| --- | --- |
| Draft | Created but not started. Teams can form, but season games can't be recorded yet. |
| Active | Season games can be recorded. Only one season is active at a time. |
| Ended, waiting for open games to settle | No new season games can be recorded. Games already recorded can still be confirmed or corrected until their deadlines. |
| Finalized | Every game is settled. Standings are final, and teams can no longer change. |

### Forming a team

While a season is in draft or active:

1. Open the season's **Teams** and fill in **Propose a team**. Enter a team name of up
   to 40 characters, pick your partner, and choose **Propose team**.
2. Your partner sees the team on the same screen and chooses **Accept** (or **Decline**).
   The app doesn't email them about it, so let them know.
3. A commissioner approves the team.

- Until your partner accepts, only the two of you and the commissioners can see the team.
- Either player can withdraw the team until a commissioner approves it.
- Each player can be on one team per season, and you can make up to 10 team proposals per
  season.

### Subs

A season game can have one sub per side (see [Recording a game](#recording-a-game)). In
the standings, the win or loss goes to the team the sub played for. The game also appears
in the sub's own player stats for that season, with their points, sinks, and the result.

## Stats

**Stats** has a tab for each scope:

| Tab | Games counted |
| --- | --- |
| A season's name | That season's games, including games played as a sub. |
| **Combined** (the default) | Every counted game. |
| **Exhibition** | Exhibition games only. |
| **All-time** | Season games from every season. Exhibitions aren't included. |

The **players** table has these columns:

| Column | Meaning |
| --- | --- |
| GP | Games played |
| W / L | Wins and losses |
| Win% | Win percentage |
| Pts | Points, including sink points |
| PPG | Points per game |
| Sinks | Sinks |
| S/G | Sinks per game |

The **partnerships** table shows each pair who played on the same side, subs included:
games played together, wins, losses, win percentage, and both players' combined points
and sinks.

Select a name to open that player's profile, which has the same numbers and the same
tabs. A dash (–) means there are no games to compute the number from. Former members are
marked "(former member)".

Only confirmed games count. While a reopened game waits, its old confirmed result still
counts.

## Standings

Each season has standings, and Home shows the top three teams of the current season.

| Column | Meaning |
| --- | --- |
| # | Rank. "T-2" means two or more teams share second place. A dash (–) means unranked. |
| GP, W, L, Win% | Games played, wins, losses, and win percentage |
| PF | Points for, including sink points |
| PA | Points against |
| Diff | Point difference (PF − PA) |
| Sinks | Sinks |

Teams are ranked by the season's ranking order, which the standings page names. The
default is Win %, then Head-to-head, then Point difference, then Sinks. Each item breaks
ties left by the items before it:

- **Head-to-head** compares win percentage only in the games the tied teams played against
  each other. It applies only when each tied team has played at least one of the others.
- Teams still tied after the whole order share a rank, listed by name.

A team without a game is listed but unranked. A commissioner can also set a minimum number
of games before a team is ranked.

## Members and the league log

**Members** lists the league's members and marks the commissioners.

The **League log** records every commissioner action, newest first. Nobody can edit or
remove an entry. When the commissioner had a stake in the action, the entry says so with
"(played in this game)", "(on this team)", or "(played in a voided game)". The log
includes:

- rule and setting changes;
- confirmations made for silent players;
- approved and rejected reviews;
- seasons started and ended, and standings settings changed;
- teams approved or rejected, and team players changed;
- members removed.

## Your account

On **Account**:

- **Display name:** changing it here changes it everywhere it appears, past games
  included. The same rules apply as when you joined. You can change it about ten times an
  hour.
- **Email notifications:** the switch "Email me when a game I played is recorded or
  corrected". For commissioners, it also turns the commissioner emails on or off (see
  [Emails](#emails)).
- **Sign out:** signs this browser out and deletes any unsent game form saved on it.

### Leaving the league

At the bottom of **Members**, choose **Leave league**, then confirm.

- Your games that are still waiting for confirmation are voided, and you come off your
  teams.
- Your confirmed games still count, so nobody else's record changes. Your name stays on
  them, marked "(former member)".
- You can't undo this, and your account can't rejoin the league.
- If you're the league's last commissioner, make someone else a commissioner first.

### Deleting your account

At the bottom of **Account**, choose **Delete account**, then confirm.

- Your email, sign-in sessions, and pending emails are erased, and you leave the league
  as described above.
- Your confirmed games still count. They show you as "Deleted player #N", unless you turn
  on **Keep my name on my games** first. A kept name stays reserved, so nobody else can
  take it.
- Backups still hold deleted data for up to 14 days.
- If you're the last commissioner of a league that has other members, make someone else a
  commissioner first.
- Signing up again later with the same email creates a new account with no link to the
  old one.

## For commissioners

The server operator creates the league and its first commissioner (see the
[install guide](install.md#4-create-the-league)). Sign in with that email address.

Everything a commissioner does to games, seasons, teams, rules, and members appears in
the [league log](#members-and-the-league-log), where every member can see it.

### Inviting players

1. On Home, choose **Invite players**, then **Create invite link**.
2. Copy the link and share it. The app shows the link only once.

- A link works for any number of people until it expires after 14 days. Anyone who has it
  can ask to join, and you approve every request.
- **Active links** lists your links. Choose **Revoke** to stop a link working at once.
- When a commissioner leaves the league or is removed, the links they created stop
  working.

### Approving members

When someone asks to join, commissioners get an email ("A new member is awaiting
approval"). Their request appears under **Awaiting approval** on **Members**, with their
display name and email. Members' emails are visible only at this stage.

- **Approve** lets them in.
- **Reject** deletes the request and frees the name. They can ask again with a valid link.

### Roles

On **Members**, choose **Make commissioner** next to a member, or **Make member** next to
a commissioner. A league can have several commissioners, but it always needs at least
one. Role changes don't appear in the league log.

### Removing a member

On **Members**, choose **Remove** next to the member, then confirm.

- Their games that are still waiting for confirmation are voided.
- They come off their teams. An approved team keeps its place with one player until you
  change its players.
- Their confirmed games still count, under their name, marked "(former member)".
- This can't be undone, and they can't rejoin with the same account.
- You can't remove yourself. Use **Leave league** instead.

### Rules and settings

On Home, choose **Rules and settings**.

| Rule or setting | Range | Default |
| --- | --- | --- |
| Target score | 1–99 | 11 |
| Win by | 1–99 | 2 |
| Points for a sink | 0–99 | 0 |
| A sink ends the game | on or off | off |
| Days players have to confirm a game | 1–30 | 7 |
| Days an exhibition game can be reopened after it is confirmed | 0–365 | 30 |

**Points for a sink** is how many points a sink adds to the scorer's points. With 0, a
sink is tracked as a stat but adds no points.

Changes apply only to games recorded from then on. A game keeps the rules and the
deadline it was first recorded with, so changing the rules never changes a game that's
already recorded, or anyone's stats.

### Running a season

1. **Create it.** On **Seasons**, enter a name under **New season** and choose **Create
   draft season**.
2. **Set the standings rules (optional).** Each season card has **Standings settings**:
   - Reorder the ranking metrics with **↑** and **↓**, remove them with **Remove**, or add
     one with its **+** button. The metrics are Win %, Wins, Point difference, Points for,
     Sinks, and Head-to-head.
   - Set the **Minimum games to be ranked** (0–99).
   - Choose **Save standings settings**. You can change these until the season is
     finalized.
3. **Approve teams.** Players propose teams on the season's **Teams** screen. Once a
   partner accepts, choose **Approve**. Choose **Reject** for any team still waiting for
   approval.
4. **Start it.** Choose **Start season**. Season games can be recorded from then on, and
   only one season can be active at a time.
5. **During the season,** approve new teams as they form. To change an approved team's
   players, choose **Change players**, pick two players, and choose **Save players**. Games
   already recorded keep the players who played them.
6. **End it.** Choose **End season** and confirm. This can't be undone. No new season
   games can be recorded, but games already recorded can still be confirmed or corrected
   until their deadlines.

The season then finalizes by itself as soon as no game in it is waiting for confirmation.
Its standings become final, and its teams and standings settings lock. Until then, you can
still reject or change teams.

### Reviewing games that break the rules

When players send a game for review, commissioners get an email ("A game is waiting for
commissioner review"). **Games to review** on Home lists every such game. Open one to see
its numbers and the rules it breaks, then choose:

- **Approve:** the game counts once all four players have confirmed it. That can happen
  before or after your approval.
- **Reject:** the game won't count as it stands. The players can still correct it before
  the deadline.

You can decide on a game you played in. The league log flags that you did.

### Confirming for silent players

If a player hasn't responded, open the game's page. The **Confirm for silent players**
panel lists the players who haven't confirmed yet:

1. Select one or more of them.
2. Choose **Confirm for the selected players**.

- Each confirmation is recorded in the league log, and the game shows "✓ forced by" your
  name, flagged when you played in the game.
- You can't confirm on your own behalf. If you played, confirm as a player.
- Any player can still propose a correction, which resets every confirmation.

### Recovering a league without a commissioner

If the league ever has no commissioner, the server operator can make an approved member
a commissioner. See the
[install guide](install.md#recover-a-league-with-no-commissioner).

## Emails

The app sends these emails:

| Subject | Sent to | When |
| --- | --- | --- |
| Your Beer Die League sign-in code | You | You ask for a sign-in code. |
| A new game is waiting for your confirmation | The other players in the game | A player records a game. |
| A corrected game is waiting for your confirmation | The other players in the game | A player corrects or reopens a game. |
| A new member is awaiting approval | Commissioners | Someone asks to join. |
| A game is waiting for commissioner review | Commissioners, other than the one who sent it | A player sends a game for review. |

Game emails carry the player's name and a link, never scores. Turning off email
notifications on **Account** stops every email except sign-in codes.

## Privacy

- Only approved members can see anything in a league: games, stats, standings, members,
  and the log.
- Commissioners see a person's email only while that person is waiting for approval.
- Emails never contain scores or stats.
- Nightly backups keep data, including deleted data, for up to 14 days.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| The sign-in code doesn't arrive. | Wait a minute and check your spam folder. Then choose **Use a different email or resend** to request another. |
| "That code is wrong or has expired." | Codes last 10 minutes, and only the newest one works. Request a new one. |
| "Too many attempts. Wait a while and try again." | You've hit a sign-in limit. Wait an hour or so, then try again. |
| "This invite link is invalid or has expired." | Ask a commissioner for a new link. |
| "That name is taken in this league." | Choose another display name. |
| **Season game** can't be selected. | You need to be on an approved team in the active season. The form says which part is missing. |
| "That game changed after you loaded it, so nothing was saved." | Someone corrected the game meanwhile. Check the latest numbers, then act again. |
| "The window to confirm that game closed, so it won't count." | The deadline passed. Record the game again if it should count. |
| "The window to correct this game has closed." | The game can no longer be corrected or reopened. |
| Submitting keeps failing, though your connection works. | Each member can record or correct up to 30 games an hour. Wait, then choose **Retry**. |
| A game shows "Voided". | Before it was confirmed, one of its players left the league, was removed, or deleted their account. Record it again with current members if it should count. |
| "A league needs at least one commissioner." | Make another member a commissioner first. |
