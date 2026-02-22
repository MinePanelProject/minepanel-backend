/*
  Warnings:

  - You are about to drop the column `firstServerCreated` on the `SetupState` table. All the data in the column will be lost.
  - You are about to drop the column `isInitialized` on the `SetupState` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "SetupState" DROP COLUMN "firstServerCreated",
DROP COLUMN "isInitialized";
