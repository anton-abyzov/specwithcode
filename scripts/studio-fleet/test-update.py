#!/usr/bin/env python3
"""CAS and privacy guards: pure temporary metadata, never production services."""
import contextlib,copy,datetime,importlib.util,io,json,pathlib,shlex,shutil,sqlite3,tempfile,unittest
from unittest.mock import patch
import auth_heartbeat
import os,time
import release_retention
import state_backup
import studio_paths
from launcher import legacy_runtime_path, runtime_path
spec=importlib.util.spec_from_file_location("owned_update",pathlib.Path(__file__).with_name("update.py"))
update=importlib.util.module_from_spec(spec);spec.loader.exec_module(update)
REAL_ROWS_SNAPSHOT,REAL_ROWS_SINCE=update.rows_snapshot,update.rows_since
DISK=__import__('collections').namedtuple('DiskUsage','total used free')
# What every apply now asks of launchd for its restart: the job unloaded (the copy is taken then) and loaded again.
RESTART=['bootout','bootstrap']
WAITING_SCHEMA="""
CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY, title TEXT);
CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY);
CREATE TABLE projection_state(projector TEXT PRIMARY KEY, last_applied_sequence INTEGER, updated_at TEXT);
CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, stream_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL);
CREATE TABLE orchestration_command_receipts(command_id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, result_sequence INTEGER NOT NULL, status TEXT NOT NULL);
CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, project_id TEXT, updated_at TEXT, payload_json TEXT);
CREATE TABLE orchestration_v2_projection_messages(message_id TEXT PRIMARY KEY, thread_id TEXT, text TEXT);
CREATE TABLE orchestration_v2_projection_metadata(projection_name TEXT PRIMARY KEY, schema_version INTEGER, last_sequence INTEGER, updated_at TEXT);
CREATE TABLE orchestration_v2_projection_runs(run_id TEXT PRIMARY KEY, thread_id TEXT, status TEXT);
CREATE TABLE orchestration_v2_projection_runtime_requests(status TEXT);
CREATE TABLE orchestration_v2_effect_outbox(status TEXT);
CREATE TABLE orchestration_v2_projection_provider_sessions(status TEXT);
CREATE TABLE auth_sessions(session_id TEXT, subject TEXT, scopes TEXT, last_connected_at TEXT, revoked_at TEXT);
CREATE TABLE auth_pairing_links(id TEXT, credential TEXT);
CREATE TABLE scheduled_tasks(id TEXT, cron TEXT);
"""
def waiting_fixture(state):
 """Two idle threads; t-wait waits on a usage limit, t-idle is finished."""
 state.mkdir(parents=True,exist_ok=True)
 db=sqlite3.connect(state/'statev2.sqlite');db.executescript(WAITING_SCHEMA)
 db.execute("INSERT INTO projection_projects VALUES ('p1','Project')")
 for thread in ['t-wait','t-idle']:
  db.execute("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?)",(thread,'p1','2026-10-11T03:00:00Z','{"limit":"waiting"}' if thread=='t-wait' else '{}'))
  db.execute("INSERT INTO orchestration_v2_projection_messages VALUES (?,?,?)",('m-'+thread,thread,'synthetic-private-message'))
  db.execute("INSERT INTO orchestration_v2_projection_runs VALUES (?,?,'interrupted')",('r-'+thread,thread))
  for kind in ['thread.created','run.updated']:
   cursor=db.execute("INSERT INTO orchestration_events(event_id,stream_id,event_type,payload_json) VALUES (?,?,?,?)",(kind+thread,thread,kind,'{"private":"synthetic-private-payload"}'))
   db.execute("INSERT INTO orchestration_command_receipts VALUES (?,?,?,'accepted')",('c-'+kind+thread,thread,cursor.lastrowid))
 db.execute("INSERT INTO orchestration_v2_projection_metadata VALUES ('thread-projections',2,4,'2026-10-11T03:00:00Z')")
 db.execute("INSERT INTO auth_sessions VALUES ('s1','owner','operate','2026-10-11T03:00:00Z',NULL)")
 db.execute("INSERT INTO auth_pairing_links VALUES ('grant','synthetic-private-credential')")
 db.execute("INSERT INTO scheduled_tasks VALUES ('nightly','0 3 * * *')")
 db.commit();db.close()
def waiting_check(state,label,thread='t-wait'):
 """What one usage-limit availability check writes: an event, its receipt, the thread's
 projection row and the projection cursor (UsageLimitRecoveryWorker limit-check)."""
 db=sqlite3.connect(state/'statev2.sqlite')
 cursor=db.execute("INSERT INTO orchestration_events(event_id,stream_id,event_type,payload_json) VALUES (?,?,'thread.metadata-updated',?)",('limit-check-'+label,thread,'{"limitAvailability":"'+label+'"}'))
 db.execute("INSERT INTO orchestration_command_receipts VALUES (?,?,?,'accepted')",('limit-check:'+label,thread,cursor.lastrowid))
 db.execute("UPDATE orchestration_v2_projection_threads SET updated_at=?,payload_json=? WHERE thread_id=?",('2026-10-11T04:0%sZ'%len(label),'{"checked":"'+label+'"}',thread))
 db.execute("UPDATE orchestration_v2_projection_metadata SET last_sequence=?,updated_at=?",(cursor.lastrowid,'2026-10-11T04:00:00Z'))
 db.commit();db.close()
def mutate_state(state,*statements):
 db=sqlite3.connect(state/'statev2.sqlite')
 for statement in statements:db.execute(statement)
 db.commit();db.close()
class ReleaseRetention(unittest.TestCase):
 def fixture(self, home, names, age):
  root=release_retention.releases_root(home);root.mkdir(parents=True)
  for name in names:
   (root/name).mkdir();(root/name/'bin.mjs').write_text('x')
   moment=time.time()-age;os.utime(root/name,(moment,moment))
  return root
 def test_keeps_current_previous_and_referenced_releases_and_prunes_the_rest(self):
  with tempfile.TemporaryDirectory() as tmp:
   home=pathlib.Path(tmp).resolve()
   names=['%020x'%index for index in range(1,8)]
   root=self.fixture(home,names,age=86400)
   new,old,stage,receipt,*stale=names
   (home/'.specwithcode/m4').mkdir(parents=True)
   (home/'.specwithcode/stage').mkdir(parents=True)
   (home/'.specwithcode/stage/launch.sh').write_text('exec node %s/bin.mjs\n'%(root/stage))
   (home/'.specwithcode/m1').mkdir(parents=True)
   (home/'.specwithcode/m1/installation.json').write_text(json.dumps({'release':str(root/receipt)}))
   (root/'not-a-release').mkdir();(root/'notes.txt').write_text('keep')
   fresh='f'*20;(root/fresh).mkdir()
   removed=release_retention.prune_releases(home,[root/new,str(root/old)])
   self.assertEqual(sorted(removed),sorted(stale))
   self.assertEqual(sorted(p.name for p in root.iterdir()),sorted([new,old,stage,receipt,fresh,'not-a-release','notes.txt']))
 def test_symlinked_release_root_or_entries_are_never_followed(self):
  with tempfile.TemporaryDirectory() as tmp:
   home=pathlib.Path(tmp).resolve();outside=home/'outside';outside.mkdir()
   (outside/('a'*20)).mkdir()
   root=release_retention.releases_root(home);root.parent.mkdir(parents=True);root.symlink_to(outside)
   self.assertEqual(release_retention.prune_releases(home,[],now=time.time()+86400),[])
   self.assertTrue((outside/('a'*20)).is_dir())
   root.unlink();root.mkdir();(root/('b'*20)).symlink_to(outside/('a'*20))
   self.assertEqual(release_retention.prune_releases(home,[],now=time.time()+86400),[])
   self.assertTrue((outside/('a'*20)).is_dir())
 def test_a_verified_update_prunes_with_the_new_and_previous_release(self):
  source=pathlib.Path(update.__file__).read_text()
  self.assertIn("prune_releases(home, [new_release, old_release])",source)
  self.assertLess(source.index("prune_releases(home, [new_release, old_release])"),source.index("print(json.dumps({'identity': identity, 'result': 'updated'"))
class StateBackupRetention(unittest.TestCase):
 def backup(self, root, stamp, age, files=('statev2.sqlite','settings.json')):
  folder=root/('pre-%s-%s-%s'%('abc123def456',stamp,'0'*32));folder.mkdir(parents=True)
  for name in files:(folder/name).write_text('x')
  moment=time.time()-age;os.utime(folder,(moment,moment))
  return folder
 def test_keeps_the_newest_and_protected_copies_and_prunes_the_rest(self):
  with tempfile.TemporaryDirectory() as tmp:
   home=pathlib.Path(tmp).resolve();root=studio_paths.backups_root(home)
   old=[self.backup(root,'202610%02dT000000Z'%day,86400) for day in range(1,8)]
   kept=old[2]
   odd=self.backup(root,'20261009T000000Z',86400,files=('statev2.sqlite','notes.md'))
   fresh=self.backup(root,'20260101T000000Z',60)
   legacy=root/'pre-753f7067b-20260910T021513';legacy.mkdir();(legacy/'statev2.sqlite').write_text('x');os.utime(legacy,(time.time()-86400,)*2)
   (root/'home-migration-20261016T135351Z').mkdir();(root/'pre-0.2.10-20261011T203834Z').mkdir()
   removed=release_retention.prune_state_backups(home,[kept/'statev2.sqlite'],keep_newest=2)
   self.assertEqual(removed,sorted([legacy.name]+[p.name for p in old[:5] if p!=kept]))
   self.assertEqual(sorted(p.name for p in root.iterdir()),sorted([odd.name,old[6].name,old[5].name,kept.name,fresh.name,'home-migration-20261016T135351Z','pre-0.2.10-20261011T203834Z']))
 def test_symlinked_backups_root_or_entries_are_never_followed(self):
  with tempfile.TemporaryDirectory() as tmp:
   home=pathlib.Path(tmp).resolve();outside=home/'outside'
   target=self.backup(outside,'20261001T000000Z',86400)
   root=studio_paths.backups_root(home);root.parent.mkdir(parents=True);root.symlink_to(outside)
   self.assertEqual(release_retention.prune_state_backups(home,keep_newest=0),[])
   root.unlink();root.mkdir();(root/target.name).symlink_to(target)
   self.assertEqual(release_retention.prune_state_backups(home,keep_newest=0),[])
   self.assertTrue((target/'statev2.sqlite').is_file())
 def test_an_update_prunes_state_backups_only_on_a_shortfall_before_copying_the_database(self):
  # The usual prune runs after a verified update (test-state-backup-prune.py).
  source=pathlib.Path(update.__file__).read_text();copy_at=source.index("state_backup, progress['stateBackupMethod'] = backup_state_clone(own, before['artifactSourceCommit'])")
  self.assertEqual(source.count('prune_state_backups('),2)
  # Before the copy: the bound that removes nothing after verified updates, then the shortfall's.
  self.assertLess(source.index('keep_newest=state_backup_prune.KEPT_AFTER_INSTALL if agent_run else 1'),source.index('for keep_newest in (1, 0):'))
  self.assertIn('for keep_newest in (1, 0):',source)
  self.assertIn('prune_state_backups(home, keep=held_state_backups(own), keep_newest=keep_newest, only_if_frees=needed - free)',source)
  self.assertLess(source.index('only_if_frees=needed - free'),copy_at)
  self.assertGreater(source.index('state_backup_prune.spawn(identity, home, output'),copy_at)
 def test_a_copy_cut_short_is_removed(self):
  with tempfile.TemporaryDirectory() as tmp:
   home=pathlib.Path(tmp).resolve();own=home/'.specwithcode/m4';(own/'userdata').mkdir(parents=True)
   sqlite3.connect(own/'userdata/statev2.sqlite').execute('CREATE TABLE t(x)').connection.commit()
   class Failing:
    def __init__(self,real):self.real=real
    def backup(self,target):raise sqlite3.OperationalError('database or disk is full')
    def close(self):self.real.close()
   with patch.object(pathlib.Path,'home',return_value=home),patch.object(update.live_database,'connect',side_effect=lambda path:Failing(sqlite3.connect(path))):
    with self.assertRaises(sqlite3.OperationalError):update.backup_state(own,'abc')
   self.assertEqual(list(studio_paths.backups_root(home).iterdir()),[])
class UpdateGuards(unittest.TestCase):
 def idle_fixture(self, state):
  db=sqlite3.connect(state/'statev2.sqlite')
  db.executescript("CREATE TABLE projection_projects(project_id TEXT);CREATE TABLE projection_threads(thread_id TEXT);CREATE TABLE orchestration_v2_projection_runs(status TEXT);CREATE TABLE orchestration_v2_projection_runtime_requests(status TEXT);CREATE TABLE orchestration_v2_effect_outbox(status TEXT, retained_content TEXT);CREATE TABLE orchestration_v2_projection_provider_sessions(status TEXT);")
  return db
 def test_actual_terminal_effect_history_is_accepted_and_hashed_without_mutation(self):
  with tempfile.TemporaryDirectory() as tmp:
   state=pathlib.Path(tmp);db=self.idle_fixture(state)
   db.executemany('INSERT INTO orchestration_v2_effect_outbox VALUES (?,?)',[(status,'synthetic-private-history') for status in ['succeeded','failed','cancelled']]);db.commit();db.close()
   original=(state/'statev2.sqlite').read_bytes();value=update.rows_snapshot(state)
   self.assertTrue(value['nativeWorkIdle']);self.assertEqual(value['counts']['orchestration_v2_effect_outbox'],3)
   self.assertEqual(len(value['hashes']['orchestration_v2_effect_outbox']),64)
   self.assertNotIn('synthetic-private-history',json.dumps(value));self.assertEqual((state/'statev2.sqlite').read_bytes(),original)
 def test_active_null_and_unknown_effect_statuses_fail_closed_without_mutation(self):
  for status in ['pending','running',None,'unknown','completed']:
   with self.subTest(status=status),tempfile.TemporaryDirectory() as tmp:
    state=pathlib.Path(tmp);db=self.idle_fixture(state)
    db.execute('INSERT INTO orchestration_v2_effect_outbox VALUES (?,?)',(status,'retained'));db.commit();db.close()
    original=(state/'statev2.sqlite').read_bytes()
    with self.assertRaisesRegex(AssertionError,'Native work is not idle'):update.rows_snapshot(state)
    self.assertEqual((state/'statev2.sqlite').read_bytes(),original)
 def test_terminal_effects_do_not_bypass_active_run_request_or_session_gates(self):
  for table,status in [('orchestration_v2_projection_runs','running'),('orchestration_v2_projection_runtime_requests','pending'),('orchestration_v2_projection_provider_sessions','working')]:
   with self.subTest(table=table),tempfile.TemporaryDirectory() as tmp:
    state=pathlib.Path(tmp);db=self.idle_fixture(state)
    db.execute("INSERT INTO orchestration_v2_effect_outbox VALUES ('succeeded','retained')")
    db.execute('INSERT INTO '+table+' VALUES (?)',(status,));db.commit();db.close()
    original=(state/'statev2.sqlite').read_bytes()
    with self.assertRaisesRegex(AssertionError,'Native work is not idle'):update.rows_snapshot(state)
    self.assertEqual((state/'statev2.sqlite').read_bytes(),original)
 def test_project_memory_plan_and_context_tables_are_hashed_without_content(self):
  with tempfile.TemporaryDirectory() as tmp:
   state=pathlib.Path(tmp);db=self.idle_fixture(state)
   for table in ['project_memory','project_plans','project_context_deliveries','scheduled_task_run_receipts']:
    db.execute('CREATE TABLE '+table+'(private_content TEXT)');db.execute('INSERT INTO '+table+' VALUES (?)',('synthetic-private-content',))
   db.commit();db.close();value=update.rows_snapshot(state)
   for table in ['project_memory','project_plans','project_context_deliveries','scheduled_task_run_receipts']:
    self.assertEqual(value['counts'][table],1);self.assertEqual(len(value['hashes'][table]),64)
   self.assertNotIn('synthetic-private-content',json.dumps(value))
 def test_every_protected_change_fails_closed(self):
  keys=['identity','uid','serviceLabel','servicePid','archiveSha256','artifactSourceCommit','fileHashes','rows','otherListeners','cookieName','processQuiescence']
  expected={key:{'nativeWorkIdle':True} if key=='rows' else key for key in keys}
  update.assert_prestate(expected,copy.deepcopy(expected))
  for key in keys:
   actual=copy.deepcopy(expected);actual[key]='changed'
   with self.subTest(key=key),self.assertRaises(AssertionError):update.assert_prestate(expected,actual)
 def test_server_browser_may_come_and_go_but_the_service_tree_may_not(self):
  core={'root':{'pid':100,'uid':501},'parentIdentitySha256':'p','supervisor':{'pid':101},'treeSha256':'t','descendantCount':1}
  browser={'browserCount':1,'processCount':4,'browsers':[{'pid':300}],'treeSha256':'b'}
  def prestate(quiet):
   value={**{key:key for key in ['identity','uid','serviceLabel','servicePid','archiveSha256','artifactSourceCommit','fileHashes','otherListeners','cookieName']},'otherListenersOwned':False}
   value['rows']={'nativeWorkIdle':True};value['processQuiescence']=quiet;return value
  for before,after in [({**core,'serverBrowser':browser},core),(core,{**core,'serverBrowser':browser}),
                       ({**core,'serverBrowser':browser},{**core,'serverBrowser':{**browser,'treeSha256':'other'}})]:
   update.assert_prestate(prestate(before),prestate(after))
  for key,value in [('root',{'pid':102,'uid':501}),('supervisor',{'pid':103}),('treeSha256','changed'),('parentIdentitySha256','x')]:
   with self.subTest(key=key),self.assertRaisesRegex(AssertionError,'processQuiescence'):
    update.assert_prestate(prestate({**core,'serverBrowser':browser}),prestate({**core,key:value,'serverBrowser':browser}))
 def test_nonidle_receipt_is_not_an_admission(self):
  value={**{key:None for key in ['identity','uid','serviceLabel','servicePid','archiveSha256','artifactSourceCommit','fileHashes','otherListeners','cookieName','processQuiescence']},'otherListenersOwned':False}
  value['rows']={'nativeWorkIdle':False}
  with self.assertRaises(AssertionError):update.assert_prestate(value,copy.deepcopy(value))
 def test_symlinked_ancestor_is_rejected(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);(root/'outside').mkdir();(root/'owned').symlink_to(root/'outside',target_is_directory=True)
   with self.assertRaises(AssertionError):update.safe_path(root/'owned'/'file',root)
 def test_verified_staged_release_can_be_reused_after_failure_without_deleting_either_release(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp).resolve();stage=root/'stage';stage.mkdir();(stage/'bin.mjs').write_bytes(b'owned-code')
   manifest={'product':'SpecWeave Studio','version':'0.1.0','files':[{'path':'bin.mjs','type':'file','sha256':update.digest(b'owned-code')}]}
   (stage/'studio-manifest.json').write_text(json.dumps(manifest));destination=root/'new-release'
   update.publish_release(stage,destination)
   old=root/'old-release';old.mkdir();(old/'retained').write_text('old-runtime')
   shutil.copytree(destination,stage)
   update.publish_release(stage,destination)  # A failure left a valid immutable release; retry reanchors it.
   self.assertTrue(stage.is_dir());self.assertEqual((old/'retained').read_text(),'old-runtime')
   (destination/'bin.mjs').write_bytes(b'foreign-change')
   with self.assertRaises(AssertionError):update.publish_release(stage,destination)
 def test_row_proof_contains_hashes_and_shell_ids_but_no_content_or_credentials(self):
  with tempfile.TemporaryDirectory() as tmp:
   state=pathlib.Path(tmp);db=sqlite3.connect(state/'statev2.sqlite')
   db.executescript("CREATE TABLE projection_projects(project_id TEXT, private_content TEXT);CREATE TABLE projection_threads(thread_id TEXT);CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT);CREATE TABLE auth_pairing_links(id TEXT, credential TEXT);CREATE TABLE orchestration_v2_projection_runs(status TEXT);CREATE TABLE orchestration_v2_projection_runtime_requests(status TEXT);CREATE TABLE orchestration_v2_effect_outbox(status TEXT);CREATE TABLE orchestration_v2_projection_provider_sessions(status TEXT);")
   db.execute("INSERT INTO orchestration_v2_projection_threads VALUES ('actual-v2-draft')")
   db.execute("INSERT INTO projection_projects VALUES (?,?)",('owned-project','synthetic-private-prompt'))
   db.execute("INSERT INTO auth_pairing_links VALUES (?,?)",('grant','synthetic-private-credential'));db.commit()
   value=update.rows_snapshot(state)
   self.assertEqual(value['projectIds'],['owned-project']);self.assertTrue(value['nativeWorkIdle'])
   self.assertEqual(value['threadIds'],['actual-v2-draft'])
   self.assertNotIn('synthetic-private',json.dumps(value))
   db.execute("INSERT INTO orchestration_v2_projection_runs VALUES ('running')");db.commit()
   with self.assertRaises(AssertionError):update.rows_snapshot(state)
   db.close()

class WaitingThreadActivity(unittest.TestCase):
 """A thread waiting on a usage limit keeps appending while the update stages."""
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='studio-update-waiting-');self.state=pathlib.Path(self.temp.name)
  waiting_fixture(self.state);self.before=REAL_ROWS_SNAPSHOT(self.state)
 def tearDown(self):self.temp.cleanup()
 def prestate(self,rows,**changes):
  value={**{key:key for key in ['identity','uid','serviceLabel','servicePid','archiveSha256','artifactSourceCommit','otherListeners','cookieName','processQuiescence']},'otherListenersOwned':False}
  value['fileHashes']={'settings':'s','environment':'e'};value['rows']=rows;value.update(changes);return value
 def rejects(self,*statements,check=True):
  if check:waiting_check(self.state,'a')
  mutate_state(self.state,*statements)
  rows,carried=REAL_ROWS_SINCE(self.state,self.before)
  self.assertFalse(update.same_guarded_rows(self.before,rows,carried))
  with self.assertRaisesRegex(AssertionError,'Guarded prestate changed: rows'):update.assert_prestate(self.prestate(self.before),self.prestate(rows),carried)
 def test_prestate_rejects_blob_to_hex_text_even_when_legacy_auth_hash_matches(self):
  mutate_state(self.state,"UPDATE auth_sessions SET scopes=X'6162'")
  before=REAL_ROWS_SNAPSHOT(self.state)
  mutate_state(self.state,"UPDATE auth_sessions SET scopes='6162'")
  after,carried=REAL_ROWS_SINCE(self.state,before)
  self.assertEqual(before['hashes']['auth_sessions'],after['hashes']['auth_sessions'])
  self.assertFalse(update.same_guarded_rows(before,after,carried))
  self.assertFalse(update.same_guarded_rows(before,after))
 def test_prestate_rejects_auth_schema_change(self):
  mutate_state(self.state,'CREATE INDEX auth_subject ON auth_sessions(subject)')
  after,carried=REAL_ROWS_SINCE(self.state,self.before)
  self.assertFalse(update.same_guarded_rows(self.before,after,carried))
 def test_appended_waiting_thread_checks_pass_and_are_kept(self):
  waiting_check(self.state,'a');waiting_check(self.state,'bb')
  rows,carried=REAL_ROWS_SINCE(self.state,self.before)
  self.assertFalse(update.same_guarded_rows(self.before,rows),'Without the appended-rows proof the change is still refused')
  self.assertTrue(update.same_guarded_rows(self.before,rows,carried))
  update.assert_prestate(self.prestate(self.before),self.prestate(rows),carried)
  self.assertEqual(carried['appendedRows'],{'orchestration_events':2,'orchestration_command_receipts':2})
  self.assertEqual(carried['touchedStreams'],['t-wait'])
  self.assertEqual(rows['counts']['orchestration_events'],self.before['counts']['orchestration_events']+2)
  # The next check compares with the newer proof and still sees only the new rows.
  waiting_check(self.state,'ccc');later,carried=REAL_ROWS_SINCE(self.state,rows)
  self.assertTrue(update.same_guarded_rows(rows,later,carried));self.assertEqual(carried['appendedRows']['orchestration_events'],1)
 def test_no_activity_is_byte_identical(self):
  rows,carried=REAL_ROWS_SINCE(self.state,self.before)
  self.assertEqual(rows,self.before);self.assertTrue(update.same_guarded_rows(self.before,rows,carried))
 def test_modified_pre_existing_rows_still_fail(self):
  for statement in ["UPDATE orchestration_events SET payload_json='edited' WHERE sequence=1",
                    "UPDATE orchestration_events SET payload_json='edited' WHERE sequence=4",
                    "UPDATE orchestration_command_receipts SET status='rejected' WHERE command_id='c-thread.createdt-idle'",
                    "UPDATE orchestration_v2_projection_threads SET payload_json='edited' WHERE thread_id='t-idle'",
                    "UPDATE orchestration_v2_projection_messages SET text='edited' WHERE thread_id='t-idle'",
                    "UPDATE orchestration_v2_projection_metadata SET schema_version=3",
                    "UPDATE projection_projects SET title='renamed'"]:
   with self.subTest(statement=statement):
    self.setUp();self.rejects(statement)
 def test_deleted_rows_still_fail(self):
  for statement in ["DELETE FROM orchestration_events WHERE sequence=1",
                    "DELETE FROM orchestration_events WHERE sequence=4",
                    "DELETE FROM orchestration_command_receipts WHERE command_id='c-run.updatedt-wait'",
                    "DELETE FROM orchestration_v2_projection_messages WHERE thread_id='t-idle'",
                    "DELETE FROM orchestration_v2_projection_threads WHERE thread_id='t-idle'",
                    "DELETE FROM projection_projects"]:
   with self.subTest(statement=statement):
    self.setUp();self.rejects(statement)
 def test_auth_pairing_and_schedule_changes_still_fail(self):
  for statement in ["UPDATE auth_sessions SET scopes='admin'","UPDATE auth_sessions SET revoked_at='2026-10-11T04:00:00Z'",
                    "INSERT INTO auth_sessions VALUES ('s2','owner','operate','2026-10-11T04:00:00Z',NULL)",
                    "INSERT INTO auth_pairing_links VALUES ('grant-2','synthetic-private-credential')",
                    "UPDATE scheduled_tasks SET cron='* * * * *'"]:
   with self.subTest(statement=statement):
    self.setUp();self.rejects(statement)
 def test_settings_environment_and_identity_changes_still_fail_beside_appended_rows(self):
  waiting_check(self.state,'a');rows,carried=REAL_ROWS_SINCE(self.state,self.before)
  for key,value in [('fileHashes',{'settings':'changed','environment':'e'}),('fileHashes',{'settings':'s','environment':'changed'}),
                    ('cookieName','other-cookie'),('identity','m1'),('otherListenersOwned',True)]:
   with self.subTest(key=key),self.assertRaisesRegex(AssertionError,'Guarded prestate changed: '+key):
    update.assert_prestate(self.prestate(self.before),self.prestate(rows,**{key:value}),carried)
 def test_service_owns_listener_only_for_its_own_tree(self):
  processes={100:{'parent':1},200:{'parent':100},300:{'parent':200},909:{'parent':1},2521:{'parent':1}}
  self.assertFalse(update.service_owns_listener({'8317':[909],'18319':[2521],'28319':[]},100,processes))
  self.assertTrue(update.service_owns_listener({'18319':[300]},100,processes))
  self.assertTrue(update.service_owns_listener({'8318':[100]},100,processes))
 def test_another_services_listener_restarting_does_not_refuse(self):
  waiting_check(self.state,'a');rows,carried=REAL_ROWS_SINCE(self.state,self.before)
  update.assert_prestate(self.prestate(self.before,otherListeners={'18319':[]},otherListenersOwned=False),
                         self.prestate(rows,otherListeners={'18319':[87381]},otherListenersOwned=False),carried)
 def test_auth_heartbeat_beside_appended_rows_passes_only_where_heartbeats_are_allowed(self):
  waiting_check(self.state,'a');mutate_state(self.state,"UPDATE auth_sessions SET last_connected_at='2026-10-11T04:05:00Z'")
  rows,carried=REAL_ROWS_SINCE(self.state,self.before)
  self.assertTrue(update.same_guarded_rows(self.before,rows,carried))
  self.assertFalse(update.same_guarded_rows(self.before,rows,carried,auth_heartbeat=False))
 def test_projection_changes_without_a_new_event_still_fail(self):
  self.rejects("UPDATE orchestration_v2_projection_threads SET payload_json='{}' WHERE thread_id='t-wait'",check=False)
  self.setUp();self.rejects("UPDATE orchestration_v2_projection_metadata SET last_sequence=9",check=False)
  self.setUp();self.rejects("INSERT INTO orchestration_v2_projection_messages VALUES ('m-new','t-new','x')",check=False)
 def test_events_for_one_thread_never_excuse_changes_to_another(self):
  self.rejects("UPDATE orchestration_v2_projection_runs SET status='completed' WHERE thread_id='t-idle'")
 def test_a_new_thread_with_its_own_events_carries_forward(self):
  waiting_check(self.state,'a',thread='t-new')
  mutate_state(self.state,"INSERT INTO orchestration_v2_projection_threads VALUES ('t-new','p1','2026-10-11T04:00:00Z','{}')")
  rows,carried=REAL_ROWS_SINCE(self.state,self.before)
  self.assertTrue(update.same_guarded_rows(self.before,rows,carried));self.assertIn('t-new',rows['threadIds'])
 def project_save(self,project='p1',title='Saved settings'):
  """What a startup settings save writes: a project event, its receipt, the project's
  projection row and the projection cursor (ProjectSettingsNormalizer)."""
  db=sqlite3.connect(self.state/'statev2.sqlite')
  cursor=db.execute("INSERT INTO orchestration_events(event_id,stream_id,event_type,payload_json) VALUES (?,?,'project.meta-updated','{}')",('save-'+project+title,project))
  db.execute("INSERT INTO orchestration_command_receipts VALUES (?,?,?,'accepted')",('project-settings-normalize:'+project+title,project,cursor.lastrowid))
  db.execute("UPDATE projection_projects SET title=? WHERE project_id=?",(title,project))
  db.execute("INSERT OR REPLACE INTO projection_state VALUES ('projects',?,'2026-10-11T04:00:00Z')",(cursor.lastrowid,))
  db.commit();db.close()
 def test_a_project_saved_with_its_own_event_carries_forward(self):
  mutate_state(self.state,"INSERT INTO projection_state VALUES ('projects',4,'2026-10-11T03:00:00Z')")
  before,_,_,capture=update._read_state(self.state,False,None,True)
  self.project_save()
  rows,_,carried,after_capture=update._read_state(self.state,False,before,True)
  self.assertEqual(carried['touchedStreams'],['p1'])
  self.assertFalse(update.same_guarded_rows(before,rows),'Without the appended-rows proof the change is still refused')
  self.assertTrue(update.same_guarded_rows(before,rows,carried,auth_heartbeat=False))
  update.assert_capture_carried(capture,after_capture,before,rows,carried,auth_heartbeat=False)
  update.assert_prestate(self.prestate(before),self.prestate(rows),carried)
 def test_a_project_event_never_excuses_another_project_or_a_thread(self):
  for statement in ["UPDATE projection_projects SET title='renamed' WHERE project_id='p2'",
                    "UPDATE orchestration_v2_projection_threads SET payload_json='edited' WHERE thread_id='t-idle'",
                    "INSERT INTO projection_projects VALUES ('p3','New')",
                    "DELETE FROM projection_projects WHERE project_id='p2'"]:
   with self.subTest(statement=statement):
    self.setUp();mutate_state(self.state,"INSERT INTO projection_projects VALUES ('p2','Other')")
    before=REAL_ROWS_SNAPSHOT(self.state)
    self.project_save();mutate_state(self.state,statement)
    rows,carried=REAL_ROWS_SINCE(self.state,before)
    self.assertFalse(update.same_guarded_rows(before,rows,carried,auth_heartbeat=False))
 def test_a_project_row_changed_without_an_event_still_fails(self):
  self.rejects("UPDATE projection_projects SET title='renamed' WHERE project_id='p1'",check=False)
 def test_running_work_is_never_carried_forward(self):
  waiting_check(self.state,'a');mutate_state(self.state,"UPDATE orchestration_v2_projection_runs SET status='running' WHERE thread_id='t-wait'")
  with self.assertRaisesRegex(AssertionError,'Native work is not idle'):REAL_ROWS_SINCE(self.state,self.before)
 def test_an_older_proof_without_activity_is_compared_exactly(self):
  legacy=dict(self.before);del legacy[update.ACTIVITY_KEY]
  waiting_check(self.state,'a');rows,carried=REAL_ROWS_SINCE(self.state,legacy)
  self.assertIsNone(carried);self.assertFalse(update.same_guarded_rows(legacy,rows,carried))
 def test_a_carried_proof_for_another_snapshot_is_not_accepted(self):
  waiting_check(self.state,'a');middle,_=REAL_ROWS_SINCE(self.state,self.before)
  waiting_check(self.state,'bb');rows,carried=REAL_ROWS_SINCE(self.state,middle)
  self.assertFalse(update.same_guarded_rows(self.before,rows,carried))
 def test_proofs_hold_no_message_payload_or_credential_content(self):
  waiting_check(self.state,'a');rows,carried=REAL_ROWS_SINCE(self.state,self.before)
  text=json.dumps([self.before,rows,carried])
  for secret in ['synthetic-private','limitAvailability','operate','owner']:self.assertNotIn(secret,text)
 def test_migration_keeps_history_exact_but_carries_appended_rows(self):
  waiting_check(self.state,'a');rows,carried=REAL_ROWS_SINCE(self.state,self.before)
  update.assert_migration_preserved(self.before,rows,carried)
  with self.assertRaisesRegex(AssertionError,'History'):update.assert_migration_preserved(self.before,rows)
  mutate_state(self.state,"UPDATE orchestration_events SET payload_json='edited' WHERE sequence=2")
  rows,carried=REAL_ROWS_SINCE(self.state,self.before)
  with self.assertRaisesRegex(AssertionError,'History'):update.assert_migration_preserved(self.before,rows,carried)
 def resume_after_update(self,label):
  """What startup recovery writes for each run a forced update interrupted
  (ProviderRuntimeRecoveryService continueUpdateInterruptedRuns): a receipt-backed
  command and a provider-runtime.continue effect, settled before the next snapshot."""
  db=sqlite3.connect(self.state/'statev2.sqlite')
  for thread in ['t-wait','t-idle']:
   cursor=db.execute("INSERT INTO orchestration_events(event_id,stream_id,event_type,payload_json) VALUES (?,?,'run.updated','{}')",('continue-'+label+thread,thread))
   db.execute("INSERT INTO orchestration_command_receipts VALUES (?,?,?,'accepted')",('command:update-continue:'+label+thread,thread,cursor.lastrowid))
   db.execute("INSERT INTO orchestration_v2_effect_outbox VALUES ('failed')")
  db.commit();db.close()
 def test_continuations_enqueued_before_the_post_restart_proof_fail_the_guard(self):
  # 1.0.37 on M4: the restarted service continued the held threads before the helper's
  # after-snapshot; the outbox grew, which no allowance covers, and the update rolled back.
  waiting_check(self.state,'a');self.resume_after_update('early')
  rows,carried=REAL_ROWS_SINCE(self.state,self.before)
  self.assertTrue(rows['nativeWorkIdle'])
  self.assertEqual(rows['counts']['orchestration_v2_effect_outbox'],self.before['counts']['orchestration_v2_effect_outbox']+2)
  with self.assertRaisesRegex(AssertionError,'History, provider, schedule or pairing rows changed'):
   update.assert_migration_preserved(self.before,rows,carried)
 def test_continuations_deferred_past_the_post_restart_proof_pass_the_guard(self):
  # Behind the install gate the service writes nothing to the outbox; the guard stays strict.
  waiting_check(self.state,'a')
  rows,carried=REAL_ROWS_SINCE(self.state,self.before)
  update.assert_migration_preserved(self.before,rows,carried)
  self.resume_after_update('late')  # After the helper removed its gate.
  later,carried=REAL_ROWS_SINCE(self.state,self.before)
  with self.assertRaisesRegex(AssertionError,'History'):update.assert_migration_preserved(self.before,later,carried)
class ApplyRecovery(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='studio-update-apply-');self.home=pathlib.Path(self.temp.name).resolve()
  self.own=self.home/'.specwithcode/m4';self.own.mkdir(parents=True)
  self.wrapper=self.home/'.local/bin/specweave-studio';self.wrapper.parent.mkdir(parents=True)
  self.plist=self.home/'Library/LaunchAgents/com.specweave.studio.m4.plist';self.plist.parent.mkdir(parents=True);self.plist.write_bytes(b'exact-owned-plist')
  self.archive=self.home/'archive.tgz';self.archive.write_bytes(b'verified-synthetic-archive');self.sha=update.digest(self.archive.read_bytes())
  self.oldrelease=str(self.home/'.specwithcode/install/releases/old');self.node='/exact/owned/node22'
  old=pathlib.Path(self.oldrelease);old.mkdir(parents=True);(old/'studio-manifest.json').write_text(json.dumps({'product':'SpecWeave Studio','version':'0.1.0','files':[]}))
  receipt={'node':self.node,'release':self.oldrelease,'sourceCommit':'old-source','archiveSha256':'old-sha'}
  (self.own/'installation.json').write_text(json.dumps(receipt))
  prefix=['/usr/bin/env','-i','HOME='+str(self.home),'PATH='+legacy_runtime_path(self.home,pathlib.Path(self.node)),'STUDIO_MODE=web',self.node,self.oldrelease+'/bin.mjs']
  (self.own/'launch.sh').write_text('#!/bin/sh\nset -eu\numask 077\ncd '+shlex.quote(str(self.own))+'\nexec '+' '.join(shlex.quote(s) for s in prefix)+' start\n')
  self.wrapper.write_text('#!/bin/sh\nset -eu\numask 077\nexec '+' '.join(shlex.quote(s) for s in prefix)+' "$@"\n')
  (self.own/'userdata').mkdir();(self.own/'userdata/server-runtime.json').write_text(json.dumps({'pid':100,'host':'127.0.0.1','port':8319}))
  self.original={p:p.read_bytes() for p in [self.wrapper,self.own/'launch.sh',self.own/'installation.json']}
  self.rows={'nativeWorkIdle':True,'projectIds':['original-project'],'threadIds':['original-thread'],'hashes':{'auth':'unchanged'}}
  self.before={'identity':'m4','uid':501,'serviceLabel':'com.specweave.studio.m4','servicePid':100,'archiveSha256':'old-sha','artifactSourceCommit':'old-source',
    'fileHashes':{'plist':update.digest(self.plist.read_bytes()),'settings':'unchanged','environment':'unchanged'},'rows':self.rows,'otherListeners':{},'otherListenersOwned':False,'cookieName':'exact-cookie','processQuiescence':{'root':{'pid':100,'uid':501},'treeSha256':'original-tree'}}
  self.output=self.home/'result.json';self.restart_calls=[];self.restarted=False;self.scenario='success'
  self.after_mutation=None
  self.incoming_version='0.1.0';self.incoming_source='new-source'
  self.on_restart=None
  self.quiescence_checks=[]
  self.auth_snapshot_phases=[]
  self.backups=[];self.restores=[];self.stops=[];self.launchd=[]
  self.real_db=False;self.on_stage=None;self.stage_timeouts=[]
  self.capture_database=False  # Real snapshots also carry the complete typed capture.
  self.clock=[1000.0]  # Fake monotonic time: sleeps advance it, so time-bounded waits end at once.
  self.gated_service=False  # The restarted service starts work on its own unless the install gate is live.
  self.gate_readings=[]
  self.loaded=True  # launchd has the job loaded: bootout unloads it, bootstrap loads it again.
  self.answers=[];self.reused=[]
 def tearDown(self):self.temp.cleanup()
 def install_gate_live(self):
  gate=self.own/'updates'/update.INSTALL_GATE_FILE
  try:value=json.loads(gate.read_text())
  except (OSError,ValueError):return False
  return value.get('helperPid')==os.getpid() and isinstance(value.get('at'),str)
 def snapshot(self,identity):
  if not self.restart_calls:return copy.deepcopy(self.before)
  if self.gated_service:
   live=self.install_gate_live();self.gate_readings.append(live)
   # A restarted service with nothing holding it back starts limit recovery, sweeps and wakes.
   if not live:raise AssertionError('Native work is not idle')
  if self.scenario in {'postrestart-active','restart-failed'}:raise AssertionError('Exact snapshot rejects active or mismatched runtime')
  after=copy.deepcopy(self.before);after['servicePid']=101;after['archiveSha256']=self.sha;after['artifactSourceCommit']=self.incoming_source
  after['processQuiescence']={'root':{'pid':101,'uid':501},'treeSha256':'new-tree'}
  after['rows']=copy.deepcopy(self.rows);after['observedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
  # These are actual temp pointer bytes, not the updater's expected hash constants.
  after['fileHashes'].update({'launcher':update.digest((self.own/'launch.sh').read_bytes()),
    'wrapper':update.digest(self.wrapper.read_bytes()),'installation':update.digest((self.own/'installation.json').read_bytes())})
  if self.after_mutation:self.after_mutation(after)
  return after
 def rows_snapshot(self,state):
  if self.scenario=='pre-restart-active':raise AssertionError('Native work appeared before restart')
  if self.scenario=='pre-restart-heartbeat':self.on_restart()
  return copy.deepcopy(self.rows)
 def snapshot_with_auth(self,identity):
  public=self.snapshot(identity)
  self.auth_snapshot_phases.append(self.restarted)
  return public,auth_heartbeat.read_auth_sessions(self.own/'userdata',public['rows'])
 def snapshot_since(self,identity,expected_rows,include_auth=False,widen_from=None):
  if self.real_db:
   public=self.snapshot(identity)
   if self.capture_database:
    public['rows'],auth,carried,public['databaseCapture']=update._read_state(self.own/'userdata',include_auth,expected_rows,True,widen_from)
   else:
    public['rows'],auth,carried=update._rows_snapshot(self.own/'userdata',include_auth,expected_rows)
   if include_auth:self.auth_snapshot_phases.append(self.restarted)
   return public,auth,carried
  public,auth=self.snapshot_with_auth(identity) if include_auth else (self.snapshot(identity),None)
  return public,auth,None
 def rows_since(self,state,expected_rows):
  if self.real_db:return REAL_ROWS_SINCE(state,expected_rows)
  return self.rows_snapshot(state),None
 def transport(self,command,**kwargs):
  if command[0]=='/usr/bin/python3':
   self.stage_timeouts.append(kwargs['timeout']);stage=pathlib.Path(kwargs['env']['HOME'])/'.specwithcode/install/releases'/self.sha[:20];stage.mkdir(parents=True)
   (stage/'bin.mjs').write_bytes(b'new-owned-code')
   manifest={'product':'SpecWeave Studio','version':self.incoming_version,'sourceCommit':self.incoming_source,'files':[{'path':'bin.mjs','type':'file','sha256':update.digest(b'new-owned-code')}]}
   if self.incoming_version != '0.1.0':
    package=json.dumps({'name':'specweave-studio','version':self.incoming_version}).encode();(stage/'package.json').write_bytes(package)
    manifest.update(schemaVersion=1,lockSha256='b'*64,runtime='Node22.20.0',noAuthOrUserStores=True)
    manifest['files'].append({'path':'package.json','type':'file','sha256':update.digest(package)})
   (stage/'studio-manifest.json').write_text(json.dumps(manifest))
   if self.on_stage:self.on_stage()
   return json.dumps({'release':str(stage)})
  if command[:2]==['/bin/launchctl','print']:
   if not self.loaded:raise AssertionError('Owned operation failed; arbitrary command output withheld')
   return 'path = '+str(self.plist)+'\npid = '+str(101 if self.restarted else 100)+'\n'
  if command[:2]==['/bin/launchctl','kickstart']:
   self.restart_calls.append(command)
   if self.scenario=='restart-failed':raise AssertionError('Owned transport rejected restart')
   self.restarted=True;(self.own/'userdata/server-runtime.json').write_text(json.dumps({'pid':101,'host':'127.0.0.1','port':8319}))
   if self.on_restart and len(self.restart_calls)==1:self.on_restart()
   return b''
  if command[0]=='/bin/ps':return self.node+' '+self.oldrelease+'/bin.mjs'
  if command[:2]==['/bin/launchctl','bootout']:
   self.launchd.append(command[1]);self.loaded=False;return b''
  if command[:2]==['/bin/launchctl','bootstrap']:
   self.launchd.append(command[1])
   if not self.restarted and self.sha[:20] in (self.own/'launch.sh').read_text():
    # The update's own restart: the job is loaded again with the launcher naming the new release.
    self.restart_calls.append(command)
    if self.scenario=='restart-failed':raise AssertionError('Owned transport rejected restart')
    self.restarted=True;(self.own/'userdata/server-runtime.json').write_text(json.dumps({'pid':101,'host':'127.0.0.1','port':8319}))
    if self.on_restart and len(self.restart_calls)==1:self.on_restart()
   self.loaded=True;return b''
  self.fail('Unexpected transport command')
 def backup_state(self,own,commit):
  self.assertFalse(self.restarted,'State must be copied before the new release starts')
  self.assertFalse(self.loaded,'State must be copied while the old service is stopped')
  backup=self.home/'state-backup.sqlite';backup.write_bytes(b'pre-update-state');self.backups.append(commit);return backup
 def service_answers(self,identity,old_pid,archive_sha,source_commit):
  self.answers.append(self.clock[0])
  if not (self.restarted and self.loaded):raise AssertionError('The service has not restarted yet')
  return 101
 def snapshot_reusing(self,identity,earlier,carried):
  # The service, file and process checks of a snapshot, with the rows of the read the watermark kept.
  self.reused.append(self.restarted);public=self.snapshot(identity);public['rows']=copy.deepcopy(earlier['rows'])
  if 'databaseCapture' in earlier:public['databaseCapture']=earlier['databaseCapture']
  return public
 def restore_state(self,backup,own):
  if self.scenario=='restore-failed':raise OSError('restore failed')
  self.restores.append(backup.read_bytes())
 def wait_for_stopped(self,pid,*,port=8319):self.stops.append(pid)
 def execute(self,allow_existing_browser_heartbeat=False,allow_project_migrations=False):
  self.stdout=io.StringIO()
  with patch.object(update,'current_owner',return_value={'home':self.home}),patch.object(update,'backup_state_clone',side_effect=lambda own,commit:(self.backup_state(own,commit),'clone')),patch.object(update,'service_answers',side_effect=lambda *args:self.service_answers(*args)),patch.object(update,'snapshot_reusing',side_effect=lambda *args:self.snapshot_reusing(*args)),self.watermark_patch(),patch.object(update,'restore_state',side_effect=self.restore_state),patch.object(update,'wait_for_stopped',side_effect=self.wait_for_stopped),patch.object(pathlib.Path,'home',return_value=self.home),patch.object(update,'snapshot',side_effect=self.snapshot),patch.object(update,'snapshot_with_auth',side_effect=self.snapshot_with_auth),patch.object(update,'snapshot_since',side_effect=self.snapshot_since),patch.object(update,'rows_snapshot',side_effect=self.rows_snapshot),patch.object(update,'rows_since',side_effect=self.rows_since),patch.object(update,'run',side_effect=self.transport),patch.object(update,'listeners',return_value=[100]),patch.object(update,'assert_quiescence',side_effect=self.quiescence_guard),patch.object(update.time,'sleep',side_effect=lambda seconds:self.clock.__setitem__(0,self.clock[0]+seconds)),patch.object(update.time,'monotonic',side_effect=lambda:self.clock[0]),contextlib.redirect_stdout(self.stdout):
   update.apply('m4',self.before,self.archive,self.sha,self.output,allow_existing_browser_heartbeat=allow_existing_browser_heartbeat,allow_project_migrations=allow_project_migrations)
 def watermark_patch(self):
  # Only a real database can show a change: with fixture rows the watermark never lets a read stand.
  return contextlib.nullcontext() if self.real_db else patch.object(update.read_watermark.Watermark,'take',return_value=None)
 def quiescence_guard(self,expected,node,argv,report=None):
  self.assertEqual(node,self.node);self.assertEqual(argv,['/usr/bin/caffeinate','-s',str(self.own/'launch.sh')])
  self.quiescence_checks.append(copy.deepcopy(expected))
  self.assertEqual(expected['root']['pid'],101 if self.restarted else 100)
  if self.scenario=='pre-restart-child' or (self.scenario=='rollback-child' and self.restarted):
   raise AssertionError('Unknown service descendant appeared')
  if self.scenario=='pre-restart-ps-timeout':
   import subprocess;raise subprocess.TimeoutExpired(['/bin/ps'],30)
  if self.scenario=='server-browser-stop-fails' and not self.restarted:
   if report is not None:report.update(serverBrowser='stopping',signals=[{'pid':300,'startedAt':'Thu Oct 8 13:26:00 2026','signal':'SIGTERM'}])
   raise AssertionError('Studio server browser did not stop')
  if self.scenario=='server-browser' and not self.restarted:
   return {'serverBrowser':'stopped','signal':'SIGTERM','browserCount':1,'processCount':4,'browsers':[{'pid':300}],'stoppedInSeconds':0.5}
  return None
 def race_after_alias_check(self,appear):
  # The alias is checked, then something else takes the name before the write.
  real=update.cli_alias_state;calls=[]
  def checked_then_raced(alias,owned):
   state=real(alias,owned)
   if not calls:calls.append(state[0]);appear()
   return state
  return patch.object(update,'cli_alias_state',side_effect=checked_then_raced)
 def daemon_band_service(self,refuse_rewritten=False):
  # A real LaunchAgent as install.py wrote it before ProcessType: launchd runs it as a throttled daemon.
  import plistlib
  self.plist.write_bytes(plistlib.dumps({'Label':'com.specweave.studio.m4','ProgramArguments':['/usr/bin/caffeinate','-s',str(self.own/'launch.sh')],'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':10}))
  self.plist.chmod(0o644);original=self.plist.read_bytes();self.before['fileHashes']['plist']=update.digest(original)
  self.after_mutation=lambda after:after['fileHashes'].update(plist=update.digest(self.plist.read_bytes()))
  served=self.transport;loaded=[]
  def transport(command,**kwargs):
   if command[:2]==['/bin/launchctl','bootstrap'] and not self.restarted:
    loaded.append(plistlib.loads(self.plist.read_bytes()))
    if refuse_rewritten and len(loaded)==1:raise AssertionError('Owned operation failed; arbitrary command output withheld')
    self.restart_calls.append(command);self.restarted=True
    (self.own/'userdata/server-runtime.json').write_text(json.dumps({'pid':101,'host':'127.0.0.1','port':8319}))
   return served(command,**kwargs)
  self.transport=transport
  return original,loaded
 def reject_wrong_target(self,field):
  def change(after):
   if field in {'archiveSha256','artifactSourceCommit'}:after[field]='another-owned-release'
   else:after['fileHashes'][field]=update.digest(b'another-pointer')
  self.after_mutation=change
  with self.assertRaises(AssertionError):self.execute()
  result=json.loads(self.output.read_text());self.assertEqual(result['result'],'update-failed')
  self.assertTrue(result['error'].startswith('AssertionError: Updated'),result['error'])
 def record_pre_restart_steps(self):
  # Which pre-restart step ran when (fake monotonic time), in order.
  steps=[];real_gate=update.write_install_gate;real_rows=self.rows_since;real_backup=self.backup_state;real_run=self.transport
  def gate(own,home):steps.append(('gate',self.clock[0]));real_gate(own,home)
  def rows(state,expected_rows):steps.append(('rows',self.clock[0]));return real_rows(state,expected_rows)
  def backup(own,commit):steps.append(('backup',self.clock[0]));return real_backup(own,commit)
  def transport(command,**kwargs):
   if command[:2] in (['/bin/launchctl','bootout'],['/bin/launchctl','bootstrap']):steps.append((command[1],self.clock[0]))
   return real_run(command,**kwargs)
  self.rows_since=rows;self.backup_state=backup;self.transport=transport
  return steps,patch.object(update,'write_install_gate',side_effect=gate)
 def failing_copy(self,error):
  def copy_fails(own,commit):
   self.assertFalse(self.loaded);self.backups.append(commit);raise error
  self.backup_state=copy_fails
 def prepare_heartbeat(self):
  state=self.own/'userdata';db=sqlite3.connect(state/'statev2.sqlite')
  db.execute('CREATE TABLE auth_sessions(session_id TEXT PRIMARY KEY,method TEXT,client_surface TEXT,issued_at TEXT,expires_at TEXT,last_connected_at TEXT,revoked_at TEXT,credential BLOB)')
  now=datetime.datetime.now(datetime.timezone.utc)
  values=('private-session','browser-session-cookie','web',(now-datetime.timedelta(days=1)).isoformat(),(now+datetime.timedelta(days=1)).isoformat(),(now-datetime.timedelta(hours=1)).isoformat(),None,b'private-credential')
  db.execute('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?)',values);db.commit();db.close()
  self.rows={'nativeWorkIdle':True,'projectIds':['original-project'],'threadIds':['original-thread'],
    'counts':{'auth_sessions':1,'history':1},'hashes':{'auth_sessions':auth_heartbeat.rows_hash([list(values)]),'history':'a'*64}}
  self.before['rows']=copy.deepcopy(self.rows)
  def advance():
   db=sqlite3.connect(state/'statev2.sqlite');db.execute('UPDATE auth_sessions SET last_connected_at=?',(datetime.datetime.now(datetime.timezone.utc).isoformat(),));db.commit()
   self.rows=copy.deepcopy(self.rows);self.rows['hashes']['auth_sessions']=auth_heartbeat.rows_hash([list(row) for row in db.execute('SELECT * FROM auth_sessions')]);db.close()
  self.on_restart=advance
 def reconnect_before_restart(self,method,surface,**execute):
  # A second session reconnects to the old service while the gate settles, after the snapshot.
  self.prepare_heartbeat();self.on_restart=lambda:None
  now=datetime.datetime.now(datetime.timezone.utc);db=sqlite3.connect(self.own/'userdata'/'statev2.sqlite')
  db.execute('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?)',('second-session',method,surface,(now-datetime.timedelta(days=1)).isoformat(),
             (now+datetime.timedelta(days=1)).isoformat(),(now-datetime.timedelta(hours=2)).isoformat(),None,b'second-credential'));db.commit()
  def measure():
   self.rows=copy.deepcopy(self.rows);self.rows['counts']['auth_sessions']=2;self.rows[update.AUTH_INVARIANT_KEY]='i'*64
   self.rows['hashes']['auth_sessions']=auth_heartbeat.rows_hash([list(row) for row in db.execute('SELECT * FROM auth_sessions')])
  measure();self.before['rows']=copy.deepcopy(self.rows)
  real=update.write_install_gate
  def gate_then_reconnect(own,home):
   real(own,home);db.execute("UPDATE auth_sessions SET last_connected_at=? WHERE session_id='second-session'",(datetime.datetime.now(datetime.timezone.utc).isoformat(),))
   db.commit();measure()
  try:
   with patch.object(update,'write_install_gate',side_effect=gate_then_reconnect):self.execute(**execute)
  finally:db.close()
 def assert_refused_before_restart(self,error):
  self.assertEqual(self.restart_calls,[]);self.assertEqual(self.backups,[])
  self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
  result=json.loads(self.output.read_text())
  self.assertEqual((result['phase'],result['pointers']),('pointers-written','previous-release'))
  self.assertIn(error,result['error'])  # A refusal the update agent retries (RETRYABLE_REFUSALS).
  for key in ('restartStartedAt','stateBackup','rollbackError'):self.assertNotIn(key,result)
  self.assertNotIn('second-session',self.output.read_text());self.assertNotIn('second-credential',self.output.read_text())
 def reject_heartbeat_metadata_change(self,field):
  self.prepare_heartbeat()
  def change(after):
   if field in {'settings','environment','plist'}:after['fileHashes'][field]='changed'
   elif field=='nativeWorkIdle':after['rows'][field]=False
   else:after[field]='changed'
  self.after_mutation=change
  with self.assertRaises(AssertionError):self.execute(True)
  self.assertEqual(json.loads(self.output.read_text())['result'],'update-failed')
 def with_settings(self,old_value,new_value):
  """Real settings.json bytes before the restart and after the new release started on them."""
  old,new=[(json.dumps(value,indent=2)+'\n').encode() for value in (old_value,new_value)]
  self.before['fileHashes']['settings']=update.digest(old);self.before['settingsProof']=update.settings_continuity.settings_proof(old)
  def change(after):
   after['fileHashes']['settings']=update.digest(new);after['settingsProof']=update.settings_continuity.settings_proof(new)
  self.after_mutation=change
 FLEET_SETTINGS={'defaultRuntimeMode':'full-access','projectSettingsFolded':True,'branchNamePrefix':'prefix-SHOULD-not-leak',
  'projectSettingsOverrides':{'p1':{'defaultRuntimeMode':'approval-required','providerLimitAction':'switch'},'p2':{'defaultRuntimeMode':'full-access'}}}
 def migrate(self,change):
  self.prepare_heartbeat();self.on_restart=lambda:None
  self.rows['counts'].update(projection_projects=1,orchestration_v2_events=3)
  self.rows['hashes'].update(projection_projects='p1',orchestration_v2_events='e1')
  self.before['rows']=copy.deepcopy(self.rows)
  def mutate(after):
   after['rows']['counts'].update(project_memory=0);after['rows']['hashes'].update(project_memory='new',projection_projects='p2')
   change(after['rows'])
  self.after_mutation=mutate
 def use_waiting_state(self):
  self.real_db=True;state=self.own/'userdata';waiting_fixture(state)
  self.before['rows']=REAL_ROWS_SNAPSHOT(state);return state
 def events(self,state):
  db=sqlite3.connect(state/'statev2.sqlite')
  try:return [row[0] for row in db.execute("SELECT event_id FROM orchestration_events WHERE event_id LIKE 'limit-check-%' ORDER BY sequence")]
  finally:db.close()
 def assert_waiting_thread_update_verified(self,**flags):
  state=self.use_waiting_state()
  self.on_stage=lambda:waiting_check(state,'staging')
  self.on_restart=lambda:waiting_check(state,'after-restart')
  self.execute(**flags);result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(len(self.restart_calls),1);self.assertEqual(self.launchd,RESTART)
  # Counted from the apply's own first read: one check while staging, one after restart.
  self.assertEqual(result['appendedLogRows'],{'orchestration_events':2,'orchestration_command_receipts':2})
  self.assertEqual(self.events(state),['limit-check-staging','limit-check-after-restart'])
  self.assertEqual(result['after']['rows']['counts']['orchestration_events'],self.before['rows']['counts']['orchestration_events']+2)
  return result
 def verify_migration_with_heartbeat(self,session_count):
  self.prepare_heartbeat();advance=self.on_restart
  if session_count==2:
   db=sqlite3.connect(self.own/'userdata/statev2.sqlite')
   db.execute("INSERT INTO auth_sessions SELECT 'second-session',method,client_surface,issued_at,expires_at,last_connected_at,revoked_at,credential FROM auth_sessions");db.commit()
   self.rows['counts']['auth_sessions']=2
   self.rows['hashes']['auth_sessions']=auth_heartbeat.rows_hash([list(row) for row in db.execute('SELECT * FROM auth_sessions')]);db.close()
  self.rows['counts']['projection_projects']=1;self.rows['hashes']['projection_projects']='before-projection'
  self.before['rows']=copy.deepcopy(self.rows)
  def restart():
   advance();self.rows['hashes']['projection_projects']='rebuilt-projection'
  self.on_restart=restart
  self.execute(allow_project_migrations=True,allow_existing_browser_heartbeat=True)
  result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['rowPreservation'],'verified-migration')
  self.assertEqual(result['authHeartbeatWitness']['changedRows'],session_count)
  self.assertEqual(result['after']['rows'],self.rows)
  original_receipt=copy.deepcopy(result)
  current=auth_heartbeat.read_auth_sessions(self.own/'userdata',result['after']['rows'])
  witness=result['authHeartbeatWitness']
  self.assertEqual(update.verify_migration_heartbeat_witness(result['before']['rows'],result['after']['rows'],witness,current,identity='m4'),witness)
  self.assertEqual(result,original_receipt)
  tampered=copy.deepcopy(current);credential=tampered['columns'].index('credential')
  tampered['rows'][0][credential]=tampered['rows'][0][credential].hex()
  self.assertEqual(auth_heartbeat.rows_hash(current['rows']),auth_heartbeat.rows_hash(tampered['rows']))
  with self.assertRaisesRegex(AssertionError,'types changed'):
   update.verify_migration_heartbeat_witness(result['before']['rows'],result['after']['rows'],witness,tampered,identity='m4')
  for field in ['beforeSha256','afterSha256']:
   forged=copy.deepcopy(witness);forged['migrationTypedAuth'][field]='forged'
   with self.subTest(typedField=field),self.assertRaises(AssertionError):
    update.verify_migration_heartbeat_witness(result['before']['rows'],result['after']['rows'],forged,current,identity='m4')
  missing={key:value for key,value in witness.items() if key!='migrationTypedAuth'}
  with self.assertRaisesRegex(AssertionError,'typed auth commitments'):
   update.verify_migration_heartbeat_witness(result['before']['rows'],result['after']['rows'],missing,current,identity='m4')
  for field in ['history','auth_sessions']:
   altered=copy.deepcopy(result['after']['rows']);altered['hashes'][field]='forged'
   with self.subTest(field=field),self.assertRaises(AssertionError):
    update.verify_migration_heartbeat_witness(result['before']['rows'],altered,witness,current,identity='m4')
  for forged in [{**witness,'changedRows':3},{**witness,'authSchemaSha256':'forged'}]:
   with self.assertRaises(AssertionError):
    update.verify_migration_heartbeat_witness(result['before']['rows'],result['after']['rows'],forged,current,identity='m4')
  self.assertNotEqual(result['before']['rows']['hashes']['auth_sessions'],result['after']['rows']['hashes']['auth_sessions'])
  self.assertNotIn('private-credential',self.output.read_text()+self.stdout.getvalue())
 def verify_waiting_migration_heartbeat(self,session_count):
  state=self.use_waiting_state()
  mutate_state(state,'DROP TABLE auth_sessions')
  self.prepare_heartbeat();advance=self.on_restart
  if session_count==2:
   mutate_state(state,"INSERT INTO auth_sessions SELECT 'second-session',method,client_surface,issued_at,expires_at,last_connected_at,revoked_at,credential FROM auth_sessions")
  self.before['rows']=REAL_ROWS_SNAPSHOT(state)
  self.on_stage=lambda:waiting_check(state,'staging')
  def restart():
   advance();waiting_check(state,'after-restart')
   mutate_state(state,'CREATE TABLE project_memory(id TEXT)',"UPDATE projection_projects SET title='rebuilt'")
  self.on_restart=restart
  self.execute(allow_project_migrations=True,allow_existing_browser_heartbeat=True)
  result=json.loads(self.output.read_text());saved=copy.deepcopy(result)
  before,after,witness=result['before']['rows'],result['after']['rows'],result['authHeartbeatWitness']
  current=auth_heartbeat.read_auth_sessions(state,after)
  self.assertEqual(result['phase'],'verified');self.assertEqual(witness['changedRows'],session_count)
  self.assertEqual(result['appendedLogRows'],{'orchestration_events':2,'orchestration_command_receipts':2})
  self.assertEqual(result['rowPreservation'],'verified-migration')
  self.assertEqual(self.auth_snapshot_phases,[False,True])
  self.assertEqual(update.verify_migration_heartbeat_witness(before,after,witness,current,identity='m4',state=state),witness)
  forged_after=copy.deepcopy(after);forged_after['hashes']['orchestration_events']='f'*64
  with self.assertRaisesRegex(AssertionError,'differs from the migration after-snapshot'):
   update.verify_migration_heartbeat_witness(before,forged_after,witness,current,identity='m4',state=state)
  # Counts in the receipt alone never authorize changed event/receipt hashes.
  with self.assertRaisesRegex(AssertionError,'History'):
   update.verify_migration_heartbeat_witness(before,after,witness,current,identity='m4')
  forged=copy.deepcopy(witness);forged['migrationTypedAuth']['beforeSha256']='forged'
  with self.assertRaisesRegex(AssertionError,'Reconstructed'):
   update.verify_migration_heartbeat_witness(before,after,forged,current,identity='m4',state=state)
  wrong=copy.deepcopy(current);wrong['columns'][0]='wrong-column'
  with self.assertRaisesRegex(AssertionError,'private auth differs'):
   update.verify_migration_heartbeat_witness(before,after,witness,wrong,identity='m4',state=state)
  self.assertEqual(result,saved)
  self.assertNotIn('private-credential',self.output.read_text()+self.stdout.getvalue())
  self.assertNotIn('synthetic-private',self.output.read_text()+self.stdout.getvalue())
  for sql in ["UPDATE orchestration_events SET payload_json='edited' WHERE sequence=1",
              "DELETE FROM orchestration_command_receipts WHERE rowid=1"]:
   mutate_state(state,sql)
   with self.assertRaisesRegex(AssertionError,'differs from the migration after-snapshot'):
    update.verify_migration_heartbeat_witness(before,after,witness,current,identity='m4',state=state)
   # Even a forged receipt matching the changed database cannot invent a preserved prefix.
   changed=REAL_ROWS_SNAPSHOT(state)
   with self.assertRaisesRegex(AssertionError,'History'):
    update.verify_migration_heartbeat_witness(before,changed,witness,current,identity='m4',state=state)
  mutate_state(state,"UPDATE auth_sessions SET credential=lower(hex(credential))")
  changed=REAL_ROWS_SNAPSHOT(state);changed_auth=auth_heartbeat.read_auth_sessions(state,changed)
  with self.assertRaisesRegex(AssertionError,'types changed'):
   update.verify_migration_heartbeat_witness(before,changed,witness,changed_auth,identity='m4',state=state)
 def reject_migration_auth_change(self,sql,parameters=()):
  self.migrate(lambda rows:None)
  def change():
   db=sqlite3.connect(self.own/'userdata/statev2.sqlite');db.execute(sql,parameters);db.commit()
   rows=[list(row) for row in db.execute('SELECT * FROM auth_sessions')];db.close()
   self.rows['counts']['auth_sessions']=len(rows);self.rows['hashes']['auth_sessions']=auth_heartbeat.rows_hash(rows)
  self.on_restart=change
  with self.assertRaises(AssertionError):self.execute(allow_project_migrations=True,allow_existing_browser_heartbeat=True)
  result=json.loads(self.output.read_text());self.assertEqual(result['result'],'update-failed')
  self.assertNotIn('authHeartbeatWitness',result)
  self.assertNotIn('private-credential',self.output.read_text()+self.stdout.getvalue())
 def counted_full_reads(self):
  # Every full read of the database (_read_state), with the phase it ran in.
  real=update._read_state;reads=[]
  def counted(*args,**kwargs):reads.append(self.restarted);return real(*args,**kwargs)
  return reads,patch.object(update,'_read_state',side_effect=counted)
 def use_captured_waiting_state(self,*prepare):
  """The real waiting-thread database, with the complete typed capture production snapshots carry."""
  self.real_db=True;self.capture_database=True;state=self.own/'userdata';waiting_fixture(state)
  if prepare:mutate_state(state,*prepare)
  self.before['rows'],_,self.before['databaseCapture']=update._rows_snapshot(state,False,include_database=True)
  return state
 def migrate_real(self,*statements,check=True):
  """The new release appends a usage-limit check, adds a table, rebuilds a projection, then runs `statements`."""
  state=self.own/'userdata'
  def restart():
   if check:waiting_check(state,'after-restart')
   mutate_state(state,'CREATE TABLE project_memory(id TEXT)',"UPDATE projection_projects SET title='rebuilt'",*statements)
  self.on_restart=restart
 def reject_real_migration(self,*statements,pattern='types changed during migration',**flags):
  self.migrate_real(*statements)
  with self.assertRaisesRegex(AssertionError,pattern):self.execute(allow_project_migrations=True,**flags)
  result=json.loads(self.output.read_text())
  self.assertEqual(result['result'],'update-failed');self.assertEqual(result['rollback'],'restored-runtime-pointers-and-state')
  self.assertEqual(self.restores,[b'pre-update-state']);self.assertNotIn('synthetic-private',self.output.read_text()+self.stdout.getvalue())
  return result
 def use_captured_heartbeat_state(self):
  """The captured waiting-thread database with a real browser session, as on M4."""
  self.real_db=True;self.capture_database=True;state=self.own/'userdata';waiting_fixture(state)
  now=datetime.datetime.now(datetime.timezone.utc)
  db=sqlite3.connect(state/'statev2.sqlite')
  db.execute('DROP TABLE auth_sessions')
  db.execute('CREATE TABLE auth_sessions(session_id TEXT PRIMARY KEY,method TEXT,client_surface TEXT,issued_at TEXT,expires_at TEXT,last_connected_at TEXT,revoked_at TEXT,credential BLOB)')
  db.execute('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?)',('private-session','browser-session-cookie','web',(now-datetime.timedelta(days=1)).isoformat(),
             (now+datetime.timedelta(days=1)).isoformat(),(now-datetime.timedelta(hours=1)).isoformat(),None,b'private-credential'))
  db.execute("INSERT INTO projection_state VALUES ('projects',4,'2026-10-11T03:00:00Z')")
  db.commit();db.close()
  self.before['rows'],_,self.before['databaseCapture']=update._rows_snapshot(state,False,include_database=True)
  return state
 def restart_with_project_save_and_heartbeat(self,state,*statements):
  """What 0.2.12's first start writes on M4: ProjectSettingsNormalizer saves a project's
  model (event, receipt, projection row, cursor) while the open browser tab reconnects."""
  def restart():
   db=sqlite3.connect(state/'statev2.sqlite')
   cursor=db.execute("INSERT INTO orchestration_events(event_id,stream_id,event_type,payload_json) VALUES ('save-p1','p1','project.meta-updated','{}')")
   db.execute("INSERT INTO orchestration_command_receipts VALUES ('project-settings-normalize:v1:p1:1','p1',?,'accepted')",(cursor.lastrowid,))
   db.execute("UPDATE projection_projects SET title='Project (model saved)' WHERE project_id='p1'")
   db.execute("UPDATE projection_state SET last_applied_sequence=?,updated_at='2026-10-11T04:00:00Z' WHERE projector='projects'",(cursor.lastrowid,))
   db.execute('UPDATE auth_sessions SET last_connected_at=?',(datetime.datetime.now(datetime.timezone.utc).isoformat(),))
   for statement in statements:db.execute(statement)
   db.commit();db.close()
  self.on_restart=restart
 def reject_save_and_heartbeat(self,*statements,pattern='',**flags):
  state=self.use_captured_heartbeat_state();self.restart_with_project_save_and_heartbeat(state,*statements)
  with self.assertRaisesRegex(AssertionError,pattern):self.execute(**flags)
  result=json.loads(self.output.read_text())
  self.assertEqual(result['result'],'update-failed');self.assertEqual(result['rollback'],'restored-runtime-pointers-and-state')
  self.assertNotIn('authHeartbeatWitness',result);self.assertNotIn('private-credential',self.output.read_text()+self.stdout.getvalue())
 def captured_schedule_state(self):
  return self.use_captured_waiting_state('DROP TABLE scheduled_tasks','CREATE TABLE scheduled_tasks(\n  id TEXT PRIMARY KEY,\n  title TEXT NOT NULL,\n  enabled INTEGER NOT NULL DEFAULT 1,\n  secret\n)',
                                         "INSERT INTO scheduled_tasks VALUES ('task-1','Nightly',1,X'7365637265740001'),('task-2','Weekly',0,NULL)")
 def migrate_with_desktop_reconnect(self,*extra):
  """M4: the browser cookie session plus an existing desktop-app session; a migration rebuilds a
  projection while the desktop app reconnects, and `extra` SQL runs on auth at the same time."""
  self.prepare_heartbeat();state=self.own/'userdata'
  db=sqlite3.connect(state/'statev2.sqlite')
  db.execute("INSERT INTO auth_sessions SELECT 'private-desktop','bearer-access-token','desktop',issued_at,expires_at,last_connected_at,revoked_at,X'0102' FROM auth_sessions");db.commit()
  rows=[list(row) for row in db.execute('SELECT * FROM auth_sessions')];db.close()
  self.rows['counts'].update(auth_sessions=2,projection_projects=1)
  self.rows['hashes'].update(auth_sessions=auth_heartbeat.rows_hash(rows),projection_projects='before-projection')
  self.before['rows']=copy.deepcopy(self.rows)
  def restart():
   db=sqlite3.connect(state/'statev2.sqlite')
   db.execute("UPDATE auth_sessions SET last_connected_at=? WHERE session_id='private-desktop'",(datetime.datetime.now(datetime.timezone.utc).isoformat(),))
   for sql in extra:db.execute(sql)
   db.commit();rows=[list(row) for row in db.execute('SELECT * FROM auth_sessions')];db.close()
   self.rows=copy.deepcopy(self.rows)
   self.rows['hashes'].update(auth_sessions=auth_heartbeat.rows_hash(rows),projection_projects='rebuilt-projection')
  self.on_restart=restart
class StateSafety(unittest.TestCase):
 def rows(self,**extra):
  base={'nativeWorkIdle':True,'projectIds':['p'],'threadIds':['t'],'counts':{'projection_projects':1,'orchestration_v2_events':2,'auth_sessions':1,'scheduled_tasks':0},
        'hashes':{'projection_projects':'a','orchestration_v2_events':'b','auth_sessions':'c','scheduled_tasks':'d'}}
  for key,value in extra.items():base[key].update(value) if isinstance(value,dict) else base.__setitem__(key,value)
  return base
 def test_migration_accepts_new_tables_rebuilt_projections_and_unchanged_auth(self):
  update.assert_migration_preserved(self.rows(),self.rows(counts={'project_threads':4},hashes={'project_threads':'n','projection_projects':'z'}))
 def test_migration_rejects_same_count_auth_replacement_and_unproven_growth(self):
  for after in [self.rows(hashes={'auth_sessions':'replaced'}),
                self.rows(counts={'auth_sessions':2},hashes={'auth_sessions':'grown'})]:
   with self.subTest(after=after),self.assertRaises(AssertionError):
    update.assert_migration_preserved(self.rows(),after)
 def test_migration_rejects_lost_projects_threads_tables_or_rows(self):
  for after in [self.rows(projectIds=[]),self.rows(threadIds=[]),self.rows(counts={'projection_projects':0}),self.rows(counts={'auth_sessions':0}),
                self.rows(hashes={'scheduled_tasks':'changed'}),self.rows(nativeWorkIdle=False)]:
   with self.assertRaises(AssertionError):update.assert_migration_preserved(self.rows(),after)
  missing=self.rows();del missing['counts']['scheduled_tasks'];del missing['hashes']['scheduled_tasks']
  with self.assertRaises(AssertionError):update.assert_migration_preserved(self.rows(),missing)
 def test_backup_and_restore_round_trip_a_real_database(self):
  with tempfile.TemporaryDirectory() as temporary:
   home=pathlib.Path(temporary).resolve();own=home/'.specwithcode/m4';(own/'userdata').mkdir(parents=True)
   db=sqlite3.connect(str(own/'userdata/statev2.sqlite'));db.execute('PRAGMA journal_mode=WAL');db.execute('CREATE TABLE t(v)');db.execute("INSERT INTO t VALUES ('before')");db.commit()
   with patch.object(pathlib.Path,'home',return_value=home):backup=update.backup_state(own,'c8aeea9b0123456789')
   self.assertRegex(str(backup.parent.name),r'^pre-c8aeea9b0123-\d{8}T\d{6}Z-[a-f0-9]{32}$');self.assertEqual(backup.stat().st_mode & 0o777,0o600)
   db.execute('CREATE TABLE project_memory(v)');db.execute("UPDATE t SET v='migrated'");db.commit();db.close()
   update.restore_state(backup,own)
   check=sqlite3.connect(str(own/'userdata/statev2.sqlite'))
   self.assertEqual(check.execute('SELECT v FROM t').fetchall(),[('before',)])
   self.assertEqual(check.execute("SELECT name FROM sqlite_master WHERE name='project_memory'").fetchall(),[]);check.close()
   self.assertEqual([p.name for p in (own/'userdata').iterdir() if 'owned-restore' in p.name],[])
 def test_backup_and_restore_carry_the_exact_settings_file(self):
  # A release that rewrote settings.json on start must not leave the rewrite to the old release.
  with tempfile.TemporaryDirectory() as temporary:
   home=pathlib.Path(temporary).resolve();own=home/'.specwithcode/m4';(own/'userdata').mkdir(parents=True)
   db=sqlite3.connect(str(own/'userdata/statev2.sqlite'));db.execute('CREATE TABLE t(v)');db.commit();db.close()
   settings=own/'userdata/settings.json';original=b'{\n  "branchNamePrefix": "anton"\n}\n';settings.write_bytes(original)
   with patch.object(pathlib.Path,'home',return_value=home):backup=update.backup_state(own,'c8aeea9b0123456789')
   saved=backup.parent/'settings.json'
   self.assertEqual(saved.read_bytes(),original);self.assertEqual(saved.stat().st_mode & 0o777,0o600)
   settings.write_bytes(b'{\n  "branchNamePrefix": "anton",\n  "projectSettingsSimplified": true\n}\n')
   update.restore_state(backup,own)
   self.assertEqual(settings.read_bytes(),original);self.assertEqual(settings.stat().st_mode & 0o777,0o600)
   self.assertEqual(sorted(p.name for p in (own/'userdata').iterdir()),['settings.json','statev2.sqlite'])
   before=settings.stat().st_mtime_ns;update.restore_state(backup,own)  # Unchanged settings are not rewritten.
   self.assertEqual(settings.stat().st_mtime_ns,before)
 def test_a_missing_settings_file_is_neither_backed_up_nor_created(self):
  with tempfile.TemporaryDirectory() as temporary:
   home=pathlib.Path(temporary).resolve();own=home/'.specwithcode/m4';(own/'userdata').mkdir(parents=True)
   db=sqlite3.connect(str(own/'userdata/statev2.sqlite'));db.execute('CREATE TABLE t(v)');db.commit();db.close()
   with patch.object(pathlib.Path,'home',return_value=home):backup=update.backup_state(own,'c8aeea9b0123456789')
   self.assertFalse((backup.parent/'settings.json').exists());update.restore_state(backup,own)
   self.assertFalse((own/'userdata/settings.json').exists())
class StoppedCopy(unittest.TestCase):
 """state_backup.clone_state: the copy taken while the old service is stopped."""
 def setUp(self):
  temporary=tempfile.TemporaryDirectory(prefix='studio-stopped-copy-');self.addCleanup(temporary.cleanup)
  self.home=pathlib.Path(temporary.name).resolve();self.own=self.home/'.specwithcode/m4';self.state=self.own/'userdata';self.state.mkdir(parents=True)
  home=patch.object(pathlib.Path,'home',return_value=self.home);home.start();self.addCleanup(home.stop)
  # A stopped service whose last commits are still in its log: -wal holds them, the database file does not.
  db=sqlite3.connect(str(self.state/'statev2.sqlite'));db.execute('PRAGMA journal_mode=WAL');db.execute('PRAGMA wal_autocheckpoint=0')
  db.execute('CREATE TABLE t(v)');db.executemany('INSERT INTO t VALUES (?)',[('row-%d'%i,) for i in range(200)]);db.commit()
  self.crashed=sqlite3.connect(str(self.state/'statev2.sqlite'));self.crashed.execute('SELECT count(*) FROM t').fetchall()  # Keeps -wal and -shm on disk.
  db.close();self.addCleanup(self.crashed.close)
  (self.state/'settings.json').write_bytes(b'{"branchNamePrefix":"anton"}\n')
  self.assertGreater((self.state/'statev2.sqlite-wal').stat().st_size,0)
 def rows(self,path):
  db=sqlite3.connect(str(path))
  try:return db.execute('SELECT v FROM t ORDER BY rowid').fetchall()
  finally:db.close()
 def assert_one_file_copy(self,backup):
  self.assertEqual(sorted(path.name for path in backup.parent.iterdir()),['settings.json','statev2.sqlite'])
  self.assertEqual(backup.stat().st_mode&0o777,0o600)
  self.assertEqual(self.rows(backup),[('row-%d'%i,) for i in range(200)])
  self.assertEqual((backup.parent/'settings.json').read_bytes(),b'{"branchNamePrefix":"anton"}\n')
 @unittest.skipUnless(update._clonefile() is not None,'clonefile(2) is macOS only')
 def test_a_clone_folds_the_log_into_one_file_that_restores_and_prunes_like_a_copy(self):
  with patch.object(update.shutil,'copyfile',side_effect=AssertionError('fell back to a byte copy')):
   backup,method=update.backup_state_clone(self.own,'c8aeea9b0123456789')
  self.assertEqual(method,'clone');self.assertRegex(backup.parent.name,r'^pre-c8aeea9b0123-\d{8}T\d{6}Z-[a-f0-9]{32}$')
  self.assert_one_file_copy(backup)
  # The live files are untouched by the copy.
  self.assertTrue((self.state/'statev2.sqlite-wal').stat().st_size>0)
  self.crashed.close();mutate_state(self.state,"UPDATE t SET v='migrated'")
  update.restore_state(backup,self.own);self.assertEqual(self.rows(self.state/'statev2.sqlite'),[('row-%d'%i,) for i in range(200)])
  os.utime(backup.parent,(time.time()-86400,)*2)
  self.assertEqual(release_retention.prune_state_backups(self.home,keep_newest=0),[backup.parent.name])
 def test_a_volume_that_cannot_clone_falls_back_to_the_sqlite_copy(self):
  import ctypes,errno
  for code in (errno.EXDEV,errno.ENOTSUP):
   with self.subTest(code=errno.errorcode[code]):
    calls=[]
    def unsupported(source,target,flags):calls.append(target);ctypes.set_errno(code);return -1
    with patch.object(update,'_clonefile',return_value=unsupported):
     backup,method=update.backup_state_clone(self.own,'c8aeea9b0123456789')
    self.assertEqual(method,'sqlite-backup');self.assertEqual(len(calls),1);self.assert_one_file_copy(backup)
    self.assertEqual(len(list(studio_paths.backups_root(self.home).iterdir())),1)
    shutil.rmtree(backup.parent)
 def test_no_clonefile_falls_back_to_the_sqlite_copy(self):
  with patch.object(update,'_clonefile',return_value=None):backup,method=update.backup_state_clone(self.own,'abc')
  self.assertEqual(method,'sqlite-backup');self.assert_one_file_copy(backup)
 def test_any_other_clone_failure_fails_and_leaves_no_copy(self):
  import ctypes,errno
  def full(source,target,flags):ctypes.set_errno(errno.ENOSPC);return -1
  with patch.object(update,'_clonefile',return_value=full),self.assertRaises(OSError) as caught:update.backup_state_clone(self.own,'abc')
  self.assertEqual(caught.exception.errno,errno.ENOSPC)
  self.assertEqual(list(studio_paths.backups_root(self.home).iterdir()),[])
 def test_clone_fallback_checks_full_space_before_copying(self):
  import ctypes,errno
  def unsupported(*args):ctypes.set_errno(errno.ENOTSUP);return -1
  with patch.object(update,'_clonefile',return_value=unsupported), \
       patch.object(state_backup,'assert_backup_space',side_effect=AssertionError('full copy cannot fit')) as space, \
       patch.object(state_backup,'backup_state') as copy:
   with self.assertRaisesRegex(AssertionError,'full copy cannot fit'):update.backup_state_clone(self.own,'abc')
  space.assert_called_once_with(self.own,self.home);copy.assert_not_called()
 def test_headroom_is_a_tenth_of_the_database_and_at_least_one_gib(self):
  (self.state/'statev2.sqlite').stat()
  # The fold writes every page of the log into the clone: the -wal counts in full.
  for size,log,free,ok in ((0,0,(1<<30)-1,False),(0,0,1<<30,True),(50<<30,0,(5<<30)-1,False),(50<<30,0,5<<30,True),
                           (8<<30,3<<30,((8<<30)//10+(3<<30))-1,False),(8<<30,3<<30,(8<<30)//10+(3<<30),True)):
   sizes={'statev2.sqlite':size,'statev2.sqlite-wal':log}
   with self.subTest(size=size,log=log,free=free),\
     patch.object(state_backup,'_database_bytes',side_effect=lambda own,names:sum(sizes[name] for name in names)),\
     patch.object(update.shutil,'disk_usage',return_value=DISK(1<<44,0,free)):
    if ok:update.assert_clone_headroom(self.own,self.home)
    else:self.assertRaises(AssertionError,update.assert_clone_headroom,self.own,self.home)
 def test_the_preflight_sizes_a_clone_by_its_headroom_and_only_a_copy_by_the_database(self):
  sizes={'statev2.sqlite':11<<30,'statev2.sqlite-wal':20<<20}
  with patch.object(state_backup,'_database_bytes',side_effect=lambda own,names=tuple(sizes):sum(sizes[name] for name in names)):
   self.assertEqual(state_backup.backup_space_needed(self.own,self.home,None),(state_backup.BACKUP_SPACE_MARGIN+(11<<30)+(20<<20),'copy'))
   def unsupported(source,target,flags):return -1
   self.assertEqual(state_backup.backup_space_needed(self.own,self.home,unsupported)[1],'copy')
   if update._clonefile() is not None:
    self.assertEqual(state_backup.backup_space_needed(self.own,self.home,update._clonefile()),
                     (state_backup.BACKUP_SPACE_MARGIN+(11<<30)//10+(20<<20),'clone'))
  self.assertEqual(list(self.home.rglob('.clone-probe-*')),[])
 def test_another_volume_is_never_counted_as_a_clone(self):
  real=os.stat
  def elsewhere(path,*args,**kwargs):
   info=real(path,*args,**kwargs)
   if str(path)==str(self.state):return os.stat_result((info.st_mode,info.st_ino,info.st_dev+1)+tuple(info)[3:])
   return info
  def clones(source,target,flags):raise AssertionError('probed another volume')
  with patch.object(state_backup.os,'stat',side_effect=elsewhere):self.assertFalse(state_backup.can_clone(self.own,self.home,clones))
# Reads a snapshot, a preflight refusal or a verified receipt with an installed update agent, in its
# own process (its modules share names with this folder's), the way that agent reads them.
AGENT_DRIVER="""
import json,os,pathlib,pwd,sys
agent_dir,home,mode,path=sys.argv[1:5]
sys.path.insert(0,agent_dir)
import installation_descriptor
account=pwd.getpwuid(os.getuid())
installation_descriptor.pwd.getpwuid=lambda uid:type('Account',(),{'pw_dir':home,'pw_name':account.pw_name})()
import update_agent,update_agent_recovery as recovery
agent=update_agent.Agent(pathlib.Path(home),'m4',True,lambda line:None)
if mode=='snapshot':print(json.dumps(agent.read_snapshot(pathlib.Path(path)) is not None))
elif mode=='verified':
 agent.inst={'label':'com.specweave.studio.m4','sourceCommit':json.loads((agent.own/'installation.json').read_text())['sourceCommit']}
 print(json.dumps(recovery.completion_proof(agent,path)))
elif mode=='retry':print(json.dumps(recovery.refused_before_restart(agent,pathlib.Path(path),'0.3.0')))
else:
 agent.inst=update_agent.load_installation(pathlib.Path(home),'m4')
 print(json.dumps(recovery.refusal_proof(agent,path,recovery.installation_fingerprint(agent)) is not None))
"""
# Each must read what update.py writes as it does: this folder's own agent, the 1.0.65 agent as
# released (git tag v1.0.65, byte for byte; installed on every Mac when this proof was written),
# and the agent installed on the Mac running the tests, when there is one.
AGENT_1_0_65=pathlib.Path(__file__).resolve().parent/'test-fixtures/agent-1.0.65'
INSTALLED_AGENT=pathlib.Path.home()/'.specwithcode/install/updater'
SNAPSHOT_KEYS={'schemaVersion','identity','uid','port','webSessionPolicy','serviceLabel','servicePid','archiveSha256',
               'artifactSourceCommit','fileHashes','settingsProof','rows','databaseCapture','otherListeners',
               'otherListenersOwned','cookieName','processQuiescence','observedAt'}
PREFLIGHT_KEYS={'identity','phase','result','error','pointers'}
VERIFIED_FLAGS=('preservedRowsAuthAndIdentity','originalServicesPreserved','onlyKnownOwnedServiceRestarted')
class OldAgentContract(unittest.TestCase):
 def agents(self):
  self.assertTrue((AGENT_1_0_65/'update_agent.py').is_file(),'The 1.0.65 agent fixture is missing')
  found=[pathlib.Path(__file__).resolve().parent,AGENT_1_0_65]
  if (INSTALLED_AGENT/'update_agent.py').is_file():found.append(INSTALLED_AGENT)
  return found
 def read_with(self,agent_dir,home,mode,path):
  import subprocess,sys
  with tempfile.TemporaryDirectory(prefix='studio-agent-driver-') as scripts:
   driver=pathlib.Path(scripts)/'driver.py';driver.write_text(AGENT_DRIVER)
   value=subprocess.run([sys.executable,'-B',str(driver),str(agent_dir),str(home),mode,str(path)],capture_output=True,text=True,timeout=60,
                        env={'HOME':str(home),'PATH':'/usr/bin:/bin','LANG':'en_US.UTF-8'})
  self.assertEqual(value.returncode,0,value.stderr[-2000:])
  return json.loads(value.stdout.strip().splitlines()[-1])
 def fixture(self):
  case=ApplyRecovery('runTest');case.setUp();self.addCleanup(case.tearDown)
  (case.own/'updates/receipts').mkdir(parents=True);return case
 def test_a_snapshot_keeps_its_fields_and_old_agents_accept_it(self):
  import types
  case=self.fixture();state=case.own/'userdata';waiting_fixture(state)
  (state/'settings.json').write_text('{"branchNamePrefix":"anton"}');(state/'environment-id').write_text('environment')
  service={'home':case.home,'own':case.own,'installation':case.own/'installation.json','label':'com.specweave.studio.m4','plist':case.plist,
           'wrapper':case.wrapper,'launcher':case.own/'launch.sh','content':{'ProgramArguments':['/usr/bin/caffeinate','-s',str(case.own/'launch.sh')]},
           'node':pathlib.Path(case.node),'runtime':{'pid':100},'owner':types.SimpleNamespace(uid=501,policy='browser-cookie'),
           'receipt':{'port':8319,'archiveSha256':'d'*64,'sourceCommit':'a'*40,'cookieName':'studio-session'}}
  with patch.object(update,'_service',return_value=service),patch.object(update,'assert_database_attached'),\
    patch.object(update,'assert_database_locked'),patch.object(update,'listeners',return_value=[]),\
    patch.object(update,'read_processes',return_value={}),patch.object(update,'capture_quiescence',return_value={'root':{'pid':100,'uid':501}}):
   value=update.snapshot('m4')
  self.assertEqual(set(value),SNAPSHOT_KEYS)
  # A forced admission uses the same metadata checks, with a real hold and idle read,
  # but no complete row scan. Ordinary snapshots above retain their exact contract.
  now=datetime.datetime.now(datetime.timezone.utc)
  request=now.isoformat();service['runtime']['startedAt']=(now-datetime.timedelta(minutes=5)).isoformat()
  updates=case.own/'updates'
  (updates/'hold.json').write_text(json.dumps({'schemaVersion':1,'pid':100,'startedAt':(now-datetime.timedelta(seconds=1)).isoformat(),'expiresAt':(now+datetime.timedelta(minutes=5)).isoformat()}))
  (updates/'config.json').write_text(json.dumps({'installMode':'force','installRequestedAt':request}))
  with patch.object(update,'_service',return_value=service),patch.object(update,'assert_database_attached'), \
    patch.object(update,'assert_database_locked'),patch.object(update,'listeners',return_value=[]), \
    patch.object(update,'read_processes',return_value={}),patch.object(update,'capture_quiescence',return_value={'root':{'pid':100,'uid':501}}), \
    patch.object(update,'_read_state',side_effect=AssertionError('Unexpected full row scan')):
   light=update.snapshot('m4',request)
   self.assertEqual(light['snapshotMode'],'held-service')
   self.assertNotIn('databaseCapture',light)
   self.assertEqual(light['rows'],{'nativeWorkIdle':True,'counts':{}})
   with self.assertRaisesRegex(AssertionError,'Unexpected full row scan'):update.snapshot('m4',(now-datetime.timedelta(seconds=2)).isoformat())
   mutate_state(state,"INSERT INTO orchestration_v2_projection_runtime_requests VALUES ('pending')")
   with self.assertRaisesRegex(AssertionError,'Native work is not idle'):update.snapshot('m4',request)
  path=case.own/'updates/snapshot-contract.json';path.write_text(json.dumps(value,indent=2)+'\n')
  for agent in self.agents():
   with self.subTest(agent=str(agent)):self.assertTrue(self.read_with(agent,case.home,'snapshot',path))
 def installed(self,case):
  account=__import__('pwd').getpwuid(os.getuid())
  installation={'schemaVersion':1,'identity':'m4','studioHome':str(case.own),'stateDir':str(case.own/'userdata'),'version':'0.2.0',
                'sourceCommit':'a'*40,'archiveSha256':'d'*64,'release':str(case.home/'.specwithcode/install/releases'/('d'*20)),
                'node':'/usr/bin/node','uid':os.getuid(),'user':account.pw_name,'cliWrapper':str(case.wrapper),'host':'127.0.0.1','port':8319,
                'service':{'installed':True,'label':'com.specweave.studio.m4','domain':'gui/'+str(os.getuid())}}
  (case.own/'installation.json').write_text(json.dumps(installation))
 def test_a_preflight_refusal_keeps_its_five_keys_and_old_agents_retry_it(self):
  case=self.fixture();self.installed(case)
  path=case.own/'updates/receipts/update-preflight.json'
  update.write_preflight_failure(path,'m4',AssertionError('Guarded prestate changed: rows'))
  self.assertEqual(set(json.loads(path.read_text())),PREFLIGHT_KEYS)
  for agent in self.agents():
   with self.subTest(agent=str(agent)):self.assertTrue(self.read_with(agent,case.home,'preflight',path))
 def test_a_busy_installation_lock_is_a_refusal_this_agent_retries(self):
  # The prune after the last verified install holds the lock for its deletes (state_backup_prune).
  case=self.fixture();self.installed(case)
  path=case.own/'updates/receipts/update-locked.json'
  update.write_preflight_failure(path,'m4',AssertionError(update.state_backup_prune.LOCK_BUSY))
  self.assertTrue(self.read_with(pathlib.Path(__file__).resolve().parent,case.home,'retry',path))
 def test_a_verified_receipt_keeps_what_old_agents_read_and_they_accept_it(self):
  case=self.fixture();case.incoming_version='0.2.0';case.incoming_source='a'*40
  case.before.update(schemaVersion=1,artifactSourceCommit='b'*40)
  case.output=case.own/'updates/receipts/update-verified.json';case.execute()
  receipt=json.loads(case.output.read_text())
  self.assertEqual(receipt['phase'],'verified');self.assertNotIn('result',receipt)
  self.assertTrue(all(receipt[flag] is True for flag in VERIFIED_FLAGS))
  for part in ('before','after'):
   self.assertEqual((receipt[part]['schemaVersion'],receipt[part]['identity'],receipt[part]['serviceLabel']),(1,'m4','com.specweave.studio.m4'))
  self.assertEqual((receipt['after']['artifactSourceCommit'],receipt['after']['archiveSha256']),('a'*40,case.sha))
  for agent in self.agents():
   with self.subTest(agent=str(agent)):self.assertTrue(self.read_with(agent,case.home,'verified',case.output))
 def failure_receipt(self,configure,error):
  case=self.fixture();configure(case);case.output=case.own/'updates/receipts/update-failed.json'
  with self.assertRaises(error):case.execute()
  self.installed(case);return case,json.loads(case.output.read_text())
 def test_failures_after_the_stop_never_read_as_installed_or_as_a_refusal_to_retry(self):
  # The old release was stopped for the copy and started again: no agent may take that for an
  # install, nor retry it on its own as a refusal before the restart.
  def stop_times_out(pid,*,port=8319):raise AssertionError('Owned service did not stop for the state restore')
  for name,configure,error in (('copy',lambda case:case.failing_copy(OSError(28,'No space left on device')),OSError),
                               ('stop',lambda case:setattr(case,'wait_for_stopped',stop_times_out),AssertionError)):
   case,receipt=self.failure_receipt(configure,error)
   self.assertEqual((receipt['phase'],receipt['pointers'],receipt['serviceStopped']),('pointers-written','previous-release',True))
   for agent in self.agents():
    with self.subTest(failure=name,agent=str(agent)):
     self.assertFalse(self.read_with(agent,case.home,'verified',case.output))
     self.assertFalse(self.read_with(agent,case.home,'retry',case.output))
 def test_a_change_at_the_last_check_is_still_a_refusal_old_agents_retry(self):
  def changed_at_the_last_check(case):
   guard=case.quiescence_guard
   def browser_stop_while_a_schedule_runs(*args,**kwargs):
    value=guard(*args,**kwargs)
    case.rows=copy.deepcopy(case.rows);case.rows['hashes']['scheduled_tasks']='old-service-ran-a-due-task'
    return value
   case.quiescence_guard=browser_stop_while_a_schedule_runs
  case,receipt=self.failure_receipt(changed_at_the_last_check,AssertionError)
  self.assertIn('Native work changed before restart',receipt['error']);self.assertNotIn('serviceStopped',receipt)
  for agent in self.agents():
   with self.subTest(agent=str(agent)):
    self.assertFalse(self.read_with(agent,case.home,'verified',case.output))
    self.assertTrue(self.read_with(agent,case.home,'retry',case.output))
class EarlyDescendantRefusal(unittest.TestCase):
 """A stray process beneath the service refuses the snapshot before the full read (minutes on
 M4), with the same refusal; a quiet tree is still captured again after the read for the proof."""
 def service(self):
  import types
  case=ApplyRecovery('runTest');case.setUp();self.addCleanup(case.tearDown)
  state=case.own/'userdata';waiting_fixture(state)
  (state/'settings.json').write_text('{}');(state/'environment-id').write_text('environment')
  return {'home':case.home,'own':case.own,'installation':case.own/'installation.json','label':'com.specweave.studio.m4','plist':case.plist,
          'wrapper':case.wrapper,'launcher':case.own/'launch.sh','content':{'ProgramArguments':['/usr/bin/caffeinate','-s',str(case.own/'launch.sh')]},
          'node':pathlib.Path('/verified/node22'),'runtime':{'pid':100},'owner':types.SimpleNamespace(uid=501,policy='browser-cookie'),
          'receipt':{'port':8319,'archiveSha256':'d'*64,'sourceCommit':'a'*40,'cookieName':'studio-session'}}
 def tree(self,*extra):
  rows=[(1,0,'/sbin/launchd',0),(100,1,'/verified/node22',501),(101,100,'/usr/bin/caffeinate',501),*extra]
  return {pid:{'pid':pid,'parent':parent,'uid':uid,'startedAt':'Thu Oct 8 13:26:00 2026','executable':executable}
          for pid,parent,executable,uid in rows}
 def run_snapshot(self,service,tree,events,request=None):
  import quiescence
  real=update._read_state
  def processes():events.append('ps');return copy.deepcopy(tree)
  def read(*args):events.append('read');return real(*args)
  with patch.object(update,'_service',return_value=service),patch.object(update,'assert_database_attached'),\
    patch.object(update,'assert_database_locked'),patch.object(update,'listeners',return_value=[]),\
    patch.object(quiescence,'read_processes',side_effect=processes),patch.object(update,'read_processes',side_effect=processes),\
    patch.object(quiescence,'read_argv',return_value=service['content']['ProgramArguments']),\
    patch.object(update,'_read_state',side_effect=read):
   return update.snapshot('m4',request)
 def test_a_stray_descendant_refuses_before_any_row_is_read(self):
  service=self.service()
  for parent,executable in ((100,'/usr/bin/git'),(101,'/bin/sh'),(100,'/verified/node22'),(100,'/usr/bin/caffeinate')):
   with self.subTest(parent=parent,executable=executable):
    events=[]
    with self.assertRaisesRegex(AssertionError,'^Owned service has unexpected (or missing )?descendants$'):
     self.run_snapshot(service,self.tree((102,parent,executable,501)),events)
    self.assertNotIn('read',events)
    self.assertIn('ps',events)
 def test_a_quiet_tree_is_checked_before_the_read_and_captured_again_after_it(self):
  service=self.service();events=[]
  value=self.run_snapshot(service,self.tree(),events)
  self.assertEqual(value['processQuiescence']['root']['pid'],100)
  self.assertEqual(events.count('read'),1)
  first=events.index('read')
  self.assertIn('ps',events[:first]);self.assertIn('ps',events[first+1:])
 def test_a_held_snapshot_reads_no_rows_and_captures_once(self):
  service=self.service();now=datetime.datetime.now(datetime.timezone.utc)
  request=now.isoformat();service['runtime']['startedAt']=(now-datetime.timedelta(minutes=5)).isoformat()
  updates=service['own']/'updates';updates.mkdir(exist_ok=True)
  (updates/'hold.json').write_text(json.dumps({'schemaVersion':1,'pid':100,'startedAt':(now-datetime.timedelta(seconds=1)).isoformat(),
                                               'expiresAt':(now+datetime.timedelta(minutes=5)).isoformat()}))
  (updates/'config.json').write_text(json.dumps({'installMode':'force','installRequestedAt':request}))
  events=[]
  with patch.object(update,'capture_quiescence',side_effect=lambda *args:events.append('capture') or {'root':{'pid':100,'uid':501}}):
   value=self.run_snapshot(service,self.tree(),events,request)
  self.assertEqual(value['snapshotMode'],'held-service')
  self.assertEqual((events.count('read'),events.count('capture')),(0,1))
class AuthHeartbeatPrestate(unittest.TestCase):
 def fixture(self, state):
  db=sqlite3.connect(state/'statev2.sqlite')
  db.executescript("CREATE TABLE projection_projects(project_id TEXT);CREATE TABLE projection_threads(thread_id TEXT);CREATE TABLE orchestration_v2_projection_runs(status TEXT);CREATE TABLE orchestration_v2_projection_runtime_requests(status TEXT);CREATE TABLE orchestration_v2_effect_outbox(status TEXT, retained_content TEXT);CREATE TABLE orchestration_v2_projection_provider_sessions(status TEXT);CREATE TABLE auth_sessions(session_id TEXT, subject TEXT, scopes TEXT, method TEXT, issued_at TEXT, expires_at TEXT, last_connected_at TEXT, revoked_at TEXT);")
  db.execute("INSERT INTO auth_sessions VALUES ('s1','owner','operate','browser-session-cookie','2026-10-10T00:00:00Z','2026-11-10T00:00:00Z','2026-10-11T03:00:00Z',NULL)");db.commit()
  return db
 def snapshot(self, state, change=None):
  db=self.fixture(state) if change is None else sqlite3.connect(state/'statev2.sqlite')
  if change:db.execute(change);db.commit()
  db.close();return update.rows_snapshot(state)
 def prestate(self, rows):
  value={**{key:key for key in ['identity','uid','serviceLabel','servicePid','archiveSha256','artifactSourceCommit','fileHashes','otherListeners','cookieName','processQuiescence']},'otherListenersOwned':False}
  value['rows']=rows;return value
 def test_auth_changes_before_the_helpers_baseline_are_accepted_but_later_changes_refuse(self):
  changes = ["INSERT INTO auth_sessions VALUES ('s2','owner','operate','browser-session-cookie','2026-10-11T03:57:00Z','2026-11-11T00:00:00Z',NULL,NULL)",
             "UPDATE auth_sessions SET scopes='admin'", "DELETE FROM auth_sessions"]
  for change in changes:
   with self.subTest(change=change), tempfile.TemporaryDirectory() as tmp:
    state=pathlib.Path(tmp);agent=self.snapshot(state);baseline=self.snapshot(state,change)
    with self.assertRaises(AssertionError):update.assert_prestate(self.prestate(agent),self.prestate(baseline))
    update.assert_prestate(self.prestate(agent),self.prestate(baseline),auth_baseline=baseline)
    later=self.snapshot(state,"INSERT INTO auth_sessions VALUES ('late','owner','operate','browser-session-cookie','2026-10-11T04:00:00Z','2026-11-11T00:00:00Z',NULL,NULL)")
    with self.assertRaisesRegex(AssertionError,'Guarded prestate changed: rows'):
     update.assert_prestate(self.prestate(agent),self.prestate(later),auth_baseline=baseline)
 def test_fresh_auth_baseline_does_not_allow_a_non_auth_change(self):
  with tempfile.TemporaryDirectory() as tmp:
   state=pathlib.Path(tmp);agent=self.snapshot(state)
   baseline=self.snapshot(state,"INSERT INTO projection_projects VALUES ('new-project')")
   with self.assertRaisesRegex(AssertionError,'Guarded prestate changed: rows'):
    update.assert_prestate(self.prestate(agent),self.prestate(baseline),auth_baseline=baseline)
 def test_fresh_auth_baseline_does_not_bypass_the_complete_database_capture(self):
  from update_read import _read_state
  with tempfile.TemporaryDirectory() as tmp:
   state=pathlib.Path(tmp);db=self.fixture(state);db.execute('CREATE TABLE unguarded(value TEXT)');db.commit();db.close()
   def capture():
    rows,auth,carried,proof=_read_state(state,False,include_database=True)
    return {**self.prestate(rows),'databaseCapture':proof}
   agent=capture();db=sqlite3.connect(state/'statev2.sqlite')
   db.execute("UPDATE auth_sessions SET scopes='admin'");db.commit();db.close();baseline=capture()
   update.assert_prestate(agent,baseline,auth_baseline=baseline['rows'])
   db=sqlite3.connect(state/'statev2.sqlite');db.execute("INSERT INTO unguarded VALUES ('changed')");db.commit();db.close()
   with self.assertRaisesRegex(AssertionError,'Complete database prestate changed'):
    update.assert_prestate(agent,capture(),auth_baseline=baseline['rows'])
 def test_a_connection_heartbeat_does_not_break_the_prestate(self):
  with tempfile.TemporaryDirectory() as tmp:
   state=pathlib.Path(tmp);before=self.snapshot(state)
   after=self.snapshot(state,"UPDATE auth_sessions SET last_connected_at='2026-10-11T03:58:00Z'")
   self.assertNotEqual(before['hashes']['auth_sessions'],after['hashes']['auth_sessions'])
   update.assert_prestate(self.prestate(before),self.prestate(after))
   self.assertTrue(update.same_guarded_rows(before,after))
 def test_a_reconnect_reporting_its_app_version_does_not_break_the_prestate(self):
  # A desktop app relaunched into the new release reports its version on its first connect
  # (AuthSessions.ts setClientConnectionRow), between the agent's snapshot and the apply.
  with tempfile.TemporaryDirectory() as tmp:
   state=pathlib.Path(tmp);db=self.fixture(state)
   db.executescript("ALTER TABLE auth_sessions ADD COLUMN client_surface TEXT;ALTER TABLE auth_sessions ADD COLUMN client_app_version TEXT;UPDATE auth_sessions SET client_surface='desktop',client_app_version='1.0.60';");db.close()
   before=update.rows_snapshot(state)
   after=self.snapshot(state,"UPDATE auth_sessions SET client_surface='desktop',client_app_version='1.0.61',last_connected_at='2026-10-11T03:58:00Z'")
   self.assertNotEqual(before['hashes']['auth_sessions'],after['hashes']['auth_sessions'])
   self.assertEqual(before[update.AUTH_INVARIANT_KEY],after[update.AUTH_INVARIANT_KEY])
   update.assert_prestate(self.prestate(before),self.prestate(after))
   self.assertTrue(update.same_guarded_rows(before,after))
   changed=self.snapshot(state,"UPDATE auth_sessions SET method='bearer-access-token'")
   with self.assertRaises(AssertionError):update.assert_prestate(self.prestate(before),self.prestate(changed))
 def test_a_changed_client_surface_refuses_before_the_restart(self):
  # The heartbeat proof after the restart classifies sessions by their surface and never accepts
  # a changed one, so the prestate refuses it first (cheap and retried) instead of a rollback.
  with tempfile.TemporaryDirectory() as tmp:
   state=pathlib.Path(tmp);db=self.fixture(state)
   db.executescript("ALTER TABLE auth_sessions ADD COLUMN client_surface TEXT;ALTER TABLE auth_sessions ADD COLUMN client_app_version TEXT;");db.close()
   before=update.rows_snapshot(state)
   for surface in ("'web'","'desktop'"):
    with self.subTest(surface=surface):
     after=self.snapshot(state,"UPDATE auth_sessions SET client_surface="+surface+",client_app_version='1.0.61'")
     self.assertNotEqual(before[update.AUTH_INVARIANT_KEY],after[update.AUTH_INVARIANT_KEY])
     self.assertFalse(update.same_guarded_rows(before,after))
     with self.assertRaisesRegex(AssertionError,'Guarded prestate changed'):update.assert_prestate(self.prestate(before),self.prestate(after))
 def test_identity_scope_expiry_or_revocation_changes_still_fail(self):
  for change in ["UPDATE auth_sessions SET revoked_at='2026-10-11T03:58:00Z'","UPDATE auth_sessions SET scopes='admin'",
                 "UPDATE auth_sessions SET expires_at='2027-01-01T00:00:00Z'","UPDATE auth_sessions SET subject='other'",
                 "INSERT INTO auth_sessions VALUES ('s2','owner','operate','browser-session-cookie','2026-10-11T03:57:00Z','2026-11-11T00:00:00Z','2026-10-11T03:57:00Z',NULL)"]:
   with self.subTest(change=change),tempfile.TemporaryDirectory() as tmp:
    state=pathlib.Path(tmp);before=self.snapshot(state);after=self.snapshot(state,change)
    with self.assertRaises(AssertionError):update.assert_prestate(self.prestate(before),self.prestate(after))
 def test_other_protected_tables_stay_byte_exact_beside_a_heartbeat(self):
  with tempfile.TemporaryDirectory() as tmp:
   state=pathlib.Path(tmp);before=self.snapshot(state)
   db=sqlite3.connect(state/'statev2.sqlite');db.execute("UPDATE auth_sessions SET last_connected_at='x'");db.execute("INSERT INTO projection_threads VALUES ('t1')");db.commit();db.close()
   with self.assertRaises(AssertionError):update.assert_prestate(self.prestate(before),self.prestate(update.rows_snapshot(state)))
 def test_a_snapshot_without_the_invariant_hash_is_compared_exactly(self):
  with tempfile.TemporaryDirectory() as tmp:
   state=pathlib.Path(tmp);before=self.snapshot(state)
   after=self.snapshot(state,"UPDATE auth_sessions SET last_connected_at='2026-10-11T03:58:00Z'")
   legacy=dict(before);del legacy[update.AUTH_INVARIANT_KEY]
   with self.assertRaises(AssertionError):update.assert_prestate(self.prestate(legacy),self.prestate(after))
 def test_the_invariant_hash_holds_no_session_content(self):
  with tempfile.TemporaryDirectory() as tmp:
   value=self.snapshot(pathlib.Path(tmp))
   self.assertRegex(value[update.AUTH_INVARIANT_KEY],'^[0-9a-f]{64}$')
   self.assertNotIn('browser-session-cookie',json.dumps(value));self.assertNotIn('owner',json.dumps(value))
 def test_the_pre_restart_rows_check_uses_the_heartbeat_tolerant_comparison(self):
  source=pathlib.Path(update.__file__).read_text()
  self.assertIn("assert same_guarded_rows(before['rows'], current_rows, current_carried,\n"
                "                                     auth_heartbeat=allow_existing_browser_heartbeat), 'Native work changed before restart'",source)
  self.assertIn("current_rows, current_carried = rows_since(own / 'userdata', before['rows'])",source)
class PreflightFailureReceipt(unittest.TestCase):
 def run_main(self, tmp, error=None, writes_progress=False):
  tmp=pathlib.Path(tmp);prestate=tmp/'prestate.json';prestate.write_text('{}');archive=tmp/'a.tar.gz';archive.write_bytes(b'x')
  output=tmp/'receipts/update-0.2.4-x.json';output.parent.mkdir()
  def fake_apply(identity,expected,archive_path,sha,out,**kwargs):
   if writes_progress:out.write_text(json.dumps({'phase':'prepared'}))
   if error:raise error
  argv=['update.py','--identity','m4','--prestate',str(prestate),'--archive',str(archive),'--sha256','a'*64,'--output',str(output)]
  with patch.object(update,'apply',fake_apply),patch('sys.argv',argv):
   if error:
    with self.assertRaises(type(error)):update.main()
   else:update.main()
  return output
 def test_prestate_mismatch_before_prepared_leaves_a_receipt_with_the_cause(self):
  with tempfile.TemporaryDirectory() as tmp:
   output=self.run_main(tmp,AssertionError('Protected rows or counts changed'))
   value=json.loads(output.read_text())
   self.assertEqual(value['result'],'update-failed');self.assertEqual(value['phase'],'preflight');self.assertEqual(value['identity'],'m4')
   self.assertEqual(value['error'],'AssertionError: Protected rows or counts changed');self.assertEqual(output.stat().st_mode & 0o777,0o600)
 def test_missing_installation_before_prepared_names_the_error_type(self):
  with tempfile.TemporaryDirectory() as tmp:
   output=self.run_main(tmp,FileNotFoundError(2,'No such file','installation.json'))
   self.assertTrue(json.loads(output.read_text())['error'].startswith('FileNotFoundError'))
 def test_a_receipt_written_by_apply_is_never_overwritten(self):
  with tempfile.TemporaryDirectory() as tmp:
   output=self.run_main(tmp,AssertionError('late'),writes_progress=True)
   self.assertEqual(json.loads(output.read_text()),{'phase':'prepared'})
 def test_process_inventory_timing_out_twice_leaves_a_preflight_receipt(self):
  import quiescence,subprocess
  calls=[]
  def slow_ps(command,**kwargs):
   calls.append(kwargs['timeout']);raise subprocess.TimeoutExpired(command,kwargs['timeout'])
  def apply_reading_processes(identity,expected,archive_path,sha,out,**kwargs):quiescence.read_processes()
  with tempfile.TemporaryDirectory() as tmp:
   tmp=pathlib.Path(tmp);prestate=tmp/'prestate.json';prestate.write_text('{}');archive=tmp/'a.tar.gz';archive.write_bytes(b'x')
   output=tmp/'update.json'
   argv=['update.py','--identity','m4','--prestate',str(prestate),'--archive',str(archive),'--sha256','a'*64,'--output',str(output)]
   with patch.object(update,'apply',apply_reading_processes),patch.object(quiescence.subprocess,'run',side_effect=slow_ps),patch('sys.argv',argv):
    with self.assertRaises(subprocess.TimeoutExpired):update.main()
   value=json.loads(output.read_text())
   self.assertEqual(calls,[30,30]);self.assertEqual(value['phase'],'preflight');self.assertEqual(value['pointers'],'unchanged')
   self.assertTrue(value['error'].startswith('TimeoutExpired'),value['error'])
 def test_listener_check_retries_a_slow_lsof_before_failing(self):
  import subprocess
  calls=[]
  def lsof(command,**kwargs):
   calls.append(kwargs['timeout'])
   if len(calls)==1:raise subprocess.TimeoutExpired(command,kwargs['timeout'])
   return subprocess.CompletedProcess(command,0,'42\n42\n7\n','')
  with patch.object(update.subprocess,'run',side_effect=lsof):
   self.assertEqual(update.listeners(8319),[7,42])
  self.assertEqual(calls,[30,30])
  calls.clear()
  def slow(command,**kwargs):
   calls.append(kwargs['timeout']);raise subprocess.TimeoutExpired(command,kwargs['timeout'])
  with patch.object(update.subprocess,'run',side_effect=slow):
   with self.assertRaises(subprocess.TimeoutExpired):update.listeners(8319)
  self.assertEqual(calls,[30,30])
 def test_success_writes_no_preflight_receipt(self):
  with tempfile.TemporaryDirectory() as tmp:
   self.assertFalse(self.run_main(tmp).exists())
class GateSettle(unittest.TestCase):
 """AC-06: the install gate settles 2 s when the running service holds itself for this forced request, else 12 s."""
 def held(self,own,pid=100):
  (own/'updates').mkdir(parents=True,exist_ok=True);(own/'userdata').mkdir(parents=True,exist_ok=True)
  now=datetime.datetime.now(datetime.timezone.utc);at=lambda seconds:(now+datetime.timedelta(seconds=seconds)).isoformat().replace('+00:00','Z')
  write=lambda name,**value:(own/name).write_text(json.dumps(value))
  write('userdata/server-runtime.json',pid=pid,host='127.0.0.1',port=8319,startedAt=at(-600))
  write('updates/hold.json',schemaVersion=1,holdId='h',pid=pid,startedAt=at(-60),expiresAt=at(600))
  write('updates/config.json',installMode='force',installRequestedAt=at(-30),installCancelledAt=None)
  return write,at
 def fixture(self):
  temp=tempfile.TemporaryDirectory(prefix='studio-gate-settle-');self.addCleanup(temp.cleanup)
  home=pathlib.Path(temp.name).resolve();own=home/'.specwithcode/m4'
  return home,own,self.held(own)
 def test_a_service_held_for_this_request_settles_in_two_seconds(self):
  home,own,_=self.fixture()
  self.assertEqual(update.gate_settle(own,home,100,update.INSTALL_GATE_SETTLE_SECONDS),('held',2))
 def test_anything_else_keeps_the_full_settle(self):
  self.assertEqual(update.INSTALL_GATE_SETTLE_SECONDS,12)
  config=lambda write,at,**changes:write('updates/config.json',**dict({'installMode':'force','installRequestedAt':at(-30)},**changes))
  cases={'another service':lambda own,write,at:None,
   'no hold':lambda own,write,at:(own/'updates/hold.json').unlink(),
   'a hold of another process':lambda own,write,at:write('updates/hold.json',schemaVersion=1,pid=5151,startedAt=at(-60),expiresAt=at(600)),
   'a hold that ended':lambda own,write,at:write('updates/hold.json',schemaVersion=1,pid=100,startedAt=at(-60),expiresAt=at(-1)),
   'not forced':lambda own,write,at:config(write,at,installMode='normal'),
   'cancelled':lambda own,write,at:config(write,at,installCancelledAt=at(-1)),
   'no request':lambda own,write,at:config(write,at,installRequestedAt=None),
   'no runtime':lambda own,write,at:(own/'userdata/server-runtime.json').unlink(),
   'malformed config':lambda own,write,at:(own/'updates/config.json').write_text('[]')}
  for name,change in cases.items():
   with self.subTest(name):
    home,own,(write,at)=self.fixture();change(own,write,at)
    self.assertEqual(update.gate_settle(own,home,101 if name=='another service' else 100,12),('full',12))
 def test_apply_sleeps_two_seconds_only_for_a_held_request(self):
  for held,settle,mode in ((True,2000,'held'),(False,12000,'full')):
   with self.subTest(held=held):
    fixture=ApplyRecovery(methodName='runTest');fixture.setUp();self.addCleanup(fixture.tearDown);seen={}
    if held:self.held(fixture.own)
    fixture.on_restart=lambda:seen.update(json.loads(fixture.output.read_text()))
    fixture.execute()
    result=json.loads(fixture.output.read_text())
    self.assertEqual((result['phase'],result['timings']['gateSettle'],seen['gateSettle']),('verified',settle,mode))
    self.assertNotIn('gateSettle',result)
class ReleasePolicyVersionTests(unittest.TestCase):
 def test_stable_1_x_follows_the_alpha_line_and_never_goes_back(self):
  import release_policy
  for previous,incoming in [('0.2.12','1.0.0'),('0.1.4','1.0.0'),('1.0.0','1.0.1'),('1.0.9','1.1.0'),('1.0.0','1.0.0')]:
   release_policy.validate_upgrade(previous,incoming)
  for previous,incoming in [('1.0.0','0.2.12'),('1.0.1','1.0.0'),('0.2.12','0.3.0'),('0.2.12','2.0.0'),('1.0.0','1.0.0-rc.1'),('1.0.0','01.0.0')]:
   with self.subTest(previous=previous,incoming=incoming),self.assertRaises(AssertionError):
    release_policy.validate_upgrade(previous,incoming)
if __name__=='__main__':unittest.main()
