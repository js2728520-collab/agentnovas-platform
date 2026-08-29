-- The role/permission guard reads internal_registration_links. Runtime roles
-- intentionally cannot read that token-bearing table, so the trigger must run
-- through the migrator-owned boundary instead of the invoking Web role.
CREATE OR REPLACE FUNCTION protect_internal_registration_link_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE
  old_role_id text;
  new_role_id text;
BEGIN
  IF TG_TABLE_NAME = 'roles' THEN
    old_role_id := OLD.id;
  ELSIF TG_OP = 'INSERT' THEN
    new_role_id := NEW.role_id;
  ELSIF TG_OP = 'DELETE' THEN
    old_role_id := OLD.role_id;
  ELSE
    old_role_id := OLD.role_id;
    new_role_id := NEW.role_id;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM internal_registration_links
     WHERE role_id = old_role_id OR role_id = new_role_id
  ) THEN
    RAISE EXCEPTION 'INTERNAL_REGISTRATION_LINK_ROLE_IMMUTABLE';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;

REVOKE ALL ON FUNCTION protect_internal_registration_link_role() FROM PUBLIC;
