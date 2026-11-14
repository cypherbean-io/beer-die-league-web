-- Names that approved members give up by renaming, held for them for 90 days. Renames made
-- before this aren't recorded, so names given up earlier stay free, as they were.
CREATE TABLE "released_names" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"league_id" uuid NOT NULL,
	"name_key" text NOT NULL,
	"membership_id" uuid NOT NULL,
	"released_at" timestamp with time zone NOT NULL,
	CONSTRAINT "released_names_league_name_key_unique" UNIQUE("league_id","name_key")
);
--> statement-breakpoint
ALTER TABLE "released_names" ADD CONSTRAINT "released_names_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "released_names" ADD CONSTRAINT "released_names_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "released_names_membership_id_idx" ON "released_names" USING btree ("membership_id");