ALTER TABLE "game_revisions" ADD COLUMN "season_id" uuid;--> statement-breakpoint
ALTER TABLE "game_revisions" ADD COLUMN "side_a_team_id" uuid;--> statement-breakpoint
ALTER TABLE "game_revisions" ADD COLUMN "side_b_team_id" uuid;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_id_season_unique" UNIQUE("id","season_id");--> statement-breakpoint
ALTER TABLE "game_revisions" ADD CONSTRAINT "game_revisions_game_season_fk" FOREIGN KEY ("game_id","season_id") REFERENCES "public"."games"("id","season_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_revisions" ADD CONSTRAINT "game_revisions_side_a_team_season_fk" FOREIGN KEY ("side_a_team_id","season_id") REFERENCES "public"."season_teams"("id","season_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_revisions" ADD CONSTRAINT "game_revisions_side_b_team_season_fk" FOREIGN KEY ("side_b_team_id","season_id") REFERENCES "public"."season_teams"("id","season_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_revisions" ADD CONSTRAINT "game_revisions_teams_both_or_neither" CHECK (("game_revisions"."side_a_team_id" is null) = ("game_revisions"."side_b_team_id" is null));--> statement-breakpoint
ALTER TABLE "game_revisions" ADD CONSTRAINT "game_revisions_teams_have_season" CHECK (("game_revisions"."season_id" is null) = ("game_revisions"."side_a_team_id" is null));--> statement-breakpoint
ALTER TABLE "game_revisions" ADD CONSTRAINT "game_revisions_teams_distinct" CHECK ("game_revisions"."side_a_team_id" <> "game_revisions"."side_b_team_id");