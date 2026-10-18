CREATE TABLE "confirmations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"revision_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "confirmations_revision_membership_unique" UNIQUE("revision_id","membership_id"),
	CONSTRAINT "confirmations_kind_valid" CHECK ("confirmations"."kind" in ('player', 'forced'))
);
--> statement-breakpoint
CREATE TABLE "game_revisions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"game_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"status" text NOT NULL,
	"created_by" uuid NOT NULL,
	"played_at" timestamp with time zone NOT NULL,
	"winner" text NOT NULL,
	"rule_violations" jsonb NOT NULL,
	"override_status" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "game_revisions_game_number_unique" UNIQUE("game_id","number"),
	CONSTRAINT "game_revisions_number_min" CHECK ("game_revisions"."number" >= 1),
	CONSTRAINT "game_revisions_status_valid" CHECK ("game_revisions"."status" in ('open', 'confirmed', 'superseded', 'expired', 'voided', 'rejected')),
	CONSTRAINT "game_revisions_winner_valid" CHECK ("game_revisions"."winner" in ('A', 'B')),
	CONSTRAINT "game_revisions_override_status_valid" CHECK ("game_revisions"."override_status" in ('requested', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"league_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"open_revision_id" uuid,
	"window_expires_at" timestamp with time zone,
	"rules_snapshot" jsonb NOT NULL,
	"submitted_by" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"payload_sha256" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "games_idempotency_unique" UNIQUE("league_id","submitted_by","idempotency_key"),
	CONSTRAINT "games_kind_valid" CHECK ("games"."kind" in ('season', 'exhibition')),
	CONSTRAINT "games_status_valid" CHECK ("games"."status" in ('pending', 'confirmed', 'expired', 'voided'))
);
--> statement-breakpoint
CREATE TABLE "revision_players" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"revision_id" uuid NOT NULL,
	"side" text NOT NULL,
	"membership_id" uuid NOT NULL,
	"is_sub" boolean NOT NULL,
	"points" integer NOT NULL,
	"sinks" integer NOT NULL,
	CONSTRAINT "revision_players_revision_membership_unique" UNIQUE("revision_id","membership_id"),
	CONSTRAINT "revision_players_side_valid" CHECK ("revision_players"."side" in ('A', 'B')),
	CONSTRAINT "revision_players_points_range" CHECK ("revision_players"."points" between 0 and 99),
	CONSTRAINT "revision_players_sinks_range" CHECK ("revision_players"."sinks" between 0 and 99)
);
--> statement-breakpoint
ALTER TABLE "confirmations" ADD CONSTRAINT "confirmations_revision_player_fk" FOREIGN KEY ("revision_id","membership_id") REFERENCES "public"."revision_players"("revision_id","membership_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_revisions" ADD CONSTRAINT "game_revisions_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_revisions" ADD CONSTRAINT "game_revisions_created_by_memberships_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_open_revision_id_game_revisions_id_fk" FOREIGN KEY ("open_revision_id") REFERENCES "public"."game_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_submitted_by_memberships_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_players" ADD CONSTRAINT "revision_players_revision_id_game_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."game_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_players" ADD CONSTRAINT "revision_players_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;