-- ============================================================
-- VaultDesk Cloud Sync — Supabase SQL
-- Run this in: Supabase Dashboard → SQL Editor
-- Required for cross-device competition sync
-- ============================================================

-- 1. Add state_json column (full competition state as JSON blob)
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS state_json JSONB;

-- 2. Add updated_at column for conflict resolution (cloud wins if newer)
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- 3. Auto-update updated_at on every row change
CREATE OR REPLACE FUNCTION _vd_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vd_competitions_updated_at ON competitions;
CREATE TRIGGER vd_competitions_updated_at
  BEFORE UPDATE ON competitions
  FOR EACH ROW EXECUTE FUNCTION _vd_set_updated_at();

-- 4. Index for fast per-owner queries
CREATE INDEX IF NOT EXISTS idx_competitions_owner_updated
  ON competitions (owner_id, updated_at DESC);

-- ============================================================
-- After running this SQL:
-- Deploy the updated index.html to Cloudflare Pages
-- All competitions will now auto-sync to/from cloud on login
-- ============================================================
