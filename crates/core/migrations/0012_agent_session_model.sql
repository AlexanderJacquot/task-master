-- The model a session was started with ("Send to agent" model selector). NULL: Claude
-- Code's own default, or the model set in the agent settings.
ALTER TABLE agent_sessions ADD COLUMN model TEXT;
