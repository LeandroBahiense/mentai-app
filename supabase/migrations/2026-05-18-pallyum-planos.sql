-- ============================================================
-- Pallyum — Migração de Planos e Preços
-- Versão: 1.0 | Data: 2026-05-18
-- ============================================================

-- 0. Extensões -----------------------------------------------
CREATE EXTENSION IF NOT EXISTS "vector";

-- 1. Campos novos em user_preferences -------------------------
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS upgrade_locked      boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS current_cooldown_ms int     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pending_suspension  boolean DEFAULT false;

-- 2. Tabela usage_logs ----------------------------------------
CREATE TABLE IF NOT EXISTS usage_logs (
  user_id        uuid REFERENCES auth.users ON DELETE CASCADE,
  date           date NOT NULL,
  msg_count      int  DEFAULT 0,
  audio_count    int  DEFAULT 0,
  image_count    int  DEFAULT 0,
  channel        text NOT NULL CHECK (channel IN ('app', 'whatsapp')),
  plan_at_time   text,
  PRIMARY KEY (user_id, date, channel)
);

CREATE INDEX IF NOT EXISTS usage_logs_user_date
  ON usage_logs (user_id, date DESC);

ALTER TABLE usage_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "usage_logs: only service role"
  ON usage_logs
  USING (false)
  WITH CHECK (false);

-- 3. Tabela organizations -------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  cnpj          text,
  plan          text NOT NULL CHECK (plan IN ('team', 'business', 'enterprise')),
  admin_user_id uuid REFERENCES auth.users ON DELETE SET NULL,
  created_at    timestamptz DEFAULT now()
);

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

-- Admin da org pode ver/editar sua org
CREATE POLICY "organizations: admin can manage"
  ON organizations
  FOR ALL
  USING (admin_user_id = auth.uid())
  WITH CHECK (admin_user_id = auth.uid());

-- 4. Tabela org_members ---------------------------------------
CREATE TABLE IF NOT EXISTS org_members (
  user_id         uuid REFERENCES auth.users ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('admin', 'member')) DEFAULT 'member',
  joined_at       timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, organization_id)
);

CREATE INDEX IF NOT EXISTS org_members_org_id
  ON org_members (organization_id);

ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;

-- Usuário vê sua própria participação
CREATE POLICY "org_members: member sees own"
  ON org_members
  FOR SELECT
  USING (user_id = auth.uid());

-- Admin da org vê todos os membros
CREATE POLICY "org_members: admin sees all"
  ON org_members
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.organization_id = org_members.organization_id
        AND om.user_id = auth.uid()
        AND om.role = 'admin'
    )
  );

-- Admin pode gerenciar membros
CREATE POLICY "org_members: admin can manage"
  ON org_members
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.organization_id = org_members.organization_id
        AND om.user_id = auth.uid()
        AND om.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.organization_id = org_members.organization_id
        AND om.user_id = auth.uid()
        AND om.role = 'admin'
    )
  );

-- 5. Tabela org_drawers_shared --------------------------------
CREATE TABLE IF NOT EXISTS org_drawers_shared (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations ON DELETE CASCADE,
  name            text NOT NULL,
  permissions     jsonb DEFAULT '{"admin": [], "member": []}',
  agent_setor     text,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS org_drawers_org_id
  ON org_drawers_shared (organization_id);

ALTER TABLE org_drawers_shared ENABLE ROW LEVEL SECURITY;

-- Membros da org podem ver gavetas da sua org
CREATE POLICY "org_drawers: members can view"
  ON org_drawers_shared
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.organization_id = org_drawers_shared.organization_id
        AND om.user_id = auth.uid()
    )
  );

-- Admin pode gerenciar gavetas
CREATE POLICY "org_drawers: admin can manage"
  ON org_drawers_shared
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.organization_id = org_drawers_shared.organization_id
        AND om.user_id = auth.uid()
        AND om.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.organization_id = org_drawers_shared.organization_id
        AND om.user_id = auth.uid()
        AND om.role = 'admin'
    )
  );

-- 6. Tabela org_agents ----------------------------------------
CREATE TABLE IF NOT EXISTS org_agents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations ON DELETE CASCADE,
  name            text NOT NULL,
  setor           text NOT NULL,
  system_prompt   text,
  vault_access    jsonb DEFAULT '[]',
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS org_agents_org_id
  ON org_agents (organization_id);

ALTER TABLE org_agents ENABLE ROW LEVEL SECURITY;

-- Membros da org podem ver agentes
CREATE POLICY "org_agents: members can view"
  ON org_agents
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.organization_id = org_agents.organization_id
        AND om.user_id = auth.uid()
    )
  );

-- Admin pode gerenciar agentes
CREATE POLICY "org_agents: admin can manage"
  ON org_agents
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.organization_id = org_agents.organization_id
        AND om.user_id = auth.uid()
        AND om.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.organization_id = org_agents.organization_id
        AND om.user_id = auth.uid()
        AND om.role = 'admin'
    )
  );

-- 7. Tabela upgrade_requests ----------------------------------
CREATE TABLE IF NOT EXISTS upgrade_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid REFERENCES auth.users ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations ON DELETE CASCADE,
  from_plan       text NOT NULL,
  to_plan         text NOT NULL,
  status          text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
  requested_at    timestamptz DEFAULT now(),
  resolved_at     timestamptz,
  resolved_by     uuid REFERENCES auth.users ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS upgrade_requests_org_status
  ON upgrade_requests (organization_id, status);

CREATE INDEX IF NOT EXISTS upgrade_requests_user
  ON upgrade_requests (user_id);

ALTER TABLE upgrade_requests ENABLE ROW LEVEL SECURITY;

-- Usuário vê seus próprios pedidos
CREATE POLICY "upgrade_requests: user sees own"
  ON upgrade_requests
  FOR SELECT
  USING (user_id = auth.uid());

-- Usuário pode criar pedido
CREATE POLICY "upgrade_requests: user can insert"
  ON upgrade_requests
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Admin da org vê e resolve pedidos
CREATE POLICY "upgrade_requests: admin can manage"
  ON upgrade_requests
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.organization_id = upgrade_requests.organization_id
        AND om.user_id = auth.uid()
        AND om.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.organization_id = upgrade_requests.organization_id
        AND om.user_id = auth.uid()
        AND om.role = 'admin'
    )
  );

-- 8. Tabela note_embeddings (vector) -------------------------
CREATE TABLE IF NOT EXISTS note_embeddings (
  note_id    uuid PRIMARY KEY,
  user_id    uuid REFERENCES auth.users ON DELETE CASCADE,
  title      text,
  embedding  vector(1536),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS note_embeddings_user
  ON note_embeddings (user_id);

-- Índice HNSW para busca ANN rápida (vector)
CREATE INDEX IF NOT EXISTS note_embeddings_cosine
  ON note_embeddings USING hnsw (embedding vector_cosine_ops);

ALTER TABLE note_embeddings ENABLE ROW LEVEL SECURITY;

-- Usuário vê apenas seus próprios embeddings
CREATE POLICY "note_embeddings: user sees own"
  ON note_embeddings
  FOR SELECT
  USING (user_id = auth.uid());

-- Service role pode gerenciar (indexação via backend)
CREATE POLICY "note_embeddings: service can manage"
  ON note_embeddings
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- 9. Função match_notes para busca semântica -------------------
CREATE OR REPLACE FUNCTION match_notes(
  p_user_id    uuid,
  p_embedding  vector(1536),
  p_threshold  float DEFAULT 0.7,
  p_top_k      int   DEFAULT 8
)
RETURNS TABLE (
  note_id    uuid,
  title      text,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ne.note_id,
    ne.title,
    1 - (ne.embedding <=> p_embedding) AS similarity
  FROM note_embeddings ne
  WHERE ne.user_id = p_user_id
    AND 1 - (ne.embedding <=> p_embedding) >= p_threshold
  ORDER BY ne.embedding <=> p_embedding
  LIMIT p_top_k;
END;
$$;

-- ============================================================
-- FIM DA MIGRAÇÃO
-- ============================================================
