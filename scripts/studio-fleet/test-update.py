#!/usr/bin/env python3
"""CAS and privacy guards: pure temporary metadata, never production services."""
import contextlib,copy,datetime,importlib.util,io,json,pathlib,shlex,shutil,sqlite3,tempfile,unittest
from unittest.mock import patch
import auth_heartbeat
import os,time
import release_retention
from launcher import legacy_runtime_path, runtime_path
spec=importlib.util.spec_from_file_location("owned_update",pathlib.Path(__file__).with_name("update.py"))
update=importlib.util.module_from_spec(spec);spec.loader.exec_module(update)
REAL_ROWS_SNAPSHOT,REAL_ROWS_SINCE=update.rows_snapshot,update.rows_since
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
  if command[:2]==['/bin/launchctl','print']:return 'path = '+str(self.plist)+'\npid = '+str(101 if self.restarted else 100)+'\n'
  if command[:2]==['/bin/launchctl','kickstart']:
   self.restart_calls.append(command)
   if self.scenario=='restart-failed':raise AssertionError('Owned transport rejected restart')
   self.restarted=True;(self.own/'userdata/server-runtime.json').write_text(json.dumps({'pid':101,'host':'127.0.0.1','port':8319}))
   if self.on_restart and len(self.restart_calls)==1:self.on_restart()
   return b''
  if command[0]=='/bin/ps':return self.node+' '+self.oldrelease+'/bin.mjs'
  if command[:2] in (['/bin/launchctl','bootout'],['/bin/launchctl','bootstrap']):
   self.launchd.append(command[1]);return b''
  self.fail('Unexpected transport command')
 def backup_state(self,own,commit):
  self.assertFalse(self.restarted,'State must be copied before the new release starts')
  backup=self.home/'state-backup.sqlite';backup.write_bytes(b'pre-update-state');self.backups.append(commit);return backup
 def restore_state(self,backup,own):
  if self.scenario=='restore-failed':raise OSError('restore failed')
  self.restores.append(backup.read_bytes())
 def wait_for_stopped(self,pid,*,port=8319):self.stops.append(pid)
 def execute(self,allow_existing_browser_heartbeat=False,allow_project_migrations=False):
  self.stdout=io.StringIO()
  with patch.object(update,'current_owner',return_value={'home':self.home}),patch.object(update,'backup_state',side_effect=self.backup_state),patch.object(update,'restore_state',side_effect=self.restore_state),patch.object(update,'wait_for_stopped',side_effect=self.wait_for_stopped),patch.object(pathlib.Path,'home',return_value=self.home),patch.object(update,'snapshot',side_effect=self.snapshot),patch.object(update,'snapshot_with_auth',side_effect=self.snapshot_with_auth),patch.object(update,'snapshot_since',side_effect=self.snapshot_since),patch.object(update,'rows_snapshot',side_effect=self.rows_snapshot),patch.object(update,'rows_since',side_effect=self.rows_since),patch.object(update,'run',side_effect=self.transport),patch.object(update,'listeners',return_value=[100]),patch.object(update,'assert_quiescence',side_effect=self.quiescence_guard),patch.object(update.time,'sleep',side_effect=lambda seconds:self.clock.__setitem__(0,self.clock[0]+seconds)),patch.object(update.time,'monotonic',side_effect=lambda:self.clock[0]),contextlib.redirect_stdout(self.stdout):
   update.apply('m4',self.before,self.archive,self.sha,self.output,allow_existing_browser_heartbeat=allow_existing_browser_heartbeat,allow_project_migrations=allow_project_migrations)
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
 def test_server_browser_stopped_before_restart_is_named_in_the_receipt(self):
  self.scenario='server-browser'
  self.execute();result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(len(self.restart_calls),1)
  self.assertEqual(result['serverBrowserStop']['serverBrowser'],'stopped')
  self.assertEqual(result['serverBrowserStop']['processCount'],4)
 def test_a_failed_server_browser_stop_names_each_signal_in_the_failure_receipt(self):
  self.scenario='server-browser-stop-fails'
  with self.assertRaisesRegex(AssertionError,'did not stop'):self.execute()
  failure=json.loads(self.output.read_text())
  self.assertEqual(failure['result'],'update-failed');self.assertEqual(self.restart_calls,[])
  self.assertEqual(failure['serverBrowserStop']['serverBrowser'],'stopping')
  self.assertEqual(failure['serverBrowserStop']['signals'],[{'pid':300,'startedAt':'Thu Oct 8 13:26:00 2026','signal':'SIGTERM'}])
 def test_additive_02_upgrade_preserves_rows_and_records_exact_version(self):
  self.incoming_version='0.2.0';self.incoming_source='a'*40
  self.execute()
  receipt=json.loads((self.own/'installation.json').read_text())
  self.assertEqual(receipt['version'],'0.2.0');self.assertEqual(receipt['sourceCommit'],'a'*40)
  self.assertEqual(json.loads(self.output.read_text())['phase'],'verified');self.assertEqual(len(self.restart_calls),1)
 def test_stable_1_0_upgrade_preserves_rows_and_records_exact_version(self):
  self.incoming_version='1.0.0';self.incoming_source='a'*40
  self.execute()
  receipt=json.loads((self.own/'installation.json').read_text())
  self.assertEqual(receipt['version'],'1.0.0');self.assertEqual(receipt['sourceCommit'],'a'*40)
  self.assertEqual(json.loads(self.output.read_text())['phase'],'verified');self.assertEqual(len(self.restart_calls),1)
 def test_patch_upgrade_preserves_rows_and_records_exact_version(self):
  self.incoming_version='0.1.1';self.incoming_source='a'*40
  self.execute()
  receipt=json.loads((self.own/'installation.json').read_text())
  self.assertEqual(receipt['version'],'0.1.1');self.assertEqual(receipt['sourceCommit'],'a'*40)
  self.assertEqual(json.loads(self.output.read_text())['phase'],'verified');self.assertEqual(len(self.restart_calls),1)
 def test_patch_unverified_provenance_cannot_activate_or_restart(self):
  self.incoming_version='0.1.1';self.incoming_source='unverified'
  with self.assertRaisesRegex(AssertionError,'source commit'):self.execute()
  self.assertEqual(self.restart_calls,[])
  self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
 def test_02_unverified_provenance_cannot_activate_or_restart(self):
  self.incoming_version='0.2.0';self.incoming_source='unverified'
  with self.assertRaisesRegex(AssertionError,'source commit'):self.execute()
  self.assertEqual(self.restart_calls,[])
  self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
 def test_success_preserves_rows_and_retains_immutable_old_files(self):
  self.execute();result=json.loads(self.output.read_text());self.assertEqual(result['phase'],'verified');self.assertTrue(result['preservedRowsAuthAndIdentity']);self.assertEqual(len(self.restart_calls),1)
  backup=pathlib.Path(result['backup']);self.assertEqual((backup/'cli-wrapper.sh').read_bytes(),self.original[self.wrapper]);self.assertIn('STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false',(self.own/'launch.sh').read_text())
  self.assertNotIn('STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false',self.wrapper.read_text())
  self.assertEqual(self.quiescence_checks,[self.before['processQuiescence']])
  expected='PATH='+runtime_path(self.home,pathlib.Path(self.node))
  self.assertIn(expected,shlex.split((self.own/'launch.sh').read_text().splitlines()[4]))
  self.assertIn(expected,shlex.split(self.wrapper.read_text().splitlines()[-1]))
 def test_custom_path_is_rejected_before_staging_writes_or_restart(self):
  launch=self.own/'launch.sh';launch.write_text(launch.read_text().replace(legacy_runtime_path(self.home,pathlib.Path(self.node)),'/custom/bin:/usr/bin'))
  before={p:p.read_bytes() for p in self.original}
  with self.assertRaisesRegex(AssertionError,'Custom launcher PATH'):self.execute()
  self.assertEqual(self.restart_calls,[]);self.assertFalse(self.output.exists());self.assertFalse((self.own/'owned-updates').exists())
  self.assertTrue(all(path.read_bytes()==value for path,value in before.items()))
 def test_child_appearing_immediately_before_restart_restores_pointers_without_any_stop(self):
  self.scenario='pre-restart-child'
  with self.assertRaisesRegex(AssertionError,'Unknown service descendant'):self.execute()
  self.assertEqual(self.restart_calls,[]);self.assertEqual(len(self.quiescence_checks),1)
  self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
  self.assertEqual(json.loads(self.output.read_text())['rollback'],'restored-exact-owned-runtime-pointers')
 def test_new_child_immediately_before_rollback_prevents_second_restart(self):
  self.scenario='rollback-child';self.after_mutation=lambda after:after.update(archiveSha256='wrong-artifact')
  with self.assertRaisesRegex(AssertionError,'intended artifact'):self.execute()
  self.assertEqual(len(self.restart_calls),1);self.assertEqual(len(self.quiescence_checks),2)
  self.assertEqual(self.quiescence_checks[1]['root']['pid'],101)
  result=json.loads(self.output.read_text())
  self.assertEqual(result['rollback'],'held-new-release-rollback-checks-failed')
  self.assertTrue(result['rollbackError'].startswith('AssertionError'),result['rollbackError'])
 def test_a_failed_rollback_check_leaves_the_running_new_release_configured(self):
  # The rollback's own checks fail while the new release runs (possibly on a migrated
  # database). Its pointers must still name it, or the next restart starts the old binary.
  alias=self.home/'.local/bin/specwithcode'
  self.scenario='rollback-child';self.after_mutation=lambda after:after.update(archiveSha256='wrong-artifact')
  with self.assertRaisesRegex(AssertionError,'intended artifact'):self.execute()
  self.assertEqual(json.loads((self.own/'installation.json').read_text())['archiveSha256'],self.sha)
  self.assertIn(self.sha[:20],(self.own/'launch.sh').read_text());self.assertIn(self.sha[:20],self.wrapper.read_text())
  self.assertEqual(alias.read_bytes(),self.wrapper.read_bytes())
  result=json.loads(self.output.read_text())
  self.assertEqual(result['pointers'],'new-release');self.assertEqual(self.launchd,[]);self.assertEqual(self.restores,[])
 def test_a_failed_state_backup_check_never_switches_pointers_or_stops_the_service(self):
  self.after_mutation=lambda after:after.update(archiveSha256='wrong-artifact')
  real=self.backup_state
  def missing_backup(own,commit):
   path=real(own,commit);path.unlink();return path
  self.backup_state=missing_backup
  with self.assertRaisesRegex(AssertionError,'intended artifact'):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['rollback'],'held-new-release-rollback-checks-failed')
  self.assertIn('No state backup',result['rollbackError']);self.assertEqual(result['pointers'],'new-release')
  self.assertEqual(self.launchd,[])
  self.assertEqual(json.loads((self.own/'installation.json').read_text())['archiveSha256'],self.sha)
 def test_work_appearing_before_restart_restores_owned_pointers_without_restart(self):
  self.scenario='pre-restart-active'
  with self.assertRaises(AssertionError):self.execute()
  self.assertEqual(self.restart_calls,[])
  self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
  result=json.loads(self.output.read_text());self.assertEqual(result['phase'],'pointers-written');self.assertEqual(result['rollback'],'restored-exact-owned-runtime-pointers');self.assertTrue(result['stateDeltaRetained']);self.assertTrue(pathlib.Path(result['newRelease']).is_dir())
  self.assertTrue(result['error'].startswith('AssertionError'),result['error'])
  self.scenario='success';self.output=self.home/'retry.json';self.execute();self.assertEqual(json.loads(self.output.read_text())['phase'],'verified')
 def test_work_after_restart_holds_new_pointers_and_never_stops_active_process(self):
  self.scenario='postrestart-active'
  with self.assertRaises(AssertionError):self.execute()
  result=json.loads(self.output.read_text());self.assertEqual(result['phase'],'restart-requested');self.assertEqual(result['rollback'],'held-for-safe-review');self.assertEqual(len(self.restart_calls),1)
  self.assertEqual(json.loads((self.own/'installation.json').read_text())['archiveSha256'],self.sha);self.assertTrue(pathlib.Path(result['backup']).is_dir());self.assertIn('expectedNewHashes',result)
  self.assertEqual(result['helperPid'],os.getpid())  # The desktop waits while this process lives.
 def test_rejected_restart_with_exact_old_process_restores_pointers_without_second_restart(self):
  self.scenario='restart-failed'
  with self.assertRaises(AssertionError):self.execute()
  result=json.loads(self.output.read_text());self.assertEqual(result['phase'],'restart-requested');self.assertEqual(result['rollback'],'restored-exact-owned-runtime-pointers');self.assertTrue(result['stateDeltaRetained']);self.assertEqual(len(self.restart_calls),1)
  self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()));self.assertTrue(pathlib.Path(result['newRelease']).is_dir())
 def test_success_creates_specwithcode_launcher_with_the_new_wrapper_bytes(self):
  alias=self.home/'.local/bin/specwithcode'
  self.assertFalse(alias.exists())
  self.execute();result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['cliAlias'],'created')
  self.assertEqual(alias.read_bytes(),self.wrapper.read_bytes());self.assertEqual(alias.stat().st_mode&0o777,0o700)
  self.assertNotEqual(alias.read_bytes(),self.original[self.wrapper])
  self.assertFalse((pathlib.Path(result['backup'])/'cli-alias.sh').exists())
 def test_owned_specwithcode_launcher_is_replaced_and_backed_up(self):
  alias=self.home/'.local/bin/specwithcode';alias.write_bytes(self.original[self.wrapper]);alias.chmod(0o700)
  self.execute();result=json.loads(self.output.read_text())
  self.assertEqual(result['cliAlias'],'replaced');self.assertEqual(alias.read_bytes(),self.wrapper.read_bytes())
  self.assertEqual((pathlib.Path(result['backup'])/'cli-alias.sh').read_bytes(),self.original[self.wrapper])
 def test_a_second_update_replaces_the_launcher_it_wrote(self):
  alias=self.home/'.local/bin/specwithcode'
  self.execute();first=alias.read_bytes();self.assertEqual(first,self.wrapper.read_bytes())
  # The next release: another archive, so the wrapper points at another release directory.
  self.archive.write_bytes(b'verified-synthetic-archive-2');self.sha=update.digest(self.archive.read_bytes())
  self.before['archiveSha256']=json.loads((self.own/'installation.json').read_text())['archiveSha256']
  self.output=self.home/'second.json';self.restart_calls=[];self.restarted=False
  (self.own/'userdata/server-runtime.json').write_text(json.dumps({'pid':100,'host':'127.0.0.1','port':8319}))
  self.execute();result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['cliAlias'],'replaced')
  self.assertEqual(alias.read_bytes(),self.wrapper.read_bytes());self.assertNotEqual(alias.read_bytes(),first)
  self.assertIn(self.sha[:20],alias.read_text())
  self.assertEqual((pathlib.Path(result['backup'])/'cli-alias.sh').read_bytes(),first)
 def test_foreign_specwithcode_file_or_link_is_left_untouched(self):
  alias=self.home/'.local/bin/specwithcode'
  for kind in ['file','link']:
   with self.subTest(kind=kind):
    if alias.exists() or alias.is_symlink():alias.unlink()
    target=self.home/'other-tool'
    if kind=='file':alias.write_text('#!/bin/sh\necho another tool\n')
    else:target.write_text('another tool');alias.symlink_to(target)
    before=os.readlink(alias) if kind=='link' else alias.read_bytes()
    self.output=self.home/('foreign-'+kind+'.json');self.restart_calls=[];self.restarted=False
    (self.own/'userdata/server-runtime.json').write_text(json.dumps({'pid':100,'host':'127.0.0.1','port':8319}))
    self.execute();result=json.loads(self.output.read_text())
    self.assertEqual(result['phase'],'verified');self.assertEqual(result['cliAlias'],'foreign-left-untouched')
    self.assertEqual(os.readlink(alias) if kind=='link' else alias.read_bytes(),before)
    if kind=='link':self.assertEqual(target.read_text(),'another tool')
 def test_pointer_rollback_removes_a_created_specwithcode_launcher(self):
  alias=self.home/'.local/bin/specwithcode'
  self.scenario='pre-restart-active'
  with self.assertRaises(AssertionError):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['rollback'],'restored-exact-owned-runtime-pointers');self.assertEqual(result['cliAlias'],'removed-on-rollback')
  self.assertFalse(alias.exists() or alias.is_symlink())
  self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
 def test_launcher_deleted_before_rollback_is_not_recreated(self):
  alias=self.home/'.local/bin/specwithcode'
  self.scenario='pre-restart-active'
  original_rows=self.rows_snapshot
  def delete_then_fail(state):
   alias.unlink();return original_rows(state)
  self.rows_snapshot=delete_then_fail
  with self.assertRaises(AssertionError):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['cliAlias'],'already-absent');self.assertFalse(alias.exists())
  self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
 def test_pointer_rollback_restores_an_owned_specwithcode_launcher(self):
  alias=self.home/'.local/bin/specwithcode';alias.write_bytes(self.original[self.wrapper])
  self.scenario='restart-failed'
  with self.assertRaises(AssertionError):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['rollback'],'restored-exact-owned-runtime-pointers');self.assertEqual(result['cliAlias'],'restored-on-rollback')
  self.assertEqual(alias.read_bytes(),self.original[self.wrapper])
 def race_after_alias_check(self,appear):
  # The alias is checked, then something else takes the name before the write.
  real=update.cli_alias_state;calls=[]
  def checked_then_raced(alias,owned):
   state=real(alias,owned)
   if not calls:calls.append(state[0]);appear()
   return state
  return patch.object(update,'cli_alias_state',side_effect=checked_then_raced)
 def test_a_file_appearing_after_the_alias_check_is_never_overwritten(self):
  alias=self.home/'.local/bin/specwithcode'
  with self.race_after_alias_check(lambda:alias.write_text('#!/bin/sh\necho another tool\n')):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['cliAlias'],'changed-outside-left-untouched')
  self.assertEqual(alias.read_text(),'#!/bin/sh\necho another tool\n')
  self.assertEqual(sorted(path.name for path in alias.parent.iterdir()),['specweave-studio','specwithcode'])
 def test_a_link_replacing_an_owned_launcher_after_the_check_is_never_overwritten(self):
  alias=self.home/'.local/bin/specwithcode';alias.write_bytes(self.original[self.wrapper]);alias.chmod(0o700)
  target=self.home/'other-tool';target.write_text('another tool')
  def relink():alias.unlink();alias.symlink_to(target)
  with self.race_after_alias_check(relink):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['cliAlias'],'changed-outside-left-untouched')
  self.assertTrue(alias.is_symlink());self.assertEqual(os.readlink(alias),str(target));self.assertEqual(target.read_text(),'another tool')
  self.assertFalse((pathlib.Path(result['backup'])/'cli-alias.sh').exists())
 def test_a_launcher_rollback_never_overwrites_what_replaced_it(self):
  # Rollback restores the previous launcher only while the alias still holds this update's text.
  alias=self.home/'.local/bin/specwithcode';alias.write_bytes(self.original[self.wrapper])
  self.scenario='restart-failed'
  real=update.restore_cli_alias
  def raced(path,original,written,*rest):
   path.unlink();path.write_text('another tool took the name');return real(path,original,written,*rest)
  with patch.object(update,'restore_cli_alias',side_effect=raced),self.assertRaises(AssertionError):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['cliAlias'],'changed-outside-left-untouched');self.assertEqual(alias.read_text(),'another tool took the name')
  self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
 def test_a_launcher_write_failure_is_reported_and_never_fails_the_update(self):
  alias=self.home/'.local/bin/specwithcode'
  with patch.object(update,'swap_cli_alias',side_effect=OSError(13,'Permission denied')):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['cliAlias'],'write-failed-left-as-is')
  self.assertFalse(alias.exists())
 def test_an_early_failure_never_undoes_a_launcher_this_update_did_not_write(self):
  # The wrapper write fails before the launcher is touched: rollback leaves the launcher alone.
  alias=self.home/'.local/bin/specwithcode';alias.write_bytes(self.original[self.wrapper])
  real=update.atomic;calls=[]
  def failing(path,content,mode):
   calls.append(path)
   if path==self.wrapper and len(calls)==2:raise OSError(28,'No space left on device')
   return real(path,content,mode)
  with patch.object(update,'atomic',side_effect=failing),self.assertRaises(OSError):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['cliAlias'],'not-written-yet');self.assertEqual(alias.read_bytes(),self.original[self.wrapper])
  self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
 def test_a_failed_launcher_backup_still_puts_the_replaced_launcher_back(self):
  # The launcher is already swapped when its backup copy fails to write: the rollback must
  # still treat it as ours and restore the launcher it replaced.
  alias=self.home/'.local/bin/specwithcode';alias.write_bytes(self.original[self.wrapper])
  real=pathlib.Path.write_bytes
  def failing(path,data):
   if path.name=='cli-alias.sh':raise OSError(28,'No space left on device')
   return real(path,data)
  with patch.object(pathlib.Path,'write_bytes',autospec=True,side_effect=failing),self.assertRaises(OSError):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(alias.read_bytes(),self.original[self.wrapper]);self.assertNotEqual(result['cliAlias'],'not-written-yet')
  self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
 def test_a_partial_pointer_restore_after_a_rejected_restart_is_reported_as_mixed(self):
  self.scenario='restart-failed'
  real=update.atomic
  def failing(path,content,mode):
   if path==self.wrapper and content==self.original[self.wrapper]:raise OSError(28,'No space left on device')
   return real(path,content,mode)
  with patch.object(update,'atomic',side_effect=failing),self.assertRaises(AssertionError):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['pointers'],'mixed-see-backup');self.assertIn('rollbackError',result)
  self.assertEqual((self.own/'launch.sh').read_bytes(),self.original[self.own/'launch.sh'])
 def test_an_older_studio_launcher_is_recognised_and_updated(self):
  # A specwithcode launcher an earlier Studio release wrote names another (perhaps deleted)
  # release, so its bytes match neither wrapper of this update. It is still Studio's own.
  import launcher
  render_cli=launcher.render_cli
  render_unnamed_cli=getattr(launcher,'render_unnamed_cli',render_cli)  # 0.2.7's render_cli wrote this text.
  def render_legacy_cli(prefix):return '#!/bin/sh\nset -eu\numask 077\nexec '+' '.join(shlex.quote(part) for part in prefix)+' "$@"\n'
  alias=self.home/'.local/bin/specwithcode'
  older=['/usr/bin/env','-i','HOME='+str(self.home),'PATH='+runtime_path(self.home,pathlib.Path(self.node)),
         self.node,str(self.home/'.specwithcode/install/releases/0123456789abcdef0123/bin.mjs')]
  for name,render in [('unnamed',render_unnamed_cli),('legacy',render_legacy_cli),('named',render_cli)]:
   with self.subTest(format=name):
    alias.write_text(render(older));alias.chmod(0o700);previous=alias.read_bytes()
    self.output=self.home/('older-'+name+'.json');self.restart_calls=[];self.restarted=False
    (self.own/'userdata/server-runtime.json').write_text(json.dumps({'pid':100,'host':'127.0.0.1','port':8319}))
    self.execute();result=json.loads(self.output.read_text())
    self.assertEqual(result['phase'],'verified');self.assertEqual(result['cliAlias'],'replaced')
    self.assertEqual(alias.read_bytes(),self.wrapper.read_bytes())
    self.assertEqual((pathlib.Path(result['backup'])/'cli-alias.sh').read_bytes(),previous)
 def test_a_lookalike_launcher_for_another_location_stays_foreign(self):
  import launcher
  render_unnamed_cli=getattr(launcher,'render_unnamed_cli',launcher.render_cli)
  alias=self.home/'.local/bin/specwithcode'
  elsewhere=['/usr/bin/env','-i','HOME='+str(self.home),self.node,'/opt/other-tool/releases/x/bin.mjs']
  alias.write_text(render_unnamed_cli(elsewhere));before=alias.read_bytes()
  self.execute();result=json.loads(self.output.read_text())
  self.assertEqual(result['cliAlias'],'foreign-left-untouched');self.assertEqual(alias.read_bytes(),before)
 def test_the_wait_for_the_restarted_service_is_bounded_by_time(self):
  # Each reading may take a minute when the process inventory times out and retries; 60
  # such readings would outlast the update agent's 900 s limit and leave no time to roll back.
  import subprocess
  clock=self.clock;calls=[]
  real=self.snapshot_since
  def slow_reading(identity,expected_rows,include_auth=False):
   if self.restarted:
    calls.append(clock[0]);clock[0]+=61;raise subprocess.TimeoutExpired(['/bin/ps'],30)
   return real(identity,expected_rows,include_auth)
  def snapshot(identity):
   if self.restarted:raise subprocess.TimeoutExpired(['/bin/ps'],30)
   return copy.deepcopy(self.before)
  self.snapshot_since=slow_reading;self.snapshot=snapshot
  with self.assertRaisesRegex(AssertionError,'did not become ready within 300 s'):self.execute()
  self.assertLessEqual(len(calls),6,calls);self.assertLessEqual(clock[0]-1000,300+61)
  result=json.loads(self.output.read_text())
  self.assertIn('within 300 s',result['error']);self.assertEqual(result['readinessDeadlineSeconds'],300)
  # Worst case after the wait ends: one reading in flight, the failure snapshot and rollback
  # checks, then bootout, the stop wait and bootstrap, all inside the agent's 900 s.
  self.assertLess(update.READY_BY_SECONDS_FROM_START+61+60+60+60+30+60,900)
 def test_time_spent_before_the_restart_shortens_the_wait_for_readiness(self):
  import subprocess
  clock=self.clock;calls=[]
  self.on_stage=lambda:clock.__setitem__(0,clock[0]+400)  # Slow staging and prestate checks.
  real=self.snapshot_since
  def slow_reading(identity,expected_rows,include_auth=False):
   if self.restarted:
    calls.append(clock[0]);clock[0]+=30;raise subprocess.TimeoutExpired(['/bin/ps'],30)
   return real(identity,expected_rows,include_auth)
  def snapshot(identity):
   if self.restarted:raise subprocess.TimeoutExpired(['/bin/ps'],30)
   return copy.deepcopy(self.before)
  self.snapshot_since=slow_reading;self.snapshot=snapshot
  with self.assertRaisesRegex(AssertionError,'did not become ready within 80 s'):self.execute()
  self.assertLessEqual(clock[0]-1000,update.READY_BY_SECONDS_FROM_START+30)
  self.assertEqual(json.loads(self.output.read_text())['readyBySecondsFromStart'],update.READY_BY_SECONDS_FROM_START)
 def test_preparation_too_slow_to_leave_time_for_the_restart_changes_nothing(self):
  import subprocess;budget=update.READY_BY_SECONDS_FROM_START-update.MIN_READINESS_SECONDS;since=self.snapshot_since;self.assertLessEqual(budget,update.STAGE_TIMEOUT_SECONDS)
  def outlast():self.clock[0]+=self.stage_timeouts[-1];raise subprocess.TimeoutExpired(['/usr/bin/python3'],self.stage_timeouts[-1])  # Staging gets only the budget left.
  for spent,stage,given in ((0,lambda:self.clock.__setitem__(0,self.clock[0]+budget+1),[budget]),(100,outlast,[budget-100]),(budget,None,[])):
   self.stage_timeouts,self.clock[0],self.on_stage=[],1000.0,stage;self.snapshot_since=lambda i,r,a=False,s=spent:(self.clock.__setitem__(0,self.clock[0]+s),since(i,r,a))[1]
   self.assertRaisesRegex(AssertionError,'^'+update.TOO_SLOW_TO_RESTART+'$',self.execute);self.assertEqual(self.stage_timeouts,given);self.assertEqual((self.restart_calls,self.backups),([],[]));self.assertEqual({p:p.read_bytes() for p in self.original},self.original)
 def test_a_service_that_binds_after_45_seconds_is_still_ready_in_time(self):
  # Quick readings must not run out of attempts before the deadline: the wait is time-bound.
  restarted={};real=self.snapshot_since;readings=[]
  def late_start(identity,expected_rows,include_auth=False):
   if self.restarted:
    restarted.setdefault('at',self.clock[0]);readings.append(self.clock[0])
    if self.clock[0]-restarted['at']<45:raise AssertionError('not listening yet')
   return real(identity,expected_rows,include_auth)
  self.snapshot_since=late_start
  self.execute();result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertGreater(len(readings),60)
 def test_a_foreign_launcher_kept_aside_is_reported_and_never_fails_the_update(self):
  alias=self.home/'.local/bin/specwithcode';kept=self.home/'.local/bin/.specwithcode.studio-old-fixture'
  def kept_aside(path,content,owned,report=None,**kwargs):
   report['keptAside']=str(kept);return 'foreign-kept-aside',None
  with patch.object(update,'swap_cli_alias',side_effect=kept_aside):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['cliAlias'],'foreign-kept-aside')
  self.assertEqual(result['cliAliasKeptAside'],str(kept))
 def test_a_failed_pointer_restore_puts_the_new_launcher_back_with_the_new_release(self):
  alias=self.home/'.local/bin/specwithcode'
  self.after_mutation=lambda after:after.update(archiveSha256='wrong-artifact')
  real=update.atomic;state={'restoring':False}
  def failing(path,content,mode):
   if path==self.own/'installation.json' and content==self.original[self.own/'installation.json']:
    raise OSError(28,'No space left on device')
   return real(path,content,mode)
  with patch.object(update,'atomic',side_effect=failing),self.assertRaisesRegex(AssertionError,'intended artifact'):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['rollback'],'held-new-release-pointer-restore-failed');self.assertEqual(result['pointers'],'new-release')
  self.assertEqual(json.loads((self.own/'installation.json').read_text())['archiveSha256'],self.sha)
  self.assertEqual(alias.read_bytes(),self.wrapper.read_bytes());self.assertIn(self.sha[:20],alias.read_text())
  self.assertEqual(self.launchd,['bootout','bootstrap'])
 def test_launcher_changed_after_restart_is_reported_not_fatal(self):
  alias=self.home/'.local/bin/specwithcode'
  def tamper(after):alias.write_text('changed after restart')
  self.after_mutation=tamper
  self.execute();result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['cliAlias'],'changed-outside-left-untouched')
  self.assertEqual(alias.read_text(),'changed after restart')
 def test_unreadable_foreign_launcher_is_left_untouched(self):
  alias=self.home/'.local/bin/specwithcode';alias.write_text('#!/bin/sh\necho private tool\n');alias.chmod(0)
  try:
   self.execute();result=json.loads(self.output.read_text())
   self.assertEqual(result['phase'],'verified');self.assertEqual(result['cliAlias'],'foreign-left-untouched')
   self.assertEqual(alias.stat().st_mode&0o777,0)
  finally:alias.chmod(0o600)
  self.assertEqual(alias.read_text(),'#!/bin/sh\necho private tool\n')
 def test_launcher_changed_before_rollback_never_blocks_identity_pointers(self):
  alias=self.home/'.local/bin/specwithcode'
  self.scenario='pre-restart-active'
  original_rows=self.rows_snapshot
  def change_then_fail(state):
   alias.write_text('another tool took the name');return original_rows(state)
  self.rows_snapshot=change_then_fail
  with self.assertRaises(AssertionError):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['rollback'],'restored-exact-owned-runtime-pointers')
  self.assertEqual(result['cliAlias'],'changed-outside-left-untouched')
  self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
  self.assertEqual(alias.read_text(),'another tool took the name')
 def test_process_inventory_timeout_while_the_new_service_starts_is_retried(self):
  import subprocess
  real=self.snapshot_since;calls=[]
  def slow_then_ready(identity,expected_rows,include_auth=False):
   if self.restarted and not calls:calls.append('timeout');raise subprocess.TimeoutExpired(['/bin/ps'],30)
   return real(identity,expected_rows,include_auth)
  self.snapshot_since=slow_then_ready
  self.execute();result=json.loads(self.output.read_text())
  self.assertEqual(calls,['timeout']);self.assertEqual(result['phase'],'verified');self.assertEqual(len(self.restart_calls),1)
  self.assertEqual(self.launchd,[]);self.assertEqual(self.restores,[])
 def test_process_inventory_timeouts_inside_rollback_keep_the_designed_hold(self):
  import subprocess
  real=self.snapshot_since
  def always_slow_after_restart(identity,expected_rows,include_auth=False):
   if self.restarted:raise subprocess.TimeoutExpired(['/bin/ps'],30)
   return real(identity,expected_rows,include_auth)
  def snapshot(identity):
   if self.restarted:raise subprocess.TimeoutExpired(['/bin/ps'],30)
   return copy.deepcopy(self.before)
  self.snapshot_since=always_slow_after_restart;self.snapshot=snapshot
  # The original failure is raised, not a timeout escaping the rollback.
  with self.assertRaisesRegex(AssertionError,'did not become ready'):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['rollback'],'held-for-safe-review');self.assertEqual(self.launchd,[])
  self.assertEqual(json.loads((self.own/'installation.json').read_text())['archiveSha256'],self.sha)
 def test_process_inventory_timeout_before_restart_restores_every_pointer(self):
  import subprocess
  alias=self.home/'.local/bin/specwithcode'
  self.scenario='pre-restart-ps-timeout'
  with self.assertRaises(subprocess.TimeoutExpired):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(self.restart_calls,[]);self.assertEqual(result['rollback'],'restored-exact-owned-runtime-pointers')
  self.assertTrue(result['error'].startswith('TimeoutExpired'),result['error'])
  self.assertEqual(result['cliAlias'],'removed-on-rollback');self.assertFalse(alias.exists())
  self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
 def reject_wrong_target(self,field):
  def change(after):
   if field in {'archiveSha256','artifactSourceCommit'}:after[field]='another-owned-release'
   else:after['fileHashes'][field]=update.digest(b'another-pointer')
  self.after_mutation=change
  with self.assertRaises(AssertionError):self.execute()
  result=json.loads(self.output.read_text());self.assertEqual(result['result'],'update-failed')
  self.assertTrue(result['error'].startswith('AssertionError: Updated'),result['error'])
 def test_postrestart_archive_must_be_exact_intended_release(self):self.reject_wrong_target('archiveSha256')
 def test_postrestart_source_must_be_exact_intended_commit(self):self.reject_wrong_target('artifactSourceCommit')
 def test_postrestart_launcher_must_match_written_pointer(self):self.reject_wrong_target('launcher')
 def test_postrestart_wrapper_must_match_written_pointer(self):self.reject_wrong_target('wrapper')
 def test_postrestart_installation_must_match_written_pointer(self):self.reject_wrong_target('installation')
 def test_readiness_passes_while_the_install_gate_keeps_the_new_service_quiet(self):
  self.gated_service=True
  self.execute();result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(len(self.restart_calls),1)
  self.assertTrue(self.gate_readings and all(self.gate_readings))
  # Cleared once the release is verified, so the service may start work again.
  self.assertFalse((self.own/'updates'/update.INSTALL_GATE_FILE).exists())
 def test_without_the_install_gate_the_same_service_never_becomes_ready_nor_rolls_back(self):
  self.gated_service=True
  with patch.object(update,'write_install_gate'),self.assertRaisesRegex(AssertionError,'did not become ready'):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['result'],'update-failed');self.assertIn('rollbackError',result)
  self.assertFalse(any(self.gate_readings))
 def test_a_rollback_finds_the_gated_new_release_idle_and_clears_the_gate(self):
  self.gated_service=True;self.after_mutation=lambda after:after.update(archiveSha256='another-owned-release')
  with self.assertRaisesRegex(AssertionError,'intended artifact'):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['rollback'],'restored-runtime-pointers-and-state');self.assertNotIn('rollbackError',result)
  self.assertEqual(self.stops,[101]);self.assertTrue(all(self.gate_readings))
  self.assertFalse((self.own/'updates'/update.INSTALL_GATE_FILE).exists())
 def test_the_install_gate_is_written_only_once_the_restart_is_next(self):
  self.scenario='pre-restart-child'
  with self.assertRaises(AssertionError):self.execute()
  self.assertEqual(self.restart_calls,[]);self.assertFalse((self.own/'updates'/update.INSTALL_GATE_FILE).exists())
 def test_the_install_gate_names_this_helper_and_when_it_was_written(self):
  seen=[]
  def at_restart():seen.append(json.loads((self.own/'updates'/update.INSTALL_GATE_FILE).read_text()))
  self.on_restart=at_restart;self.execute()
  self.assertEqual(seen[0]['helperPid'],os.getpid())
  written=datetime.datetime.fromisoformat(seen[0]['at'])
  self.assertLess(abs((datetime.datetime.now(datetime.timezone.utc)-written).total_seconds()),60)
  self.assertEqual(oct((self.own/'updates').stat().st_mode&0o777),'0o700')
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
 def test_opt_in_proves_real_restart_heartbeat_and_retains_actual_after_hash(self):
  self.prepare_heartbeat();self.execute(True);result=json.loads(self.output.read_text())
  self.assertEqual(self.auth_snapshot_phases,[False,True])
  self.assertEqual(result['phase'],'verified');self.assertFalse(result['rowsByteIdentical'])
  self.assertEqual(result['rowPreservation'],'verified-existing-browser-heartbeat')
  self.assertNotEqual(result['before']['rows']['hashes']['auth_sessions'],result['after']['rows']['hashes']['auth_sessions'])
  self.assertEqual(result['authHeartbeatWitness']['changedRows'],1)
  self.assertEqual(result['authHeartbeatWitness']['afterAuthSessionsSha256'],self.rows['hashes']['auth_sessions'])
  self.assertNotIn('private-session',self.output.read_text()+self.stdout.getvalue());self.assertNotIn('private-credential',self.output.read_text()+self.stdout.getvalue())
  self.assertEqual(len(self.restart_calls),1)
 def test_default_strict_rejects_the_same_real_heartbeat(self):
  self.prepare_heartbeat()
  with self.assertRaises(AssertionError):self.execute()
  self.assertEqual(self.auth_snapshot_phases,[])
  result=json.loads(self.output.read_text());self.assertEqual(result['result'],'update-failed')
  self.assertNotIn('authHeartbeatWitness',result);self.assertNotEqual(result['before']['rows'],result['attemptedAfter']['rows'])
 def test_opt_in_never_relaxes_pre_restart_rows(self):
  self.prepare_heartbeat();self.scenario='pre-restart-heartbeat'
  with self.assertRaisesRegex(AssertionError,'before restart'):self.execute(True)
  self.assertEqual(self.restart_calls,[]);self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
 def reject_heartbeat_metadata_change(self,field):
  self.prepare_heartbeat()
  def change(after):
   if field in {'settings','environment','plist'}:after['fileHashes'][field]='changed'
   elif field=='nativeWorkIdle':after['rows'][field]=False
   else:after[field]='changed'
  self.after_mutation=change
  with self.assertRaises(AssertionError):self.execute(True)
  self.assertEqual(json.loads(self.output.read_text())['result'],'update-failed')
 def test_heartbeat_does_not_exempt_settings(self):self.reject_heartbeat_metadata_change('settings')
 def test_heartbeat_does_not_exempt_environment(self):self.reject_heartbeat_metadata_change('environment')
 def test_heartbeat_does_not_exempt_plist(self):self.reject_heartbeat_metadata_change('plist')
 def test_heartbeat_does_not_exempt_listeners(self):self.reject_heartbeat_metadata_change('otherListenersOwned')
 def test_heartbeat_does_not_exempt_cookie(self):self.reject_heartbeat_metadata_change('cookieName')
 def test_heartbeat_does_not_exempt_nonidle_state(self):self.reject_heartbeat_metadata_change('nativeWorkIdle')
 def test_wrong_target_after_restart_restores_state_before_the_old_release_starts(self):
  self.after_mutation=lambda after:after.update(archiveSha256='another-owned-release')
  with self.assertRaises(AssertionError):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['rollback'],'restored-runtime-pointers-and-state');self.assertFalse(result['stateDeltaRetained'])
  self.assertEqual(self.backups,['old-source']);self.assertEqual(self.stops,[101]);self.assertEqual(self.restores,[b'pre-update-state'])
  self.assertEqual(self.launchd,['bootout','bootstrap']);self.assertEqual(len(self.restart_calls),1)
  self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
 def with_settings(self,old_value,new_value):
  """Real settings.json bytes before the restart and after the new release started on them."""
  old,new=[(json.dumps(value,indent=2)+'\n').encode() for value in (old_value,new_value)]
  self.before['fileHashes']['settings']=update.digest(old);self.before['settingsProof']=update.settings_continuity.settings_proof(old)
  def change(after):
   after['fileHashes']['settings']=update.digest(new);after['settingsProof']=update.settings_continuity.settings_proof(new)
  self.after_mutation=change
 FLEET_SETTINGS={'defaultRuntimeMode':'full-access','projectSettingsFolded':True,'branchNamePrefix':'prefix-SHOULD-not-leak',
  'projectSettingsOverrides':{'p1':{'defaultRuntimeMode':'approval-required','providerLimitAction':'switch'},'p2':{'defaultRuntimeMode':'full-access'}}}
 def test_a_one_time_settings_migration_on_start_is_verified_and_kept(self):
  # 1.0.30+ adds projectSettingsSimplified and drops p2's override equal to the app value.
  migrated=json.loads(json.dumps(self.FLEET_SETTINGS));migrated['projectSettingsSimplified']=True;del migrated['projectSettingsOverrides']['p2']
  self.with_settings(self.FLEET_SETTINGS,migrated)
  self.execute();result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(self.restores,[]);self.assertEqual(self.launchd,[])
  self.assertEqual(result['settingsContinuity']['migrations'],{'project-settings-simplified':{'droppedOverrides':1,'keys':['defaultRuntimeMode']}})
  self.assertNotIn('approval-required',self.output.read_text());self.assertNotIn('SHOULD-not-leak',self.output.read_text())
 def test_byte_identical_settings_are_reported_as_such(self):
  self.with_settings(self.FLEET_SETTINGS,self.FLEET_SETTINGS)
  self.execute();result=json.loads(self.output.read_text())
  self.assertEqual(result['settingsContinuity'],{'result':'byte-identical'})
 def test_a_changed_or_lost_user_setting_after_restart_still_rolls_back(self):
  for edit,path in [(lambda v:v.update(branchNamePrefix='changed-SHOULD-not-leak'),'/branchNamePrefix'),
                    (lambda v:v.pop('branchNamePrefix'),'/branchNamePrefix'),
                    (lambda v:v['projectSettingsOverrides']['p1'].pop('defaultRuntimeMode'),'/projectSettingsOverrides/p1/defaultRuntimeMode')]:
   with self.subTest(path=path):
    self.setUp()
    migrated=json.loads(json.dumps(self.FLEET_SETTINGS));migrated['projectSettingsSimplified']=True;edit(migrated)
    self.with_settings(self.FLEET_SETTINGS,migrated)
    with self.assertRaisesRegex(AssertionError,'User settings changed or disappeared'):self.execute()
    result=json.loads(self.output.read_text())
    self.assertEqual(result['result'],'update-failed');self.assertEqual(result['rollback'],'restored-runtime-pointers-and-state')
    self.assertIn(path,result['error']);self.assertNotIn('SHOULD-not-leak',result['error'])
    self.assertEqual(self.restores,[b'pre-update-state']);self.assertEqual(self.launchd,['bootout','bootstrap'])
    self.assertTrue(all(p.read_bytes()==value for p,value in self.original.items()))
 def test_without_a_settings_proof_any_settings_byte_change_rolls_back(self):
  self.after_mutation=lambda after:after['fileHashes'].update(settings='changed')
  with self.assertRaisesRegex(AssertionError,'User settings changed after restart'):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['rollback'],'restored-runtime-pointers-and-state');self.assertEqual(self.restores,[b'pre-update-state'])
 def test_environment_identity_and_launch_agent_stay_byte_exact_beside_a_settings_migration(self):
  migrated=dict(self.FLEET_SETTINGS,projectSettingsSimplified=True)
  for field,message in [('environment','Environment identity changed'),('plist','LaunchAgent changed')]:
   with self.subTest(field=field):
    self.setUp();self.with_settings(self.FLEET_SETTINGS,migrated);settings_change=self.after_mutation
    def change(after,field=field,settings_change=settings_change):
     settings_change(after);after['fileHashes'][field]='changed'
    self.after_mutation=change
    with self.assertRaisesRegex(AssertionError,message):self.execute()
    self.assertEqual(json.loads(self.output.read_text())['rollback'],'restored-runtime-pointers-and-state')
 def test_failed_state_restore_keeps_the_new_release_with_its_migrated_state(self):
  self.scenario='restore-failed';self.after_mutation=lambda after:after.update(archiveSha256='another-owned-release')
  with self.assertRaisesRegex(AssertionError,'intended artifact'):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['rollback'],'held-new-release-state-restore-failed');self.assertEqual(self.launchd,['bootout','bootstrap'])
  self.assertEqual(json.loads((self.own/'installation.json').read_text())['archiveSha256'],self.sha)
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
  self.assertEqual(result['phase'],'verified');self.assertEqual(len(self.restart_calls),1);self.assertEqual(self.launchd,[])
  # Counted from the apply's own first read: one check while staging, one after restart.
  self.assertEqual(result['appendedLogRows'],{'orchestration_events':2,'orchestration_command_receipts':2})
  self.assertEqual(self.events(state),['limit-check-staging','limit-check-after-restart'])
  self.assertEqual(result['after']['rows']['counts']['orchestration_events'],self.before['rows']['counts']['orchestration_events']+2)
  return result
 def test_waiting_thread_during_staging_and_restart_is_verified_and_kept(self):
  result=self.assert_waiting_thread_update_verified(allow_project_migrations=True)
  self.assertEqual(result['rowPreservation'],'verified-migration')
 def test_waiting_thread_is_also_carried_forward_without_migration_flags(self):
  result=self.assert_waiting_thread_update_verified()
  self.assertEqual(result['rowPreservation'],'verified-appended-activity');self.assertFalse(result['rowsByteIdentical'])
 def test_modified_row_during_staging_aborts_before_any_restart(self):
  state=self.use_waiting_state()
  self.on_stage=lambda:(waiting_check(state,'staging'),mutate_state(state,"UPDATE orchestration_events SET payload_json='edited' WHERE sequence=1"))
  with self.assertRaisesRegex(AssertionError,'Guarded prestate changed: rows'):self.execute(allow_project_migrations=True)
  self.assertEqual(self.restart_calls,[]);self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
 def test_deleted_row_during_staging_aborts_before_any_restart(self):
  state=self.use_waiting_state()
  self.on_stage=lambda:(waiting_check(state,'staging'),mutate_state(state,"DELETE FROM orchestration_v2_projection_messages WHERE thread_id='t-idle'"))
  with self.assertRaisesRegex(AssertionError,'Guarded prestate changed: rows'):self.execute(allow_project_migrations=True)
  self.assertEqual(self.restart_calls,[])
 def test_auth_change_during_staging_aborts_before_any_restart(self):
  state=self.use_waiting_state()
  self.on_stage=lambda:(waiting_check(state,'staging'),mutate_state(state,"UPDATE auth_sessions SET scopes='admin'"))
  with self.assertRaisesRegex(AssertionError,'Guarded prestate changed: rows'):self.execute(allow_project_migrations=True)
  self.assertEqual(self.restart_calls,[])
 def test_settings_change_during_staging_aborts_before_any_restart(self):
  state=self.use_waiting_state()
  def change():
   waiting_check(state,'staging')
   self.before=copy.deepcopy(self.before);self.before['fileHashes']['settings']='changed'  # The live snapshot from here on.
  self.on_stage=change
  with self.assertRaisesRegex(AssertionError,'Guarded prestate changed: fileHashes'):self.execute(allow_project_migrations=True)
  self.assertEqual(self.restart_calls,[]);self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
 def test_history_edited_after_restart_rolls_back_to_the_backup(self):
  state=self.use_waiting_state()
  self.on_restart=lambda:(waiting_check(state,'after-restart'),mutate_state(state,"DELETE FROM orchestration_events WHERE sequence=2"))
  with self.assertRaisesRegex(AssertionError,'History'):self.execute(allow_project_migrations=True)
  result=json.loads(self.output.read_text());self.assertEqual(result['rollback'],'restored-runtime-pointers-and-state')
  self.assertEqual(self.restores,[b'pre-update-state'])
 def test_project_migrations_pass_in_one_apply_when_nothing_is_lost(self):
  self.migrate(lambda rows:None)
  self.execute(allow_project_migrations=True);result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['rowPreservation'],'verified-migration');self.assertEqual(self.launchd,[])
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
 def test_migration_and_heartbeat_together_keep_actual_hashes_and_witness(self):
  self.verify_migration_with_heartbeat(1)
 def test_migration_and_two_heartbeats_have_replayable_typed_witness(self):
  self.verify_migration_with_heartbeat(2)
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
 def test_waiting_migration_and_one_heartbeat_require_database_backed_replay(self):
  self.verify_waiting_migration_heartbeat(1)
 def test_waiting_migration_and_two_heartbeats_require_database_backed_replay(self):
  self.verify_waiting_migration_heartbeat(2)
 def test_migration_without_heartbeat_opt_in_rejects_a_real_reconnect(self):
  self.prepare_heartbeat()
  with self.assertRaisesRegex(AssertionError,'Auth changed'):self.execute(allow_project_migrations=True)
  self.assertEqual(json.loads(self.output.read_text())['result'],'update-failed')
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
 def test_migration_rejects_equal_count_credential_replacement(self):
  self.reject_migration_auth_change('UPDATE auth_sessions SET credential=?',(b'replaced-private-credential',))
 def test_migration_rejects_blob_to_hex_text_with_identical_public_hash(self):
  self.reject_migration_auth_change('UPDATE auth_sessions SET credential=?',(b'private-credential'.hex(),))
  result=json.loads(self.output.read_text())
  self.assertEqual(result['before']['rows']['hashes']['auth_sessions'],result['attemptedAfter']['rows']['hashes']['auth_sessions'])
 def test_migration_rejects_equal_count_session_recreation(self):
  self.reject_migration_auth_change('UPDATE auth_sessions SET session_id=?',('replacement-session',))
 def test_migration_rejects_auth_deletion(self):
  self.reject_migration_auth_change('DELETE FROM auth_sessions')
 def test_migration_rejects_auth_growth_without_transformation_proof(self):
  self.reject_migration_auth_change("INSERT INTO auth_sessions SELECT 'added-session',method,client_surface,issued_at,expires_at,last_connected_at,revoked_at,credential FROM auth_sessions")
 def test_migration_rejects_schema_change_even_when_all_auth_rows_are_identical(self):
  self.reject_migration_auth_change('CREATE INDEX changed_auth_schema ON auth_sessions(method)')
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
 def test_a_startup_project_save_beside_a_browser_heartbeat_verifies(self):
  state=self.use_captured_heartbeat_state();self.restart_with_project_save_and_heartbeat(state)
  self.execute(allow_existing_browser_heartbeat=True);result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(len(self.restart_calls),1)
  self.assertEqual(result['rowPreservation'],'verified-appended-activity-and-heartbeat')
  self.assertEqual(result['completeDatabaseContinuity'],'verified')
  self.assertEqual(result['appendedLogRows'],{'orchestration_events':1,'orchestration_command_receipts':1})
  self.assertEqual(result['authHeartbeatWitness']['changedRows'],1)
  self.assertNotEqual(result['before']['rows']['hashes']['auth_sessions'],result['after']['rows']['hashes']['auth_sessions'])
  self.assertNotIn('private-session',self.output.read_text()+self.stdout.getvalue());self.assertNotIn('private-credential',self.output.read_text()+self.stdout.getvalue())
 def test_a_startup_project_save_alone_still_verifies_with_the_heartbeat_opt_in(self):
  state=self.use_captured_heartbeat_state();self.restart_with_project_save_and_heartbeat(state)
  restart=self.on_restart
  def without_reconnect():
   db=sqlite3.connect(state/'statev2.sqlite');before=db.execute('SELECT last_connected_at FROM auth_sessions').fetchone()[0];db.close()
   restart();mutate_state(state,"UPDATE auth_sessions SET last_connected_at='%s'"%before)
  self.on_restart=without_reconnect
  self.execute(allow_existing_browser_heartbeat=True);result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['rowPreservation'],'verified-appended-activity')
  self.assertNotIn('authHeartbeatWitness',result)
 def reject_save_and_heartbeat(self,*statements,pattern='',**flags):
  state=self.use_captured_heartbeat_state();self.restart_with_project_save_and_heartbeat(state,*statements)
  with self.assertRaisesRegex(AssertionError,pattern):self.execute(**flags)
  result=json.loads(self.output.read_text())
  self.assertEqual(result['result'],'update-failed');self.assertEqual(result['rollback'],'restored-runtime-pointers-and-state')
  self.assertNotIn('authHeartbeatWitness',result);self.assertNotIn('private-credential',self.output.read_text()+self.stdout.getvalue())
 def test_a_heartbeat_never_excuses_an_edited_earlier_event_beside_a_project_save(self):
  self.reject_save_and_heartbeat("UPDATE orchestration_events SET payload_json='edited' WHERE sequence=1",pattern='Existing projects',allow_existing_browser_heartbeat=True)
 def test_a_project_save_never_excuses_a_changed_credential_beside_a_heartbeat(self):
  self.reject_save_and_heartbeat("UPDATE auth_sessions SET credential=X'7265706c61636564'",pattern='Existing projects',allow_existing_browser_heartbeat=True)
 def test_a_project_save_never_excuses_a_new_session_beside_a_heartbeat(self):
  self.reject_save_and_heartbeat("INSERT INTO auth_sessions SELECT 'added-session',method,client_surface,issued_at,expires_at,last_connected_at,revoked_at,credential FROM auth_sessions",
                                 pattern='Existing projects',allow_existing_browser_heartbeat=True)
 def test_a_project_save_never_excuses_an_unrelated_thread_beside_a_heartbeat(self):
  self.reject_save_and_heartbeat("UPDATE orchestration_v2_projection_threads SET payload_json='edited' WHERE thread_id='t-idle'",pattern='Existing projects',allow_existing_browser_heartbeat=True)
 def test_without_the_heartbeat_opt_in_the_reconnect_beside_a_project_save_still_fails(self):
  self.reject_save_and_heartbeat(pattern='Existing projects')
 def test_captured_migration_with_unchanged_typed_cells_verifies(self):
  self.use_captured_waiting_state("UPDATE auth_pairing_links SET credential=X'7365637265740001'")
  self.migrate_real();self.execute(allow_project_migrations=True);result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['rowPreservation'],'verified-migration')
  self.assertEqual(result['migrationProtectedCells'],'typed-verified')
  self.assertEqual(result['appendedLogRows'],{'orchestration_events':1,'orchestration_command_receipts':1})
 def test_migration_rejects_a_pairing_token_rewritten_as_its_hex_text(self):
  self.use_captured_waiting_state("UPDATE auth_pairing_links SET credential=X'7365637265740001'")
  result=self.reject_real_migration('UPDATE auth_pairing_links SET credential=lower(hex(credential))')
  # The legacy row hash writes a BLOB as its hex text, so only the typed check can tell them apart.
  self.assertEqual(result['before']['rows']['hashes']['auth_pairing_links'],result['attemptedAfter']['rows']['hashes']['auth_pairing_links'])
 def test_migration_rejects_an_earlier_event_rewritten_as_hex_text_beside_appended_rows(self):
  self.use_captured_waiting_state("UPDATE orchestration_events SET payload_json=X'7b7d' WHERE sequence=1")
  self.reject_real_migration('UPDATE orchestration_events SET payload_json=lower(hex(payload_json)) WHERE sequence=1')
 def test_migration_rejects_an_integer_cell_rewritten_as_text(self):
  self.use_captured_waiting_state('CREATE TABLE provider_session_runtime(provider, generation)',"INSERT INTO provider_session_runtime VALUES ('codex',7)")
  self.reject_real_migration("UPDATE provider_session_runtime SET generation='7'",pattern='changed during migration')
 def test_a_migration_may_create_the_auth_table(self):
  for flags in [{},{'allow_existing_browser_heartbeat':True}]:
   with self.subTest(**flags):
    self.setUp();self.use_captured_waiting_state('DROP TABLE auth_sessions')
    self.migrate_real('CREATE TABLE auth_sessions(session_id TEXT PRIMARY KEY, subject TEXT, last_connected_at TEXT, revoked_at TEXT)')
    self.execute(allow_project_migrations=True,**flags);result=json.loads(self.output.read_text())
    self.assertEqual(result['phase'],'verified');self.assertEqual(result['rowPreservation'],'verified-migration')
    self.assertNotIn('auth_sessions',result['before']['rows']['counts']);self.assertEqual(result['after']['rows']['counts']['auth_sessions'],0)
    self.assertNotIn('authHeartbeatWitness',result);self.tearDown()
 def test_a_migration_may_not_create_the_auth_table_holding_a_session(self):
  for flags in [{},{'allow_existing_browser_heartbeat':True}]:
   with self.subTest(**flags):
    self.setUp();self.use_captured_waiting_state('DROP TABLE auth_sessions')
    result=self.reject_real_migration('CREATE TABLE auth_sessions(session_id TEXT PRIMARY KEY, subject TEXT, last_connected_at TEXT, revoked_at TEXT)',
                                      "INSERT INTO auth_sessions VALUES ('planted','synthetic-private','2026-10-11T03:00:00Z',NULL)",
                                      pattern='auth table holding sessions',**flags)
    self.assertNotIn('authHeartbeatWitness',result);self.tearDown()
 def test_a_migration_may_create_an_empty_pairing_table_but_never_one_holding_a_credential(self):
  self.use_captured_waiting_state('DROP TABLE auth_pairing_links')
  self.migrate_real('CREATE TABLE auth_pairing_links(id TEXT, credential TEXT)')
  self.execute(allow_project_migrations=True);self.assertEqual(json.loads(self.output.read_text())['phase'],'verified')
  self.tearDown();self.setUp();self.use_captured_waiting_state('DROP TABLE auth_pairing_links')
  self.reject_real_migration('CREATE TABLE auth_pairing_links(id TEXT, credential TEXT)',
                             "INSERT INTO auth_pairing_links VALUES ('planted','synthetic-private-credential')",
                             pattern='created a session, pairing, provider or schedule table holding rows')
 def test_migration_rejects_swapped_pairing_column_names(self):
  self.use_captured_waiting_state()
  self.reject_real_migration('ALTER TABLE auth_pairing_links RENAME COLUMN id TO swapped',
                             'ALTER TABLE auth_pairing_links RENAME COLUMN credential TO id',
                             'ALTER TABLE auth_pairing_links RENAME COLUMN swapped TO credential',
                             pattern='columns changed during migration')
 def test_migration_rejects_a_cascading_foreign_key_on_a_protected_table(self):
  # Same columns, but a cascade lets an unnamed table's trigger rewrite the credential later.
  for action in ['ON UPDATE CASCADE','ON DELETE CASCADE']:
   with self.subTest(action=action):
    self.setUp();self.use_captured_waiting_state()
    self.reject_real_migration('CREATE TABLE evil(v TEXT PRIMARY KEY)',
                               'INSERT INTO evil SELECT credential FROM auth_pairing_links',
                               'CREATE TABLE auth_pairing_links_new(id TEXT, credential TEXT REFERENCES evil(v) %s)'%action,
                               'INSERT INTO auth_pairing_links_new SELECT * FROM auth_pairing_links',
                               'DROP TABLE auth_pairing_links',
                               'ALTER TABLE auth_pairing_links_new RENAME TO auth_pairing_links',
                               pattern='foreign keys changed during migration')
    self.tearDown()
 def test_migration_rejects_a_changed_protected_table_definition(self):
  # Same columns and no foreign key, but a rebuilt definition (here a CHECK) is refused.
  self.use_captured_waiting_state()
  self.reject_real_migration('CREATE TABLE auth_pairing_links_new(id TEXT, credential TEXT, CHECK (length(id) < 1000))',
                             'INSERT INTO auth_pairing_links_new SELECT * FROM auth_pairing_links',
                             'DROP TABLE auth_pairing_links',
                             'ALTER TABLE auth_pairing_links_new RENAME TO auth_pairing_links',
                             pattern='table definition changed during migration')
 def captured_schedule_state(self):
  return self.use_captured_waiting_state('DROP TABLE scheduled_tasks','CREATE TABLE scheduled_tasks(\n  id TEXT PRIMARY KEY,\n  title TEXT NOT NULL,\n  enabled INTEGER NOT NULL DEFAULT 1,\n  secret\n)',
                                         "INSERT INTO scheduled_tasks VALUES ('task-1','Nightly',1,X'7365637265740001'),('task-2','Weekly',0,NULL)")
 def test_migration_may_add_an_empty_column_to_a_protected_table(self):
  # Migration 066 (1.0.39): ALTER TABLE scheduled_tasks ADD COLUMN run_policy_json TEXT.
  self.captured_schedule_state()
  self.migrate_real('ALTER TABLE scheduled_tasks ADD COLUMN run_policy_json TEXT','ALTER TABLE scheduled_tasks ADD COLUMN note')
  self.execute(allow_project_migrations=True);result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['rowPreservation'],'verified-migration')
  self.assertEqual(result['migrationProtectedCells'],'typed-verified')
  self.assertEqual(result['migrationAddedColumns'],{'scheduled_tasks':['run_policy_json','note']})
 def test_an_added_column_never_excuses_a_changed_earlier_cell(self):
  for statement,pattern in [("UPDATE scheduled_tasks SET title='Edited' WHERE id='task-1'",'rows changed during migration'),
                            ("UPDATE scheduled_tasks SET secret=lower(hex(secret)) WHERE id='task-1'",'types changed during migration'),
                            ("DELETE FROM scheduled_tasks WHERE id='task-2'",'rows changed during migration'),
                            ("INSERT INTO scheduled_tasks(id,title) VALUES ('planted','Planted')",'rows changed during migration')]:
   with self.subTest(statement=statement):
    self.setUp();self.captured_schedule_state()
    self.reject_real_migration('ALTER TABLE scheduled_tasks ADD COLUMN run_policy_json TEXT',statement,pattern=pattern);self.tearDown()
 def test_migration_rejects_a_filled_or_constrained_new_protected_column(self):
  for statements,pattern in [(('ALTER TABLE scheduled_tasks ADD COLUMN run_policy_json TEXT',"UPDATE scheduled_tasks SET run_policy_json='{}' WHERE id='task-1'"),'filled a new column'),
                             (("ALTER TABLE scheduled_tasks ADD COLUMN run_policy_json TEXT DEFAULT '{}'",),'constraint or default'),
                             (("ALTER TABLE scheduled_tasks ADD COLUMN run_policy_json TEXT NOT NULL DEFAULT ''",),'constraint or default'),
                             (("ALTER TABLE scheduled_tasks ADD COLUMN run_policy_json TEXT CHECK (run_policy_json IS NULL)",),'table definition changed'),
                             (("ALTER TABLE scheduled_tasks ADD COLUMN owner TEXT REFERENCES projection_projects(project_id)",),'definition changed'),
                             (('ALTER TABLE auth_pairing_links ADD COLUMN scope TEXT',),None),
                             (('ALTER TABLE auth_sessions ADD COLUMN scope TEXT',),'auth sessions or history'),
                             (('ALTER TABLE orchestration_events ADD COLUMN extra TEXT',),'auth sessions or history')]:
   with self.subTest(statements=statements):
    self.setUp();self.captured_schedule_state()
    if pattern is None:
     # Pairing links widen like any other protected table, empty and unconstrained.
     self.migrate_real(*statements);self.execute(allow_project_migrations=True)
     self.assertEqual(json.loads(self.output.read_text())['migrationAddedColumns'],{'auth_pairing_links':['scope']})
    else:
     self.reject_real_migration(*statements,pattern=pattern)
    self.tearDown()
 def test_a_widened_migration_with_a_heartbeat_reads_back_with_its_captures(self):
  state=self.use_captured_heartbeat_state()
  self.restart_with_project_save_and_heartbeat(state,'ALTER TABLE scheduled_tasks ADD COLUMN run_policy_json TEXT')
  self.execute(allow_project_migrations=True,allow_existing_browser_heartbeat=True);result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['migrationAddedColumns'],{'scheduled_tasks':['run_policy_json']})
  before,after,witness=result['before']['rows'],result['after']['rows'],result['authHeartbeatWitness']
  captures={'before_capture':result['before']['databaseCapture'],'after_capture':result['after']['databaseCapture']}
  current=auth_heartbeat.read_auth_sessions(state,after)
  self.assertEqual(update.verify_migration_heartbeat_witness(before,after,witness,current,identity='m4',state=state,**captures),witness)
  with self.assertRaisesRegex(AssertionError,'History'):
   update.verify_migration_heartbeat_witness(before,after,witness,current,identity='m4',state=state)
  with self.assertRaisesRegex(AssertionError,'both database captures'):
   update.verify_migration_heartbeat_witness(before,after,witness,current,identity='m4',state=state,before_capture=captures['before_capture'])
 def test_an_unwidened_migration_capture_matches_a_plain_capture(self):
  # verify_update_database compares a later plain capture with the receipt's after capture.
  self.use_captured_waiting_state();self.migrate_real(check=False)
  self.execute(allow_project_migrations=True);result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertNotIn('widened',result['after']['databaseCapture'])
  self.assertNotIn('migrationAddedColumns',result)
 def test_migration_may_add_an_index_on_a_protected_table(self):
  self.use_captured_waiting_state()
  self.migrate_real('CREATE INDEX auth_pairing_links_by_id ON auth_pairing_links(id)')
  self.execute(allow_project_migrations=True);result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['migrationProtectedCells'],'typed-verified')
 def test_migration_rejects_a_trigger_that_would_plant_a_session_later(self):
  for target in ['auth_sessions','AUTH_PAIRING_LINKS','"scheduled_tasks"']:
   with self.subTest(target=target):
    self.setUp();self.use_captured_waiting_state()
    self.reject_real_migration("CREATE TRIGGER plant AFTER INSERT ON orchestration_events BEGIN DELETE FROM %s; END"%target,
                               pattern='trigger touching sessions')
    self.tearDown()
 def test_migration_may_add_a_project_cleanup_trigger(self):
  # Migration 062 adds triggers on projection_projects that clean a project_ table.
  self.use_captured_waiting_state()
  self.migrate_real('CREATE TABLE project_environment_preparations(project_id TEXT)',
                    'CREATE TRIGGER project_environment_preparations_removed AFTER DELETE ON projection_projects '
                    'BEGIN DELETE FROM project_environment_preparations WHERE project_id=OLD.project_id; END')
  self.execute(allow_project_migrations=True);result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['migrationProtectedCells'],'typed-verified')
 def test_a_migration_may_not_drop_the_auth_table(self):
  self.use_captured_waiting_state()
  self.reject_real_migration('DROP TABLE auth_sessions',pattern='disappeared during migration')
 def test_heartbeat_opt_in_without_an_auth_table_refuses_before_any_write(self):
  self.use_captured_waiting_state('DROP TABLE auth_sessions')
  with self.assertRaisesRegex(AssertionError,'(?i)auth'):self.execute(allow_existing_browser_heartbeat=True)
  self.assertEqual(self.restart_calls,[]);self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
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
 def test_migration_accepts_an_existing_desktop_app_reconnect(self):
  self.migrate_with_desktop_reconnect()
  self.execute(allow_project_migrations=True,allow_existing_browser_heartbeat=True);result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['rowPreservation'],'verified-migration')
  self.assertEqual([cell['kind'] for cell in result['authHeartbeatSessions']],['existing-desktop-app-session'])
  self.assertEqual(result['authHeartbeatWitness']['migrationTypedAuth']['schemaVersion'],1)
  self.assertNotIn('private-desktop',self.output.read_text());self.assertNotIn('private-credential',self.output.read_text())
 def test_migration_desktop_reconnect_never_covers_a_hex_alias_of_a_token(self):
  for target in ['private-desktop','private-session']:
   with self.subTest(target=target):
    self.setUp();self.migrate_with_desktop_reconnect("UPDATE auth_sessions SET credential=lower(hex(credential)) WHERE session_id='%s'"%target)
    with self.assertRaisesRegex(AssertionError,'Heartbeat changed another auth cell'):
     self.execute(allow_project_migrations=True,allow_existing_browser_heartbeat=True)
    result=json.loads(self.output.read_text());self.assertEqual(result['rollback'],'restored-runtime-pointers-and-state')
    self.assertNotIn('authHeartbeatWitness',result);self.tearDown()
 def test_strict_apply_still_rejects_migrated_rows(self):
  self.migrate(lambda rows:None)
  with self.assertRaises(AssertionError):self.execute()
  self.assertEqual(json.loads(self.output.read_text())['rollback'],'restored-runtime-pointers-and-state')
 def test_migrations_never_excuse_changed_history(self):
  self.migrate(lambda rows:rows['hashes'].update(orchestration_v2_events='e2'))
  with self.assertRaisesRegex(AssertionError,'History'):self.execute(allow_project_migrations=True)
  self.assertEqual(self.restores,[b'pre-update-state'])
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
 def test_a_connection_heartbeat_does_not_break_the_prestate(self):
  with tempfile.TemporaryDirectory() as tmp:
   state=pathlib.Path(tmp);before=self.snapshot(state)
   after=self.snapshot(state,"UPDATE auth_sessions SET last_connected_at='2026-10-11T03:58:00Z'")
   self.assertNotEqual(before['hashes']['auth_sessions'],after['hashes']['auth_sessions'])
   update.assert_prestate(self.prestate(before),self.prestate(after))
   self.assertTrue(update.same_guarded_rows(before,after))
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
  self.assertIn("assert same_guarded_rows(before['rows'], current_rows, current_carried), 'Native work changed before restart'",source)
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
class ReleasePolicyVersionTests(unittest.TestCase):
 def test_stable_1_x_follows_the_alpha_line_and_never_goes_back(self):
  import release_policy
  for previous,incoming in [('0.2.12','1.0.0'),('0.1.4','1.0.0'),('1.0.0','1.0.1'),('1.0.9','1.1.0'),('1.0.0','1.0.0')]:
   release_policy.validate_upgrade(previous,incoming)
  for previous,incoming in [('1.0.0','0.2.12'),('1.0.1','1.0.0'),('0.2.12','0.3.0'),('0.2.12','2.0.0'),('1.0.0','1.0.0-rc.1'),('1.0.0','01.0.0')]:
   with self.subTest(previous=previous,incoming=incoming),self.assertRaises(AssertionError):
    release_policy.validate_upgrade(previous,incoming)
if __name__=='__main__':unittest.main()
