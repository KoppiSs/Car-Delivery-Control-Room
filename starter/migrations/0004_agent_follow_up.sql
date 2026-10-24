ALTER TABLE orders ADD COLUMN IF NOT EXISTS waiting_on_description text;
CREATE TABLE IF NOT EXISTS agent_mock_actions (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  action_type text NOT NULL,
  payload jsonb NOT NULL,
  waiting_on_description text NOT NULL,
  status text NOT NULL DEFAULT 'WAITING',
  event_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_mock_actions_order_created_idx ON agent_mock_actions(order_id, created_at);
