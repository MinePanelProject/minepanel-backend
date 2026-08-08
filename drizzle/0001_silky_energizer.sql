CREATE TYPE "public"."server_difficulty" AS ENUM('PEACEFUL', 'EASY', 'NORMAL', 'HARD');--> statement-breakpoint
CREATE TYPE "public"."server_gamemode" AS ENUM('SURVIVAL', 'CREATIVE', 'ADVENTURE', 'SPECTATOR');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'PENDING', 'BANNED');--> statement-breakpoint
LOCK TABLE "servers", "users" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
DO $$
DECLARE
  bad_difficulty text;
  bad_gamemode text;
  long_email text;
  long_username text;
BEGIN
  SELECT string_agg(email, ', ')
    INTO long_email
    FROM (SELECT DISTINCT email FROM users WHERE length(email) > 254 LIMIT 10) offending;

  SELECT string_agg(username, ', ')
    INTO long_username
    FROM (SELECT DISTINCT username FROM users WHERE length(username) > 32 LIMIT 10) offending;

  SELECT string_agg(difficulty, ', ')
    INTO bad_difficulty
    FROM (SELECT DISTINCT difficulty FROM servers WHERE upper(difficulty COLLATE "C") NOT IN ('PEACEFUL', 'EASY', 'NORMAL', 'HARD') LIMIT 10) offending;

  SELECT string_agg(gamemode, ', ')
    INTO bad_gamemode
    FROM (SELECT DISTINCT gamemode FROM servers WHERE upper(gamemode COLLATE "C") NOT IN ('SURVIVAL', 'CREATIVE', 'ADVENTURE', 'SPECTATOR') LIMIT 10) offending;

  IF long_email IS NOT NULL THEN
    RAISE EXCEPTION 'Migration aborted: users.email contains value(s) longer than 254 characters (%); shorten or remove them before upgrading: %', (
      SELECT count(*) FROM users WHERE length(email) > 254
    ), long_email;
  END IF;

  IF long_username IS NOT NULL THEN
    RAISE EXCEPTION 'Migration aborted: users.username contains value(s) longer than 32 characters (%); shorten or remove them before upgrading: %', (
      SELECT count(*) FROM users WHERE length(username) > 32
    ), long_username;
  END IF;

  IF bad_difficulty IS NOT NULL THEN
    RAISE EXCEPTION 'Migration aborted: servers.difficulty contains unsupported legacy value(s): %; fix or remove these rows before upgrading', bad_difficulty;
  END IF;

  IF bad_gamemode IS NOT NULL THEN
    RAISE EXCEPTION 'Migration aborted: servers.gamemode contains unsupported legacy value(s): %; fix or remove these rows before upgrading', bad_gamemode;
  END IF;
END $$;--> statement-breakpoint
UPDATE "servers" SET "difficulty" = upper("difficulty" COLLATE "C") WHERE "difficulty" <> upper("difficulty" COLLATE "C");--> statement-breakpoint
UPDATE "servers" SET "gamemode" = upper("gamemode" COLLATE "C") WHERE "gamemode" <> upper("gamemode" COLLATE "C");--> statement-breakpoint
ALTER TABLE "servers" ALTER COLUMN "difficulty" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "servers" ALTER COLUMN "difficulty" SET DATA TYPE "public"."server_difficulty" USING "difficulty"::"public"."server_difficulty";--> statement-breakpoint
ALTER TABLE "servers" ALTER COLUMN "difficulty" SET DEFAULT 'NORMAL'::"public"."server_difficulty";--> statement-breakpoint
ALTER TABLE "servers" ALTER COLUMN "gamemode" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "servers" ALTER COLUMN "gamemode" SET DATA TYPE "public"."server_gamemode" USING "gamemode"::"public"."server_gamemode";--> statement-breakpoint
ALTER TABLE "servers" ALTER COLUMN "gamemode" SET DEFAULT 'SURVIVAL'::"public"."server_gamemode";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" SET DATA TYPE varchar(254);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "username" SET DATA TYPE varchar(32);--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "memory_limit_mb" integer DEFAULT 2048 NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "motd" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "level_seed" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "online_mode" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "view_distance" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "allow_flight" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "rcon_password" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" "user_status" DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_backup_codes" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "temp_password_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "temp_password_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;