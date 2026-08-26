-- Phase D identity normalization (D-10, adopted): canonical lowercase usernames.
-- Preflight: a case-insensitive duplicate (e.g. `Bob` + `bob`) cannot be
-- migrated without manual resolution — fail loudly, never silently merge or
-- drop a row. Clean databases are unchanged by the preflight.
DO $$
DECLARE
  conflicting_count integer;
BEGIN
  SELECT count(*) INTO conflicting_count
  FROM (
    SELECT lower(username) AS canon
    FROM users
    GROUP BY lower(username)
    HAVING count(*) > 1
  ) conflicts;

  IF conflicting_count > 0 THEN
    RAISE EXCEPTION
      'Username case-collision detected: % lowercase-canonical value(s) map to multiple accounts; resolve manually before applying migration 0005',
      conflicting_count;
  END IF;
END $$;--> statement-breakpoint
-- Canonicalize all existing usernames; the unique(username) constraint is
-- satisfied because the preflight proved injectivity of lower(username).
UPDATE users SET username = lower(username);