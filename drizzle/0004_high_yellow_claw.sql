-- Phase C session substrate: legacy rows store bcrypt hashes of old-format tokens
-- with no derivable jti, so they cannot be verified under the new scheme.
-- Deleting them forces re-login (documented session-invalidation consequence).
ALTER TABLE "refresh_tokens" DROP CONSTRAINT "refresh_tokens_token_unique";--> statement-breakpoint
DELETE FROM "refresh_tokens";--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP COLUMN "token";--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "token_id_hash" text NOT NULL;--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_token_id_hash_unique" UNIQUE("token_id_hash");