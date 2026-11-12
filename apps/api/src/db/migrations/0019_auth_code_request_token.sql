-- A code is now found by the token its request was answered with, and the codes already issued
-- have none. They live ten minutes at most, so they are dropped: anyone part-way through
-- signing in asks for a new code.
DELETE FROM "auth_codes";--> statement-breakpoint
ALTER TABLE "auth_codes" DROP CONSTRAINT "auth_codes_email_unique";--> statement-breakpoint
ALTER TABLE "auth_codes" ADD COLUMN "request_token_sha256" text NOT NULL;--> statement-breakpoint
CREATE INDEX "auth_codes_email_idx" ON "auth_codes" USING btree ("email");--> statement-breakpoint
ALTER TABLE "auth_codes" ADD CONSTRAINT "auth_codes_request_token_sha256_unique" UNIQUE("request_token_sha256");