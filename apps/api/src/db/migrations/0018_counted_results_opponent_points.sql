DROP VIEW "public"."counted_results";--> statement-breakpoint
CREATE VIEW "public"."counted_results" AS (
  select g.league_id, g.id as game_id, g.kind, r.id as revision_id, r.played_at, r.season_id,
         p.membership_id, p.side, q.membership_id as partner_membership_id,
         case p.side when 'A' then r.side_a_team_id else r.side_b_team_id end as team_id,
         p.is_sub, p.side = r.winner as won, p.points, p.sinks,
         (select sum(o.points) from revision_players o
          where o.revision_id = r.id and o.side <> p.side)::int as opponent_points
  from games g
  join game_revisions r on r.id = g.confirmed_revision_id and r.game_id = g.id
  join revision_players p on p.revision_id = r.id
  join revision_players q
    on q.revision_id = r.id and q.side = p.side and q.membership_id <> p.membership_id
);