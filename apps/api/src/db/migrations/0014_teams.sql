CREATE TABLE "season_teams" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"season_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"status" text NOT NULL,
	"proposed_by" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "season_teams_id_season_unique" UNIQUE("id","season_id"),
	CONSTRAINT "season_teams_status_valid" CHECK ("season_teams"."status" in ('proposed', 'accepted', 'approved', 'rejected', 'withdrawn')),
	CONSTRAINT "season_teams_partner_not_proposer" CHECK ("season_teams"."partner_id" <> "season_teams"."proposed_by")
);
--> statement-breakpoint
CREATE TABLE "team_roster" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"team_id" uuid NOT NULL,
	"season_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	CONSTRAINT "team_roster_valid_range" CHECK ("team_roster"."valid_to" is null or "team_roster"."valid_to" >= "team_roster"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "season_teams" ADD CONSTRAINT "season_teams_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_teams" ADD CONSTRAINT "season_teams_proposed_by_memberships_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_teams" ADD CONSTRAINT "season_teams_partner_id_memberships_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_roster" ADD CONSTRAINT "team_roster_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_roster" ADD CONSTRAINT "team_roster_team_season_fk" FOREIGN KEY ("team_id","season_id") REFERENCES "public"."season_teams"("id","season_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "season_teams_season_id_idx" ON "season_teams" USING btree ("season_id");--> statement-breakpoint
CREATE UNIQUE INDEX "season_teams_live_name_unique" ON "season_teams" USING btree ("season_id","name_key") WHERE "season_teams"."status" in ('proposed', 'accepted', 'approved');--> statement-breakpoint
CREATE INDEX "season_teams_season_proposer_idx" ON "season_teams" USING btree ("season_id","proposed_by");--> statement-breakpoint
CREATE INDEX "team_roster_team_id_idx" ON "team_roster" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_roster_one_team_per_season" ON "team_roster" USING btree ("season_id","membership_id") WHERE "team_roster"."valid_to" is null;