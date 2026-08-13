CREATE TYPE "public"."access_type" AS ENUM('OPEN', 'REQUEST', 'PRIVATE');--> statement-breakpoint
CREATE TYPE "public"."mod_permission" AS ENUM('SERVER_LIFECYCLE', 'SERVER_CONFIG', 'PLUGIN_MANAGEMENT', 'WHITELIST_MANAGEMENT', 'USER_MANAGEMENT', 'FILE_MANAGER');--> statement-breakpoint
CREATE TYPE "public"."server_access_status" AS ENUM('PENDING', 'APPROVED');--> statement-breakpoint
CREATE TABLE "mod_permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"permission" "mod_permission" NOT NULL,
	"server_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mod_permissions_user_permission_server_unique" UNIQUE("user_id","permission","server_id")
);
--> statement-breakpoint
CREATE TABLE "server_access" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"server_id" text NOT NULL,
	"status" "server_access_status" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"approved_at" timestamp,
	CONSTRAINT "server_access_user_id_server_id_unique" UNIQUE("user_id","server_id"),
	CONSTRAINT "server_access_status_approved_at_total_check" CHECK (("server_access"."status" = 'PENDING' AND "server_access"."approved_at" IS NULL) OR ("server_access"."status" = 'APPROVED' AND "server_access"."approved_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "access_type" "access_type" DEFAULT 'OPEN' NOT NULL;--> statement-breakpoint
ALTER TABLE "mod_permissions" ADD CONSTRAINT "mod_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mod_permissions" ADD CONSTRAINT "mod_permissions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_access" ADD CONSTRAINT "server_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_access" ADD CONSTRAINT "server_access_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mod_permissions_user_permission_unique_idx" ON "mod_permissions" USING btree ("user_id","permission") WHERE "mod_permissions"."server_id" IS NULL;--> statement-breakpoint
CREATE INDEX "mod_permissions_server_id_idx" ON "mod_permissions" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "mod_permissions_user_permission_server_lookup_idx" ON "mod_permissions" USING btree ("user_id","permission","server_id");--> statement-breakpoint
CREATE INDEX "server_access_server_id_status_created_at_id_idx" ON "server_access" USING btree ("server_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "server_access_user_id_server_id_idx" ON "server_access" USING btree ("user_id","server_id");