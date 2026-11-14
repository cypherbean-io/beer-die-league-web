-- Every link now admits a limited number of people. Links that already exist get the default
-- of 10 joins from here on: joins made before this aren't recorded against any link.
ALTER TABLE "invites" ADD COLUMN "max_joins" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "join_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_max_joins_range" CHECK ("invites"."max_joins" between 1 and 50);--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_join_count_range" CHECK ("invites"."join_count" between 0 and "invites"."max_joins");