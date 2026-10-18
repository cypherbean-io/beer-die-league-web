DROP VIEW "public"."counted_results";--> statement-breakpoint
CREATE VIEW "public"."counted_results" AS (
  select g.league_id, g.id as game_id, g.kind, r.id as revision_id, r.played_at,
         p.membership_id, p.side, q.membership_id as partner_membership_id, p.is_sub,
         p.side = r.winner as won, p.points, p.sinks
  from games g
  join game_revisions r on r.id = g.confirmed_revision_id and r.game_id = g.id
  join revision_players p on p.revision_id = r.id
  join revision_players q
    on q.revision_id = r.id and q.side = p.side and q.membership_id <> p.membership_id
);