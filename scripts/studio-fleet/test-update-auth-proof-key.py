#!/usr/bin/env python3
"""update.apply over migration 069 (AuthSessionProofKeyThumbprint), read from the server's own
migration file: it adds one nullable column to auth_sessions and one partial index on it. Accepted
exactly so, alone after 067 or together with it, and with the one value the new server writes
into it during the restart: a SpecWithCode Connect session's own key (SessionStore.ts
backfillProofKey). Anything else it could hide is refused and rolled back. Pure temporary
metadata, never production services."""
import datetime,importlib.util,json,pathlib,re,sqlite3,unittest
import auth_heartbeat
spec=importlib.util.spec_from_file_location('apply_update_base',pathlib.Path(__file__).with_name('test-update.py'))
updater_base=importlib.util.module_from_spec(spec);spec.loader.exec_module(updater_base)
update=updater_base.update
MIGRATIONS=pathlib.Path(__file__).resolve().parents[2]/'apps/server/src/persistence/Migrations'
MIGRATION=MIGRATIONS/'069_AuthSessionProofKeyThumbprint.ts'
# Each sql`...` statement of the migrations, as the server runs them (069's PRAGMA read is sql<...>`...`).
def statements(path):return tuple(re.findall(r'sql`(.*?)`;',path.read_text(),re.S))
STATEMENTS=statements(MIGRATION)
PRINCIPAL=statements(MIGRATIONS/'067_AuthPrincipal.ts')
ADDED={'auth_sessions':['proof_key_thumbprint']}
# An RFC 7638 SHA-256 thumbprint, base64url without padding, as a Connect token's jkt names it.
THUMBPRINT='NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs'
CONNECT_SESSION=("ALTER TABLE auth_sessions ADD COLUMN method TEXT",
                 "INSERT INTO auth_sessions(session_id,subject,scopes,last_connected_at,method) VALUES ('phone','cloud-connect','operate','2026-10-11T03:00:00Z','dpop-access-token')")
BACKFILL="UPDATE auth_sessions SET proof_key_thumbprint='"+THUMBPRINT+"' WHERE subject='cloud-connect' AND proof_key_thumbprint IS NULL"
def with_statement(old,new):
 assert any(old in statement for statement in STATEMENTS),old
 return tuple(statement.replace(old,new) for statement in STATEMENTS)
class AuthProofKeyMigration(updater_base.ApplyRecovery):
 def use_captured_phone_heartbeat_state(self):
  """The browser session plus a Connect phone session stored before 069, both reconnecting."""
  state=self.use_captured_heartbeat_state();now=datetime.datetime.now(datetime.timezone.utc)
  db=sqlite3.connect(state/'statev2.sqlite')
  db.execute('ALTER TABLE auth_sessions ADD COLUMN subject TEXT');db.execute("UPDATE auth_sessions SET subject='owner'")
  db.execute('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?,?)',('private-phone','dpop-access-token','mobile',(now-datetime.timedelta(minutes=20)).isoformat(),
             (now+datetime.timedelta(minutes=40)).isoformat(),(now-datetime.timedelta(minutes=10)).isoformat(),None,b'private-credential-phone','cloud-connect'))
  db.commit();db.close()
  self.before['rows'],_,self.before['databaseCapture']=update._rows_snapshot(state,False,include_database=True)
  return state
 def test_the_migration_file_has_its_two_statements(self):
  self.assertEqual(len(STATEMENTS),2)
  self.assertIn('ADD COLUMN proof_key_thumbprint TEXT',STATEMENTS[0])
  self.assertIn('WHERE proof_key_thumbprint IS NOT NULL',STATEMENTS[1])
 def test_migration_069_after_067_verifies_with_its_column_reported(self):
  self.use_captured_waiting_state(*PRINCIPAL,"UPDATE auth_sessions SET revoked_at='2026-10-01T00:00:00Z'")
  self.migrate_real(*STATEMENTS);self.execute(allow_project_migrations=True);result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['rowPreservation'],'verified-migration')
  self.assertEqual(result['migrationProtectedCells'],'typed-verified');self.assertEqual(result['migrationAddedColumns'],ADDED)
 def test_067_and_069_in_one_update_verify(self):
  # A machine updating from before 1.0.84 runs both.
  self.use_captured_waiting_state()
  self.migrate_real(*PRINCIPAL,*STATEMENTS);self.execute(allow_project_migrations=True);result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified')
  self.assertEqual(result['migrationAddedColumns'],{'auth_pairing_links':['principal','principal_generation'],
                                                    'auth_sessions':['principal','principal_generation','proof_key_thumbprint']})
 def test_a_connect_session_that_records_its_key_on_reconnect_verifies(self):
  for prepared,migrated in [(PRINCIPAL+CONNECT_SESSION,STATEMENTS),(CONNECT_SESSION,PRINCIPAL+STATEMENTS)]:
   with self.subTest(with_067=len(migrated)>len(STATEMENTS)):
    self.setUp();self.use_captured_waiting_state(*prepared)
    self.migrate_real(*migrated,BACKFILL);self.execute(allow_project_migrations=True)
    self.assertEqual(json.loads(self.output.read_text())['phase'],'verified');self.tearDown()
 def test_migration_069_verifies_while_the_browser_and_phone_reconnect_and_reads_back(self):
  state=self.use_captured_phone_heartbeat_state()
  self.restart_with_project_save_and_heartbeat(state,*STATEMENTS,BACKFILL)
  self.execute(allow_project_migrations=True,allow_existing_browser_heartbeat=True);result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['migrationAddedColumns'],ADDED)
  self.assertIn('authHeartbeatWitness',result)
  before,after,witness=result['before']['rows'],result['after']['rows'],result['authHeartbeatWitness']
  captures={'before_capture':result['before']['databaseCapture'],'after_capture':result['after']['databaseCapture']}
  current=auth_heartbeat.read_auth_sessions(state,after)
  self.assertEqual([row[-1] for row in current['rows']],[None,THUMBPRINT])
  self.assertEqual(update.verify_migration_heartbeat_witness(before,after,witness,current,identity='m4',state=state,**captures),witness)
  self.assertNotIn('private-credential',self.output.read_text()+self.stdout.getvalue())
 def test_migration_069_never_excuses_another_filled_new_cell(self):
  for statement in ["UPDATE auth_sessions SET proof_key_thumbprint='"+THUMBPRINT+"' WHERE subject='owner'",
                    "UPDATE auth_sessions SET proof_key_thumbprint='short' WHERE subject='cloud-connect'",
                    "UPDATE auth_sessions SET proof_key_thumbprint=X'00' WHERE subject='cloud-connect'",
                    "UPDATE auth_sessions SET proof_key_thumbprint='"+THUMBPRINT+"', method='bearer-access-token' WHERE subject='cloud-connect'"]:
   with self.subTest(statement=statement):
    self.setUp();self.use_captured_waiting_state(*PRINCIPAL,*CONNECT_SESSION)
    self.reject_real_migration(*STATEMENTS,statement,pattern='filled a new column|changed');self.tearDown()
 def test_migration_069_never_excuses_a_changed_earlier_auth_cell(self):
  for statement in ["UPDATE auth_sessions SET scopes='admin'","UPDATE auth_sessions SET revoked_at=NULL",
                    "UPDATE auth_sessions SET principal_generation=1",
                    "INSERT INTO auth_sessions(session_id,subject,scopes) VALUES ('planted','synthetic-private','[]')"]:
   with self.subTest(statement=statement):
    self.setUp();self.use_captured_waiting_state(*PRINCIPAL,"UPDATE auth_sessions SET revoked_at='2026-10-01T00:00:00Z'")
    self.reject_real_migration(*STATEMENTS,statement,pattern='changed|filled a new column');self.tearDown()
 def test_another_index_column_default_or_trigger_is_refused(self):
  for migrated,pattern in [(with_statement('WHERE proof_key_thumbprint IS NOT NULL',''),'auth schema changed'),
                           (with_statement('auth_sessions_proof_key_thumbprint_idx','auth_sessions_key_idx'),'auth schema changed'),
                           (STATEMENTS+('CREATE INDEX planted ON auth_sessions(subject)',),'auth schema changed'),
                           (STATEMENTS[:1],'auth schema changed'),
                           (with_statement('proof_key_thumbprint TEXT',"proof_key_thumbprint TEXT NOT NULL DEFAULT ''"),'auth sessions or history'),
                           (STATEMENTS+('ALTER TABLE auth_sessions ADD COLUMN scope TEXT',),'auth sessions or history'),
                           (STATEMENTS+('CREATE TRIGGER planted AFTER UPDATE ON projection_projects BEGIN UPDATE auth_sessions SET proof_key_thumbprint=NULL; END',),'trigger touching')]:
   with self.subTest(statement=migrated[-1][-70:]):
    self.setUp();self.use_captured_waiting_state(*PRINCIPAL)
    self.reject_real_migration(*migrated,pattern=pattern);self.tearDown()
 def test_after_069_its_index_stays_and_an_unrelated_migration_verifies(self):
  installed=PRINCIPAL+STATEMENTS
  self.use_captured_waiting_state(*installed);self.reject_real_migration('DROP INDEX auth_sessions_proof_key_thumbprint_idx',pattern='auth schema changed')
  self.tearDown();self.setUp();self.use_captured_waiting_state(*installed)
  self.migrate_real();self.execute(allow_project_migrations=True)
  self.assertEqual(json.loads(self.output.read_text())['phase'],'verified')
if __name__=='__main__':unittest.main()
