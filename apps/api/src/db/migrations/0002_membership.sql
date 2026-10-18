CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"league_id" uuid NOT NULL,
	"token_sha256" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "invites_token_sha256_unique" UNIQUE("token_sha256")
);
--> statement-breakpoint
CREATE TABLE "leagues" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"target_score" integer DEFAULT 11 NOT NULL,
	"win_by" integer DEFAULT 2 NOT NULL,
	"sink_points" integer DEFAULT 0 NOT NULL,
	"sink_ends_game" boolean DEFAULT false NOT NULL,
	"confirmation_window_days" integer DEFAULT 7 NOT NULL,
	"exhibition_correction_window_days" integer DEFAULT 30 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "leagues_target_score_min" CHECK ("leagues"."target_score" >= 1),
	CONSTRAINT "leagues_win_by_min" CHECK ("leagues"."win_by" >= 1),
	CONSTRAINT "leagues_sink_points_min" CHECK ("leagues"."sink_points" >= 0),
	CONSTRAINT "leagues_confirmation_window_days_range" CHECK ("leagues"."confirmation_window_days" between 1 and 30),
	CONSTRAINT "leagues_exhibition_correction_window_days_range" CHECK ("leagues"."exhibition_correction_window_days" between 0 and 365)
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"league_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"name_key" text NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"email_notifications" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "memberships_league_name_key_unique" UNIQUE("league_id","name_key"),
	CONSTRAINT "memberships_league_user_unique" UNIQUE("league_id","user_id"),
	CONSTRAINT "memberships_role_valid" CHECK ("memberships"."role" in ('member', 'commissioner')),
	CONSTRAINT "memberships_status_valid" CHECK ("memberships"."status" in ('pending', 'approved', 'removed', 'left', 'deleted'))
);
--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_memberships_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invites_league_id_idx" ON "invites" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX "memberships_user_id_idx" ON "memberships" USING btree ("user_id");