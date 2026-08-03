-- ============================================================
-- LiveResults_VaultDesk — Read Policies for Display Mode
-- Run this in: Supabase Dashboard → SQL Editor
-- ============================================================
-- The display URL is public (anyone with the link can watch).
-- These policies allow anonymous/public reads on all four tables
-- so the Display tab and Leaderboard can load without auth.
-- Scorer writes still go through SECURITY DEFINER RPCs (token-gated).
-- ============================================================

-- COMPETITIONS: anyone can read any competition by slug
CREATE POLICY "competitions_public_read"
  ON competitions FOR SELECT
  USING (true);

-- ATHLETES: anyone can read athletes for any competition
CREATE POLICY "athletes_public_read"
  ON athletes FOR SELECT
  USING (true);

-- HEIGHTS: anyone can read heights for any competition
CREATE POLICY "heights_public_read"
  ON heights FOR SELECT
  USING (true);

-- ATTEMPTS: anyone can read attempts for any competition
CREATE POLICY "attempts_public_read"
  ON attempts FOR SELECT
  USING (true);

-- Also enable realtime for the tables used by the display subscription:
-- (Run these in Supabase Dashboard → Database → Replication → Tables)
-- Or via SQL:
ALTER PUBLICATION supabase_realtime ADD TABLE competitions;
ALTER PUBLICATION supabase_realtime ADD TABLE attempts;
