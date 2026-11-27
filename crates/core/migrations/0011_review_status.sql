-- A baseline "Review" status (ADR 017): where a task goes when an agent reports it done,
-- for the user to check. Open (category in_progress), between Waiting and Done. A fixed id,
-- like the default workflow in 0001, so every replica seeds the identical row. Skipped
-- when the workflow already has a live status named Review.
INSERT INTO statuses (id, name, category, color, rank, wip_limit, created_at, updated_at)
SELECT '00000000-0000-7000-8000-000000000007', 'Review', 'in_progress', '#14b8a6', 'a3V', NULL, 0, 0
WHERE NOT EXISTS (
  SELECT 1 FROM statuses WHERE lower(trim(name)) = 'review' AND deleted_at IS NULL
);
