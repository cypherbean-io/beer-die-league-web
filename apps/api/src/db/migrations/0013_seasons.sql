CREATE TABLE "seasons" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"league_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"standings_config" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "seasons_id_league_unique" UNIQUE("id","league_id"),
	CONSTRAINT "seasons_status_valid" CHECK ("seasons"."status" in ('draft', 'active', 'ended', 'finalized')),
	CONSTRAINT "seasons_started_has_time" CHECK (("seasons"."status" <> 'draft') = ("seasons"."started_at" is not null)),
	CONSTRAINT "seasons_ended_has_time" CHECK (("seasons"."status" in ('ended', 'finalized')) = ("seasons"."ended_at" is not null)),
	CONSTRAINT "seasons_finalized_has_time" CHECK (("seasons"."status" = 'finalized') = ("seasons"."finalized_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "season_id" uuid;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "seasons_league_id_idx" ON "seasons" USING btree ("league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seasons_one_active_per_league" ON "seasons" USING btree ("league_id") WHERE "seasons"."status" = 'active';--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_season_league_fk" FOREIGN KEY ("season_id","league_id") REFERENCES "public"."seasons"("id","league_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "games_season_open_idx" ON "games" USING btree ("season_id") WHERE "games"."open_revision_id" is not null;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_season_matches_kind" CHECK (("games"."kind" = 'season') = ("games"."season_id" is not null));