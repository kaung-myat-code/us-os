-- Rename occurred_at -> event_date and narrow its type to DATE (existing rows
-- are RLS-phase proof-of-concept data only, not real user content).
ALTER TABLE "milestones" RENAME COLUMN "occurred_at" TO "event_date";
ALTER TABLE "milestones" ALTER COLUMN "event_date" TYPE DATE USING ("event_date"::date);

-- New columns for FR-02 (Life Timeline & Event Ledger Engine)
ALTER TABLE "milestones" ADD COLUMN "created_by" UUID;
ALTER TABLE "milestones" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'other';
ALTER TABLE "milestones" ADD COLUMN "note_ciphertext" TEXT;
ALTER TABLE "milestones" ADD COLUMN "note_iv" TEXT;
ALTER TABLE "milestones" ADD COLUMN "note_auth_tag" TEXT;
ALTER TABLE "milestones" ADD COLUMN "note_version" INTEGER DEFAULT 1;

-- created_by is a required FK with no default. No real milestone rows exist
-- yet (RLS-phase proof-of-concept data only), so clearing the table before
-- enforcing NOT NULL is safe -- if you have local dev/seed rows you care
-- about, back them up before running this migration.
DELETE FROM "milestones";
ALTER TABLE "milestones" ALTER COLUMN "created_by" SET NOT NULL;

ALTER TABLE "milestones" ADD CONSTRAINT "milestones_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The existing RLS policy (see 20260728161552_add_space_and_milestone) is
-- row-level, not column-level, and needs no changes for these new columns.
