-- CreateTable
CREATE TABLE "decisions" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "chosen_option_id" UUID,
    "decided_at" TIMESTAMP(3),
    "rationale_ciphertext" TEXT,
    "rationale_iv" TEXT,
    "rationale_auth_tag" TEXT,
    "rationale_version" INTEGER DEFAULT 1,
    "outcome_ciphertext" TEXT,
    "outcome_iv" TEXT,
    "outcome_auth_tag" TEXT,
    "outcome_version" INTEGER DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decision_options" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "decision_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "decision_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_off_items" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "option_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "weight" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trade_off_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "decisions_space_id_idx" ON "decisions"("space_id");

-- CreateIndex
CREATE INDEX "decision_options_decision_id_idx" ON "decision_options"("decision_id");

-- CreateIndex
CREATE INDEX "decision_options_space_id_idx" ON "decision_options"("space_id");

-- CreateIndex
CREATE INDEX "trade_off_items_option_id_idx" ON "trade_off_items"("option_id");

-- CreateIndex
CREATE INDEX "trade_off_items_space_id_idx" ON "trade_off_items"("space_id");

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_options" ADD CONSTRAINT "decision_options_decision_id_fkey" FOREIGN KEY ("decision_id") REFERENCES "decisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_options" ADD CONSTRAINT "decision_options_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_off_items" ADD CONSTRAINT "trade_off_items_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "decision_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_off_items" ADD CONSTRAINT "trade_off_items_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_chosen_option_id_fkey" FOREIGN KEY ("chosen_option_id") REFERENCES "decision_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security: tenant isolation on decisions, decision_options, trade_off_items
ALTER TABLE "decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decisions" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "decisions"
  USING (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);

ALTER TABLE "decision_options" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decision_options" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "decision_options"
  USING (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);

ALTER TABLE "trade_off_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "trade_off_items" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "trade_off_items"
  USING (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  WITH CHECK (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);
