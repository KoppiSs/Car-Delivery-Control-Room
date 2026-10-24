ALTER TABLE orders ADD COLUMN IF NOT EXISTS agent_decision text NOT NULL DEFAULT 'PENDING';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS agent_decision_at timestamptz;
UPDATE orders AS o SET agent_decision = 'TAKEN_OVER', agent_decision_at = COALESCE(
  (SELECT max(f.created_at) FROM agent_proposal_feedback f WHERE f.order_id = o.id AND f.outcome = 'MANUAL_TAKEOVER'), o.updated_at)
WHERE o.agent_mode IN ('MANUAL', 'MANUAL_COMPLETE') AND o.agent_decision = 'PENDING';
