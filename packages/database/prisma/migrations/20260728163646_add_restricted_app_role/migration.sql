-- Application connection role: RLS (see the previous migration's tenant_isolation
-- policy) is silently bypassed for superusers and any role with BYPASSRLS, which
-- includes the default docker-compose bootstrap role. The app must connect as a
-- plain, non-superuser role with RLS enforced, or FORCE ROW LEVEL SECURITY is a
-- no-op. Migrations continue to run as the superuser bootstrap role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'us_os_app') THEN
    CREATE ROLE us_os_app LOGIN PASSWORD 'us_os_app_dev_password' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO us_os_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO us_os_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO us_os_app;
