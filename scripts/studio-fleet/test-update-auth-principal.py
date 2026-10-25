#!/usr/bin/env python3
"""update.apply over migration 067 (1.0.84, AuthPrincipal), read from the server's own migration
file: it widens auth_sessions and auth_pairing_links, creates an empty revocations table and adds
two triggers that can only refuse an insert. Accepted exactly so; anything else it could hide is
refused and rolled back. Pure temporary metadata, never production services."""
import importlib.util,json,pathlib,re,unittest
import auth_heartbeat
spec=importlib.util.spec_from_file_location('apply_update_base',pathlib.Path(__file__).with_name('test-update.py'))
updater_base=importlib.util.module_from_spec(spec);spec.loader.exec_module(updater_base)
update=updater_base.update
MIGRATION=pathlib.Path(__file__).resolve().parents[2]/'apps/server/src/persistence/Migrations/067_AuthPrincipal.ts'
# Each sql`...` statement of the migration, as the server runs it.
STATEMENTS=tuple(re.findall(r'sql`(.*?)`;',MIGRATION.read_text(),re.S))
ADDED={'auth_pairing_links':['principal','principal_generation'],'auth_sessions':['principal','principal_generation']}
def with_statement(old,new):
 assert any(old in statement for statement in STATEMENTS),old
 return tuple(statement.replace(old,new) for statement in STATEMENTS)
class AuthPrincipalMigration(updater_base.ApplyRecovery):
 def test_the_migration_file_has_its_seven_statements(self):
  self.assertEqual(len(STATEMENTS),7)
  self.assertEqual(sum('ADD COLUMN' in statement for statement in STATEMENTS),4)
 def test_migration_067_verifies_with_its_columns_reported(self):
  self.use_captured_waiting_state("UPDATE auth_pairing_links SET credential=X'7365637265740001'")
  self.migrate_real(*STATEMENTS);self.execute(allow_project_migrations=True);result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['rowPreservation'],'verified-migration')
  self.assertEqual(result['migrationProtectedCells'],'typed-verified');self.assertEqual(result['migrationAddedColumns'],ADDED)
 def test_migration_067_verifies_while_the_browser_reconnects_and_reads_back(self):
  state=self.use_captured_heartbeat_state()
  self.restart_with_project_save_and_heartbeat(state,*STATEMENTS)
  self.execute(allow_project_migrations=True,allow_existing_browser_heartbeat=True);result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['migrationAddedColumns'],ADDED)
  self.assertIn('authHeartbeatWitness',result)
  before,after,witness=result['before']['rows'],result['after']['rows'],result['authHeartbeatWitness']
  captures={'before_capture':result['before']['databaseCapture'],'after_capture':result['after']['databaseCapture']}
  current=auth_heartbeat.read_auth_sessions(state,after)
  self.assertEqual(update.verify_migration_heartbeat_witness(before,after,witness,current,identity='m4',state=state,**captures),witness)
  self.assertNotIn('private-credential',self.output.read_text()+self.stdout.getvalue())
 def test_migration_067_never_excuses_a_filled_or_changed_new_cell(self):
  for statement in ["UPDATE auth_sessions SET principal='planted'","UPDATE auth_pairing_links SET principal='planted'",
                    'UPDATE auth_sessions SET principal_generation=1',"UPDATE auth_pairing_links SET principal=''",
                    # INTEGER affinity stores '0' and 0.0 as the integer 0; a BLOB stays a BLOB.
                    "UPDATE auth_pairing_links SET principal_generation=X'00'"]:
   with self.subTest(statement=statement):
    self.setUp();self.use_captured_waiting_state()
    self.reject_real_migration(*STATEMENTS,statement,pattern='filled a new column');self.tearDown()
 def test_migration_067_never_excuses_a_changed_earlier_auth_cell(self):
  for statement in ["UPDATE auth_pairing_links SET credential='replaced'","UPDATE auth_sessions SET scopes='admin'",
                    "UPDATE auth_sessions SET revoked_at=NULL","INSERT INTO auth_pairing_links(id,credential) VALUES ('planted','synthetic-private')"]:
   with self.subTest(statement=statement):
    self.setUp();self.use_captured_waiting_state("UPDATE auth_sessions SET revoked_at='2026-10-01T00:00:00Z'")
    self.reject_real_migration(*STATEMENTS,statement,pattern='changed');self.tearDown()
 def test_migration_067_never_excuses_a_planted_revocation_or_session(self):
  for statement,pattern in [("INSERT INTO auth_principal_revocations VALUES ('p',NULL,0)",'holding rows'),
                            ("INSERT INTO auth_sessions(session_id,subject,scopes) VALUES ('planted','synthetic-private','[]')",'changed')]:
   with self.subTest(statement=statement):
    self.setUp();self.use_captured_waiting_state()
    self.reject_real_migration(*STATEMENTS,statement,pattern=pattern);self.tearDown()
 def test_a_trigger_that_writes_or_a_second_trigger_is_refused(self):
  rewritten=with_statement("SELECT RAISE(ABORT, 'Principal approval is no longer current');","UPDATE auth_pairing_links SET revoked_at=NULL;")
  for statements in [rewritten,STATEMENTS+('CREATE TRIGGER planted AFTER INSERT ON projection_projects BEGIN UPDATE auth_sessions SET revoked_at=NULL; END',)]:
   with self.subTest(statements=statements[-1][:60]):
    self.setUp();self.use_captured_waiting_state()
    self.reject_real_migration(*statements,pattern='trigger touching');self.tearDown()
 def test_another_default_or_an_extra_auth_column_is_refused(self):
  for statements,pattern in [(with_statement('NOT NULL DEFAULT 0`'.rstrip('`'),'NOT NULL DEFAULT 1'),'constraint or default|auth sessions or history'),
                             (STATEMENTS+('ALTER TABLE auth_sessions ADD COLUMN scope TEXT',),'auth sessions or history'),
                             (with_statement('principal TEXT PRIMARY KEY, revoked_at TEXT','principal TEXT PRIMARY KEY, revoked_at TEXT, note TEXT'),'holding rows')]:
   with self.subTest(pattern=pattern):
    self.setUp();self.use_captured_waiting_state()
    self.reject_real_migration(*statements,pattern=pattern);self.tearDown()
 def test_067_never_carries_a_trigger_that_clears_revocations(self):
  for statements in [STATEMENTS+('CREATE TRIGGER planted AFTER UPDATE ON projection_projects BEGIN DELETE FROM auth_principal_revocations; END',),
                     # A non-ASCII space is part of a word to SQLite: the trigger would break every sign-in.
                     with_statement('WHEN NEW.principal IS NOT NULL','WHEN NEW.principal\u00a0IS NOT NULL')]:
   with self.subTest(statements=statements[-1][:60]):
    self.setUp();self.use_captured_waiting_state()
    self.reject_real_migration(*statements,pattern='trigger touching');self.tearDown()
 def test_after_067_revocations_and_its_triggers_stay_protected(self):
  installed=STATEMENTS+("INSERT INTO auth_principal_revocations VALUES ('owner','2026-10-20T00:00:00Z',2)",)
  for statement,pattern in [('UPDATE auth_principal_revocations SET revoked_at=NULL, generation=0','changed'),
                            ('DELETE FROM auth_principal_revocations','changed'),
                            ('CREATE TRIGGER planted AFTER INSERT ON auth_principal_revocations BEGIN DELETE FROM auth_principal_revocations; END','trigger touching'),
                            ('DROP TRIGGER auth_pairing_principal_generation','removed or changed a trigger'),
                            ('DROP TRIGGER auth_session_principal_generation','auth schema changed')]:
   with self.subTest(statement=statement):
    self.setUp();self.use_captured_waiting_state(*installed)
    self.reject_real_migration(statement,pattern=pattern);self.tearDown()
 def test_after_067_an_unrelated_migration_still_verifies(self):
  self.use_captured_waiting_state(*STATEMENTS,"INSERT INTO auth_principal_revocations VALUES ('owner','2026-10-20T00:00:00Z',2)")
  self.migrate_real();self.execute(allow_project_migrations=True)
  self.assertEqual(json.loads(self.output.read_text())['phase'],'verified')
if __name__=='__main__':unittest.main()
