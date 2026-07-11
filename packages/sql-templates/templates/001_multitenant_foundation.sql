-- Migration: Multi-tenant foundation — status + tenant_id on team_members
-- Prerequisite: a `tenants` table already exists (id UUID PK, name TEXT, created_at TIMESTAMPTZ)
--               and a `team_members` table exists (membership rows per user).
-- This migration adds the columns needed for tenant isolation.

-- Add status column
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'team_members' AND column_name = 'status'
  ) THEN
    ALTER TABLE team_members
      ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'invited', 'suspended'));
  END IF;
END $$;

-- Add tenant_id (FK to tenants, nullable for backward compat)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'team_members' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE team_members
      ADD COLUMN tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_team_members_tenant_id ON team_members(tenant_id);
CREATE INDEX IF NOT EXISTS idx_team_members_status ON team_members(status);

-- RLS: service_role has full access (API always uses service_role key)
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS team_members_service_role ON team_members;
CREATE POLICY team_members_service_role ON team_members
  USING (current_setting('role', true) = 'service_role');
