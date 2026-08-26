CREATE TABLE "oauth_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"challenge_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_challenges_challenge_hash_unique" UNIQUE("challenge_hash"),
	CONSTRAINT "oauth_challenges_provider_check" CHECK ("oauth_challenges"."provider" = 'google')
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "google_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "github_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "minecraft_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "oauth_challenges_expires_at_idx" ON "oauth_challenges" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_google_id_unique" UNIQUE("google_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_github_id_unique" UNIQUE("github_id");