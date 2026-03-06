CREATE TYPE "public"."role" AS ENUM('ADMIN', 'MOD', 'USER');--> statement-breakpoint
CREATE TYPE "public"."server_provider" AS ENUM('VANILLA', 'PAPER', 'PURPUR', 'FABRIC', 'FORGE');--> statement-breakpoint
CREATE TYPE "public"."server_status" AS ENUM('STOPPED', 'STARTING', 'RUNNING', 'STOPPING', 'ERROR');--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"provider" "server_provider" NOT NULL,
	"version" text NOT NULL,
	"port" integer NOT NULL,
	"container_id" text,
	"status" "server_status" DEFAULT 'STOPPED' NOT NULL,
	"max_players" integer DEFAULT 20 NOT NULL,
	"difficulty" text DEFAULT 'normal' NOT NULL,
	"gamemode" text DEFAULT 'survival' NOT NULL,
	"pvp" boolean DEFAULT true NOT NULL,
	"world_path" text,
	"owner_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "servers_port_unique" UNIQUE("port"),
	CONSTRAINT "servers_container_id_unique" UNIQUE("container_id")
);
--> statement-breakpoint
CREATE TABLE "setup_state" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"initial_admin_created" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "role" DEFAULT 'USER' NOT NULL,
	"minecraft_uuid" text,
	"minecraft_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_minecraft_uuid_unique" UNIQUE("minecraft_uuid")
);
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;