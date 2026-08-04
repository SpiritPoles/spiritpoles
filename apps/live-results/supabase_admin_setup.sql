-- ============================================================
-- VaultDesk Admin System — Supabase SQL
-- Run this in: Supabase Dashboard → SQL Editor
-- ============================================================

-- 1. ADMIN PROFILES TABLE
-- Stores each admin's display name, role, and last-active time.
-- Linked to Supabase auth.users (row is auto-created on first login).

CREATE TABLE IF NOT EXISTS admin_profiles (
  id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  display_name TEXT,
  role         TEXT NOT NULL DEFAULT 'admin', -- 'admin' | 'super_admin'
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  last_active  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE admin_profiles ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read all profiles (needed for super-admin view)
CREATE POLICY "ap_select_auth"
  ON admin_profiles FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Users can only insert/update their own profile
CREATE POLICY "ap_insert_own"
  ON admin_profiles FOR INSERT
  WITH CHECK (auth.uid() = id);

CREATE POLICY "ap_update_own"
  ON admin_profiles FOR UPDATE
  USING (auth.uid() = id);


-- 2. UPDATE COMPETITIONS TABLE RLS
-- The competitions table already exists from the original VaultDesk setup.
-- We need any authenticated user to be able to read ALL competitions
-- (required for the super-admin view to list other admins' events).
-- Write access remains restricted to the owner.

-- Safe to run: drops old policy if it exists, then recreates
DROP POLICY IF EXISTS "comp_read_own"      ON competitions;
DROP POLICY IF EXISTS "comp_select_auth"   ON competitions;
DROP POLICY IF EXISTS "comp_read_auth"     ON competitions;

CREATE POLICY "comp_select_auth"
  ON competitions FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Ensure insert/update/delete are still restricted to owner_id
-- (These may already exist — skip if Supabase reports a conflict)
DROP POLICY IF EXISTS "comp_insert_own"  ON competitions;
DROP POLICY IF EXISTS "comp_update_own"  ON competitions;
DROP POLICY IF EXISTS "comp_delete_own"  ON competitions;

CREATE POLICY "comp_insert_own"
  ON competitions FOR INSERT
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "comp_update_own"
  ON competitions FOR UPDATE
  USING (owner_id = auth.uid());

CREATE POLICY "comp_delete_own"
  ON competitions FOR DELETE
  USING (owner_id = auth.uid());


-- 3. VERIFY EMAIL CONFIRMATIONS ARE DISABLED (optional but recommended for internal tools)
-- In Supabase Dashboard → Authentication → Settings:
-- Toggle OFF "Enable email confirmations"
-- This lets admins sign up and immediately sign in without checking email.
-- ============================================================
