ALTER TABLE orders ADD COLUMN IF NOT EXISTS agent_mode text NOT NULL DEFAULT 'AGENT';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS agent_revision integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS agent_proposal_feedback (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  decision text NOT NULL,
  correction text,
  previous_proposal jsonb,
  replacement_proposal jsonb,
  outcome text NOT NULL,
  operator_id text NOT NULL DEFAULT 'operator',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_feedback_order_created_idx ON agent_proposal_feedback(order_id, created_at);
