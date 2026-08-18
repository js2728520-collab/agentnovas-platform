ALTER TABLE strategy_research_runs
  ALTER COLUMN conversation_id DROP NOT NULL;

COMMENT ON COLUMN strategy_research_runs.conversation_id IS
  'Optional legacy strategy-chat reference. Background research runs no longer create empty AI conversations.';
