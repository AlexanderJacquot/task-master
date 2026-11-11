-- How long the agent worked in a session, summed over its runs (Claude Code's
-- `duration_ms` per result), in milliseconds. NULL until a run reports it. Not the time
-- from start to end: a session can sit idle between follow-ups.
ALTER TABLE agent_sessions ADD COLUMN duration_ms INTEGER;
