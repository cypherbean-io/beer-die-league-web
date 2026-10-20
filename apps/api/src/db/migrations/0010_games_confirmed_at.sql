ALTER TABLE "games" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
-- Hand-added backfill. No game could be reopened before this migration, so a game confirmed
-- through the API counts its first confirmed revision, and that revision's latest confirmation
-- is when it did. A row edited by hand to have no confirmations fails the check below.
UPDATE "games" SET "confirmed_at" = (
  SELECT max("confirmations"."created_at") FROM "confirmations"
  WHERE "confirmations"."revision_id" = "games"."confirmed_revision_id"
) WHERE "games"."confirmed_revision_id" is not null;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_confirmed_has_time" CHECK (("games"."confirmed_revision_id" is not null) = ("games"."confirmed_at" is not null));
