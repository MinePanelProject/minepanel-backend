-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'MOD', 'USER');

-- CreateEnum
CREATE TYPE "ServerProvider" AS ENUM ('VANILLA', 'PAPER', 'PURPUR', 'FABRIC', 'FORGE');

-- CreateEnum
CREATE TYPE "ServerStatus" AS ENUM ('STOPPED', 'STARTING', 'RUNNING', 'STOPPING', 'ERROR');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "minecraftUUID" TEXT,
    "minecraftName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SetupState" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "isInitialized" BOOLEAN NOT NULL DEFAULT false,
    "initialAdminCreated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SetupState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Server" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "ServerProvider" NOT NULL,
    "version" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "containerId" TEXT,
    "status" "ServerStatus" NOT NULL DEFAULT 'STOPPED',
    "maxPlayers" INTEGER NOT NULL DEFAULT 20,
    "difficulty" TEXT NOT NULL DEFAULT 'normal',
    "gamemode" TEXT NOT NULL DEFAULT 'survival',
    "pvp" BOOLEAN NOT NULL DEFAULT true,
    "worldPath" TEXT,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Server_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_minecraftUUID_key" ON "User"("minecraftUUID");

-- CreateIndex
CREATE UNIQUE INDEX "Server_port_key" ON "Server"("port");

-- CreateIndex
CREATE UNIQUE INDEX "Server_containerId_key" ON "Server"("containerId");

-- AddForeignKey
ALTER TABLE "Server" ADD CONSTRAINT "Server_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
