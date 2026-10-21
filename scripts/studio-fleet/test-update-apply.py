#!/usr/bin/env python3
"""update.apply under test-update.py's ApplyRecovery harness, split from test-update.py: rollback
and recovery, guarded comparisons before and after the restart, heartbeats, migrations, waiting
threads and receipts. Pure temporary metadata, never production services."""
import contextlib,copy,datetime,importlib.util,json,os,pathlib,shlex,sqlite3,time,unittest
from unittest.mock import patch
import auth_heartbeat
import install_progress
import state_backup
import studio_paths
from launcher import legacy_runtime_path, runtime_path
spec=importlib.util.spec_from_file_location('apply_update_base',pathlib.Path(__file__).with_name('test-update.py'))
updater_base=importlib.util.module_from_spec(spec);spec.loader.exec_module(updater_base)
# The harness's own update.py module and fixtures, so a patch here reaches the apply it runs.
update,DISK,RESTART,REAL_ROWS_SNAPSHOT=updater_base.update,updater_base.DISK,updater_base.RESTART,updater_base.REAL_ROWS_SNAPSHOT
mutate_state,waiting_check=updater_base.mutate_state,updater_base.waiting_check
class ApplyRecoveryTests(updater_base.ApplyRecovery):
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
 def test_a_verified_update_installs_the_new_release_agent_and_names_the_result(self):
  with patch.object(update.update_request,'refresh_agent',return_value='busy') as refresh:self.execute()
  result=json.loads(self.output.read_text());self.assertEqual((result['phase'],result['updateAgent']),('verified','busy'))
  self.assertEqual(refresh.call_args.args,(self.home,'m4',studio_paths.releases_root(self.home)/self.sha[:20]))
 def test_a_mac_without_an_installed_agent_gets_none_from_the_update(self):
  self.execute();self.assertEqual(json.loads(self.output.read_text())['updateAgent'],'absent')
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
  self.assertEqual(result['pointers'],'new-release');self.assertEqual(self.launchd,RESTART);self.assertEqual(self.restores,[])
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
  self.assertEqual(self.launchd,RESTART)
  self.assertEqual(json.loads((self.own/'installation.json').read_text())['archiveSha256'],self.sha)
 def test_a_disk_too_full_for_the_backup_refuses_before_staging_pointers_or_a_stop(self):
  (self.own/'userdata/statev2.sqlite').write_bytes(b'x'*3000);(self.own/'userdata/statev2.sqlite-wal').write_bytes(b'x'*1000)
  measured=[]
  def usage(path):
   measured.append(path);return DISK(1<<40,(1<<40)-update.BACKUP_SPACE_MARGIN-3999,update.BACKUP_SPACE_MARGIN+3999)
  def never_opened(path):raise AssertionError('The live database was opened')
  with patch.object(update.shutil,'disk_usage',side_effect=usage),patch.object(update.live_database,'connect',side_effect=never_opened),patch.object(update.sqlite3,'connect',side_effect=never_opened):
   with self.assertRaisesRegex(AssertionError,r'^Not enough free disk space for the pre-update backup: needs 2\.1 GB, 2\.1 GB free$') as caught:self.execute()
  self.assertEqual(measured,[str(self.home/'.specwithcode')])  # backups/ is made by the first copy.
  self.assertEqual((self.stage_timeouts,self.restart_calls,self.backups,self.quiescence_checks,self.launchd,self.stops),([],[],[],[],[],[]))
  self.assertEqual({p:p.read_bytes() for p in self.original},self.original)
  self.assertFalse(self.output.exists());self.assertFalse((self.own/'owned-updates').exists());self.assertFalse((self.own/'updates'/update.INSTALL_GATE_FILE).exists())
  update.write_preflight_failure(self.output,'m4',caught.exception)
  failure=json.loads(self.output.read_text())
  self.assertEqual((failure['phase'],failure['pointers']),('preflight','unchanged'))
  self.assertEqual(failure['error'],'AssertionError: '+str(caught.exception))
  self.assertEqual(update.refusal_line('m4',caught.exception),'REFUSAL environment '+str(caught.exception))
 def test_old_state_copies_are_pruned_before_free_space_is_measured(self):
  root=studio_paths.backups_root(self.home);old=[]
  for day in (1,2,3):
   folder=root/('pre-abc123def456-2026100%dT000000Z-%s'%(day,'0'*32));folder.mkdir(parents=True);(folder/'statev2.sqlite').write_bytes(b'x')
   os.utime(folder,(time.time()-86400,)*2);old.append(folder)
  def usage(path):
   copies=len(list(root.iterdir()))
   return DISK(1<<40,0,(1<<40) if copies<=1 else 1<<20)  # Full until pruned.
  with patch.object(update.shutil,'disk_usage',side_effect=usage):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified')
  self.assertEqual(result['prunedStateBackups'],[old[0].name,old[1].name]);self.assertEqual(list(root.iterdir()),[old[2]])
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
  # The install gate's settle wait before the restart is time spent too.
  with self.assertRaisesRegex(AssertionError,'did not become ready within %d s'%(80-update.INSTALL_GATE_SETTLE_SECONDS)):self.execute()
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
 def test_a_daemon_band_service_is_reloaded_as_an_interactive_job(self):
  import plistlib
  original,loaded=self.daemon_band_service()
  self.execute();result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['serviceLaunchAgent'],'process-type-interactive-added')
  # kickstart would restart the job launchd already loaded; only bootout and bootstrap read the new key.
  self.assertEqual(self.launchd,['bootout','bootstrap']);self.assertEqual(self.stops,[100])
  self.assertTrue(all(call[1]!='kickstart' for call in self.restart_calls))
  self.assertEqual(loaded[0]['ProcessType'],'Interactive')
  self.assertEqual(plistlib.loads(self.plist.read_bytes()),{**plistlib.loads(original),'ProcessType':'Interactive'})
  self.assertEqual(self.plist.stat().st_mode&0o777,0o644)
  self.assertEqual((pathlib.Path(result['backup'])/'service.plist').read_bytes(),original)
 def test_an_interactive_service_keeps_its_launch_agent(self):
  # Restarted through bootout and bootstrap like every service now (the copy is taken while it is
  # unloaded), from the same file: kickstart -k would leave launchd free to start it mid-copy.
  import plistlib
  self.plist.write_bytes(plistlib.dumps({'Label':'com.specweave.studio.m4','ProcessType':'Interactive'}))
  self.before['fileHashes']['plist']=update.digest(self.plist.read_bytes());unchanged=self.plist.read_bytes()
  self.execute();result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertNotIn('serviceLaunchAgent',result)
  self.assertEqual([call[1] for call in self.restart_calls],['bootstrap']);self.assertEqual(self.launchd,RESTART)
  self.assertEqual(self.stops,[100]);self.assertEqual(self.plist.read_bytes(),unchanged)
 def test_a_refused_rewritten_launch_agent_loads_the_original_again(self):
  original,loaded=self.daemon_band_service(refuse_rewritten=True)
  with self.assertRaisesRegex(AssertionError,'Owned operation failed'):self.execute()
  # The job is never left unloaded: the original file is back and bootstrapped.
  self.assertEqual(self.plist.read_bytes(),original);self.assertEqual(len(loaded),2)
  self.assertNotIn('ProcessType',loaded[1])
  self.assertEqual(json.loads(self.output.read_text())['result'],'update-failed')
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
  self.assertEqual(self.launchd,RESTART+['bootout','bootstrap'])
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
  self.assertEqual(self.launchd,RESTART);self.assertEqual(self.restores,[])
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
  self.assertEqual(result['rollback'],'held-for-safe-review');self.assertEqual(self.launchd,RESTART)
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
  self.assertEqual(self.stops,[100,101]);self.assertTrue(all(self.gate_readings))
  self.assertFalse((self.own/'updates'/update.INSTALL_GATE_FILE).exists())
 def test_a_refusal_before_the_restart_clears_the_install_gate(self):
  self.scenario='pre-restart-child'
  with self.assertRaises(AssertionError):self.execute()
  self.assertEqual(self.restart_calls,[]);self.assertFalse((self.own/'updates'/update.INSTALL_GATE_FILE).exists())
 def test_the_gate_settles_before_the_rows_are_compared_and_again_right_before_the_stop(self):
  # The old service notices a new gate only on its 5 s poll: a scheduler tick due just after
  # the gate was written still ran (M4, 1.0.43 -> 1.0.45). Two polls pass before the rows
  # are compared, and they are compared again right before the stop; the copy is taken once
  # the service is stopped and unloaded, before it is loaded again.
  steps,gate=self.record_pre_restart_steps()
  with gate:self.execute()
  self.assertEqual(json.loads(self.output.read_text())['phase'],'verified')
  self.assertEqual([name for name,_ in steps],['gate','rows','rows','bootout','backup','bootstrap'])
  self.assertGreaterEqual(steps[1][1]-steps[0][1],2*5)
  self.assertGreaterEqual(update.INSTALL_GATE_SETTLE_SECONDS,2*5)
 def test_a_scheduled_run_right_before_the_stop_stops_the_update_with_the_old_release_running(self):
  # The M4 rollback: the old service ran a due schedule while its state was copied. The copy
  # now waits for the stop, and a write the old service makes up to it (here while its server
  # browser stops, the step before the last check) stops the update with the old release running.
  guard=self.quiescence_guard
  def browser_stop_while_a_schedule_runs(*args,**kwargs):
   value=guard(*args,**kwargs)
   self.rows=copy.deepcopy(self.rows);self.rows['hashes']['scheduled_tasks']='old-service-ran-a-due-task'
   return value
  self.quiescence_guard=browser_stop_while_a_schedule_runs
  with patch.object(update,'assert_quiescence',side_effect=lambda *a,**k:self.quiescence_guard(*a,**k)),self.assertRaisesRegex(AssertionError,'Native work changed before restart'):
   self.execute()
  self.assertEqual(self.restart_calls,[]);self.assertEqual(self.backups,[]);self.assertEqual(self.launchd,[])
  self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
  self.assertFalse((self.own/'updates'/update.INSTALL_GATE_FILE).exists())
  result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'pointers-written');self.assertEqual(result['pointers'],'previous-release')
  self.assertEqual(result['rollback'],'restored-exact-owned-runtime-pointers')
  # A refusal the update agent retries (update_agent_recovery.refused_before_restart).
  self.assertIn('Native work changed before restart',result['error'])
  for key in ('restartStartedAt','stateBackup','rollbackError'):self.assertNotIn(key,result)
 def test_a_run_the_old_service_started_as_the_gate_was_written_stops_the_update_before_the_backup(self):
  real=update.write_install_gate
  def gate_with_a_run_in_flight(own,home):
   real(own,home);self.rows=copy.deepcopy(self.rows);self.rows['hashes']['scheduled_tasks']='run-started-before-the-poll'
  with patch.object(update,'write_install_gate',side_effect=gate_with_a_run_in_flight):
   with self.assertRaisesRegex(AssertionError,'Native work changed before restart'):self.execute()
  self.assertEqual(self.restart_calls,[]);self.assertEqual(self.backups,[])
  self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
  self.assertFalse((self.own/'updates'/update.INSTALL_GATE_FILE).exists())
  result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'pointers-written');self.assertNotIn('restartStartedAt',result)
 def test_a_service_launchd_restarted_before_the_stop_stops_the_update_before_the_restart(self):
  # Restarted on its own after the pointers moved, the service is already the new release.
  guard=self.quiescence_guard
  def launchd_restarts_after_the_browser_stop(*args,**kwargs):
   value=guard(*args,**kwargs);self.restarted=True;return value
  self.quiescence_guard=launchd_restarts_after_the_browser_stop
  with patch.object(update,'assert_quiescence',side_effect=lambda *a,**k:self.quiescence_guard(*a,**k)),self.assertRaisesRegex(AssertionError,'restarted on its own'):
   self.execute()
  self.assertEqual(self.restart_calls,[]);self.assertEqual(self.backups,[]);self.assertEqual(self.launchd,[])
  result=json.loads(self.output.read_text())
  for key in ('restartStartedAt','stateBackup'):self.assertNotIn(key,result)
 def test_a_copy_that_fails_while_stopped_starts_the_old_release_again(self):
  # Nothing of the new release has run: its pointers go back, then the old job is loaded again.
  self.failing_copy(OSError(28,'No space left on device'))
  with self.assertRaises(OSError):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual((result['phase'],result['pointers'],result['rollback']),('pointers-written','previous-release','restored-exact-owned-runtime-pointers'))
  self.assertNotIn('rollbackError',result);self.assertEqual(self.backups,['old-source'])
  self.assertEqual(self.restart_calls,[]);self.assertEqual(self.launchd,RESTART);self.assertTrue(self.loaded)
  self.assertFalse(self.restarted)
  self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
  self.assertFalse((self.own/'updates'/update.INSTALL_GATE_FILE).exists())
 def test_too_little_time_left_at_the_final_check_refuses_before_the_stop(self):
  # The re-reads before the restart ran long: stopping now would leave readiness no time, so the
  # update refuses with the old service running instead of a stop, migration and forced rollback.
  guard=self.quiescence_guard
  def slow_browser_stop(*args,**kwargs):
   value=guard(*args,**kwargs)
   self.clock[0]+=update.READY_BY_SECONDS_FROM_START-update.MIN_READINESS_SECONDS-update.INSTALL_GATE_SETTLE_SECONDS
   return value
  self.quiescence_guard=slow_browser_stop
  with patch.object(update,'assert_quiescence',side_effect=lambda *a,**k:self.quiescence_guard(*a,**k)),\
    self.assertRaisesRegex(AssertionError,'^'+update.TOO_SLOW_TO_RESTART+'$'):self.execute()
  self.assertEqual((self.backups,self.launchd,self.stops,self.restart_calls),([],[],[],[]))
  result=json.loads(self.output.read_text())
  self.assertEqual((result['phase'],result['pointers'],result['rollback']),('pointers-written','previous-release','restored-exact-owned-runtime-pointers'))
  self.assertNotIn('serviceStopped',result)
  self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
 def test_a_stop_that_fails_never_starts_the_new_release(self):
  def stop_times_out(pid,*,port=8319):self.stops.append(pid);raise AssertionError('Owned service did not stop for the state restore')
  self.wait_for_stopped=stop_times_out
  with patch.object(update,'wait_for_stopped',side_effect=lambda *a,**k:self.wait_for_stopped(*a,**k)),self.assertRaisesRegex(AssertionError,'did not stop'):
   self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual((result['pointers'],result['rollback']),('previous-release','restored-exact-owned-runtime-pointers'))
  self.assertEqual(self.backups,[]);self.assertEqual(self.restart_calls,[]);self.assertEqual(self.launchd,RESTART)
  self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
 def test_a_restart_launchd_refuses_starts_the_old_release_again(self):
  # The copy exists but the new release never ran: the old one starts on the untouched database.
  self.scenario='restart-failed'
  with self.assertRaisesRegex(AssertionError,'rejected restart'):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual((result['pointers'],result['rollback']),('previous-release','restored-exact-owned-runtime-pointers'))
  self.assertEqual(self.launchd,RESTART+['bootstrap']);self.assertTrue(self.loaded);self.assertEqual(self.restores,[])
 def test_the_unused_copy_goes_only_once_the_old_release_is_loaded_again(self):
  self.scenario='restart-failed';discarded=[]
  def discard(backup):
   self.assertTrue(self.loaded,'The copy must outlive an unloaded job');discarded.append(backup)
  with patch.object(update,'discard_unused_backup',side_effect=discard),self.assertRaisesRegex(AssertionError,'rejected restart'):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(discarded,[self.home/'state-backup.sqlite']);self.assertTrue(result['stateBackupDiscarded'])
  self.assertNotIn('stateBackup',result);self.assertTrue(result['serviceStopped'])
 def test_a_launcher_that_cannot_be_put_back_keeps_the_copy_and_names_it(self):
  # The disk filled after the copy: the old launcher cannot be written back, so the job stays
  # unloaded, and its next start runs the new release on this database: the copy must stay.
  self.scenario='restart-failed';real=update.atomic
  def failing(path,content,mode):
   if path==self.own/'launch.sh' and content==self.original[path]:raise OSError(28,'No space left on device')
   return real(path,content,mode)
  with patch.object(update,'atomic',side_effect=failing),patch.object(update,'discard_unused_backup') as discard,\
    self.assertRaisesRegex(AssertionError,'rejected restart'):self.execute()
  result=json.loads(self.output.read_text())
  discard.assert_not_called();self.assertEqual(self.launchd,RESTART);self.assertFalse(self.loaded)
  self.assertEqual((result['stateBackup'],result['stateBackupKept']),(str(self.home/'state-backup.sqlite'),'launcher-names-the-new-release'))
  self.assertTrue((self.home/'state-backup.sqlite').exists());self.assertIn('rollbackError',result)
 def test_a_bootout_that_leaves_the_old_service_running_is_a_refusal_not_a_restart(self):
  seen=[];real=self.transport
  def bootout_fails(command,**kwargs):
   if command[:2]==['/bin/launchctl','bootout']:
    seen.append(json.loads(self.output.read_text()));raise AssertionError('launchctl bootout timed out')
   return real(command,**kwargs)
  self.transport=bootout_fails
  with patch.object(update,'run',side_effect=lambda *a,**k:self.transport(*a,**k)),self.assertRaisesRegex(AssertionError,'bootout timed out'):self.execute()
  # Written before the stop, so a helper that dies during it leaves a receipt that says so.
  self.assertEqual((seen[0]['phase'],seen[0]['stopAttempted']),('pointers-written',True));self.assertNotIn('serviceStopped',seen[0])
  result=json.loads(self.output.read_text())
  self.assertNotIn('serviceStopped',result);self.assertTrue(self.loaded);self.assertEqual(self.launchd,[])
  self.assertEqual(install_progress.result_of(result),'refused')
  self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
 def test_the_install_gate_names_this_helper_and_when_it_was_written(self):
  seen=[]
  def at_restart():seen.append(json.loads((self.own/'updates'/update.INSTALL_GATE_FILE).read_text()))
  self.on_restart=at_restart;self.execute()
  self.assertEqual(seen[0]['helperPid'],os.getpid())
  written=datetime.datetime.fromisoformat(seen[0]['at'])
  self.assertLess(abs((datetime.datetime.now(datetime.timezone.utc)-written).total_seconds()),60)
  self.assertEqual(oct((self.own/'updates').stat().st_mode&0o777),'0o700')
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
 def test_a_client_reconnecting_while_the_gate_settles_is_a_proven_heartbeat(self):
  # M1, 1.0.49: M4's relay reconnected after the snapshot but before the restart began.
  self.prepare_heartbeat();advance=self.on_restart;self.on_restart=lambda:None
  for rows in (self.rows,self.before['rows']):rows[update.AUTH_INVARIANT_KEY]='i'*64
  real=update.write_install_gate
  def gate_then_reconnect(own,home):real(own,home);advance();self.rows[update.AUTH_INVARIANT_KEY]='i'*64
  with patch.object(update,'write_install_gate',side_effect=gate_then_reconnect):self.execute(True)
  result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['authHeartbeatWitness']['changedRows'],1)
  self.assertEqual(len(self.restart_calls),1)
 def test_a_reconnect_while_the_baseline_is_read_still_opens_the_window_at_the_read(self):
  # The read is not instant (process inventory first): a heartbeat inside it is the baseline.
  self.prepare_heartbeat();advance=self.on_restart
  for rows in (self.rows,self.before['rows']):rows[update.AUTH_INVARIANT_KEY]='i'*64
  real=self.snapshot_since;calls=[]
  def reconnect_then_read(*args,**kwargs):
   if not calls:
    advance();self.rows[update.AUTH_INVARIANT_KEY]='i'*64
    self.before['rows']=copy.deepcopy(self.rows)
   calls.append(1);return real(*args,**kwargs)
  self.snapshot_since=reconnect_then_read
  def restart():advance();self.rows[update.AUTH_INVARIANT_KEY]='i'*64
  self.on_restart=restart
  self.execute(True);result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['authHeartbeatWitness']['changedRows'],1)
 def test_the_heartbeat_window_starts_at_the_read_whatever_the_rows_say(self):
  auth={'columns':['session_id','last_connected_at'],'rows':[
   ['during','2026-10-18T19:54:02.500Z'],['future','2026-10-18T20:04:01.000Z'],['old','2026-10-18T03:11:11.377Z'],['odd',None]]}
  opened,closed='2026-10-18T19:54:01+00:00','2026-10-18T19:54:03+00:00'
  # A heartbeat stamped during the read moves the start up to it; one stamped after the
  # read (a clock that stepped back) and unreadable values never move it past the read.
  self.assertEqual(update.heartbeat_window_start(opened,closed,auth),'2026-10-18T19:54:02.500000+00:00')
  self.assertEqual(update.heartbeat_window_start(opened,closed,{**auth,'rows':auth['rows'][1:]}),opened)
  self.assertEqual(update.heartbeat_window_start(opened,closed,None),opened)
 def test_a_reconnect_during_the_gate_settle_is_proven_on_a_migrating_install(self):
  self.prepare_heartbeat();advance=self.on_restart
  self.rows['counts']['projection_projects']=1;self.rows['hashes']['projection_projects']='before-projection'
  for rows in (self.rows,):rows[update.AUTH_INVARIANT_KEY]='i'*64
  self.before['rows']=copy.deepcopy(self.rows)
  real=update.write_install_gate
  def gate_then_reconnect(own,home):real(own,home);advance();self.rows[update.AUTH_INVARIANT_KEY]='i'*64
  def restart():self.rows['hashes']['projection_projects']='rebuilt-projection'
  self.on_restart=restart
  with patch.object(update,'write_install_gate',side_effect=gate_then_reconnect):
   self.execute(allow_project_migrations=True,allow_existing_browser_heartbeat=True)
  result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['rowPreservation'],'verified-migration')
  self.assertEqual(result['authHeartbeatWitness']['changedRows'],1)
 def test_opt_in_never_relaxes_pre_restart_rows(self):
  self.prepare_heartbeat();self.scenario='pre-restart-heartbeat'
  with self.assertRaisesRegex(AssertionError,'before restart'):self.execute(True)
  self.assertEqual(self.restart_calls,[]);self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
 def test_a_cli_session_reconnecting_before_the_restart_refuses_without_restarting(self):
  # The proof after the restart rejects a CLI session and would roll the update back.
  with self.assertRaisesRegex(AssertionError,'Native work changed before restart: auth'):
   self.reconnect_before_restart('bearer-access-token','cli',allow_existing_browser_heartbeat=True)
  self.assert_refused_before_restart('Native work changed before restart: auth')
 def test_a_phone_app_reconnecting_before_the_restart_is_proven_and_installs(self):
  self.reconnect_before_restart('dpop-access-token','mobile',allow_existing_browser_heartbeat=True)
  result=json.loads(self.output.read_text())
  self.assertEqual((result['phase'],result['authHeartbeatWitness']['changedRows']),('verified',1))
  self.assertEqual([cell['kind'] for cell in result['authHeartbeatSessions']],['existing-mobile-app-session'])
  self.assertEqual(len(self.restart_calls),1)
 def test_a_desktop_app_reconnecting_before_the_restart_is_proven_and_installs(self):
  self.reconnect_before_restart('bearer-access-token','desktop',allow_existing_browser_heartbeat=True)
  result=json.loads(self.output.read_text())
  self.assertEqual((result['phase'],result['authHeartbeatWitness']['changedRows']),('verified',1))
  self.assertEqual(len(self.restart_calls),1)
 def test_a_reconnect_between_the_rows_read_and_the_auth_proof_is_proven_not_refused(self):
  # The proof reads the auth cells with their own hash, so a client connecting again after the
  # rows were read is proven like the first reconnect instead of refusing as a changed read.
  self.prepare_heartbeat();advance=self.on_restart;self.on_restart=lambda:None
  for rows in (self.rows,self.before['rows']):rows[update.AUTH_INVARIANT_KEY]='i'*64
  real_gate,real_rows,reads=update.write_install_gate,self.rows_since,[]
  def gate_then_reconnect(own,home):real_gate(own,home);advance();self.rows[update.AUTH_INVARIANT_KEY]='i'*64
  def read_then_reconnect(state,expected_rows):
   value=real_rows(state,expected_rows);reads.append(value)
   while len(reads)==1 and self.rows['hashes']['auth_sessions']==value[0]['hashes']['auth_sessions']:advance()
   self.rows[update.AUTH_INVARIANT_KEY]='i'*64
   return value
  self.rows_since=read_then_reconnect
  with patch.object(update,'write_install_gate',side_effect=gate_then_reconnect):self.execute(True)
  result=json.loads(self.output.read_text())
  self.assertEqual((result['phase'],result['authHeartbeatWitness']['changedRows']),('verified',1))
  self.assertEqual((len(reads),len(self.restart_calls)),(2,1))
 def test_without_the_heartbeat_proof_any_reconnect_refuses_before_the_restart(self):
  # Auth stays byte-exact through the restart then, so a reconnect would only roll it back.
  with self.assertRaisesRegex(AssertionError,'Native work changed before restart'):
   self.reconnect_before_restart('bearer-access-token','desktop')
  self.assert_refused_before_restart('Native work changed before restart')
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
  self.assertEqual(self.backups,['old-source']);self.assertEqual(self.stops,[100,101]);self.assertEqual(self.restores,[b'pre-update-state'])
  self.assertEqual(self.launchd,RESTART+['bootout','bootstrap']);self.assertEqual(len(self.restart_calls),1)
  self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
 def test_a_one_time_settings_migration_on_start_is_verified_and_kept(self):
  # 1.0.30+ adds projectSettingsSimplified and drops p2's override equal to the app value.
  migrated=json.loads(json.dumps(self.FLEET_SETTINGS));migrated['projectSettingsSimplified']=True;del migrated['projectSettingsOverrides']['p2']
  self.with_settings(self.FLEET_SETTINGS,migrated)
  self.execute();result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(self.restores,[]);self.assertEqual(self.launchd,RESTART)
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
    self.assertEqual(self.restores,[b'pre-update-state']);self.assertEqual(self.launchd,RESTART+['bootout','bootstrap'])
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
  self.assertEqual(result['rollback'],'held-new-release-state-restore-failed');self.assertEqual(self.launchd,RESTART+['bootout','bootstrap'])
  self.assertEqual(json.loads((self.own/'installation.json').read_text())['archiveSha256'],self.sha)
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
  self.assertFalse((self.own/'owned-updates').exists())  # The backup folder follows the prestate check.
  # The check follows publishing, so the release stays, inert: no pointer names it, and the retry reuses it.
  release=self.home/'.specwithcode/install/releases'/self.sha[:20];self.assertTrue((release/'studio-manifest.json').is_file())
  self.assertTrue(all(str(release) not in value.decode() for value in self.original.values()))
  inode,published,publish=release.stat().st_ino,[],update.publish_release
  def reused(staged,destination):published.append(destination.exists());return publish(staged,destination)
  self.on_stage=None;self.before['rows']=REAL_ROWS_SNAPSHOT(state)  # The retry's fresh prestate.
  with patch.object(update,'publish_release',side_effect=reused):self.execute(allow_project_migrations=True)
  self.assertEqual(json.loads(self.output.read_text())['phase'],'verified');self.assertEqual(published,[True])
  self.assertEqual(release.stat().st_ino,inode);self.assertEqual(json.loads((self.own/'installation.json').read_text())['release'],str(release))
 def test_deleted_row_during_staging_aborts_before_any_restart(self):
  state=self.use_waiting_state()
  self.on_stage=lambda:(waiting_check(state,'staging'),mutate_state(state,"DELETE FROM orchestration_v2_projection_messages WHERE thread_id='t-idle'"))
  with self.assertRaisesRegex(AssertionError,'Guarded prestate changed: rows'):self.execute(allow_project_migrations=True)
  self.assertEqual(self.restart_calls,[])
  self.assertFalse((self.own/'owned-updates').exists())  # The backup folder follows the prestate check.
 def test_auth_change_during_staging_aborts_before_any_restart(self):
  state=self.use_waiting_state()
  self.on_stage=lambda:(waiting_check(state,'staging'),mutate_state(state,"UPDATE auth_sessions SET scopes='admin'"))
  with self.assertRaisesRegex(AssertionError,'Guarded prestate changed: rows'):self.execute(allow_project_migrations=True)
  self.assertEqual(self.restart_calls,[])
  self.assertFalse((self.own/'owned-updates').exists())  # The backup folder follows the prestate check.
 def test_settings_change_during_staging_aborts_before_any_restart(self):
  state=self.use_waiting_state()
  def change():
   waiting_check(state,'staging')
   self.before=copy.deepcopy(self.before);self.before['fileHashes']['settings']='changed'  # The live snapshot from here on.
  self.on_stage=change
  with self.assertRaisesRegex(AssertionError,'Guarded prestate changed: fileHashes'):self.execute(allow_project_migrations=True)
  self.assertEqual(self.restart_calls,[]);self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
  self.assertFalse((self.own/'owned-updates').exists())  # The backup folder follows the prestate check.
 def test_history_edited_after_restart_rolls_back_to_the_backup(self):
  state=self.use_waiting_state()
  self.on_restart=lambda:(waiting_check(state,'after-restart'),mutate_state(state,"DELETE FROM orchestration_events WHERE sequence=2"))
  with self.assertRaisesRegex(AssertionError,'History'):self.execute(allow_project_migrations=True)
  result=json.loads(self.output.read_text());self.assertEqual(result['rollback'],'restored-runtime-pointers-and-state')
  self.assertEqual(self.restores,[b'pre-update-state'])
 def test_project_migrations_pass_in_one_apply_when_nothing_is_lost(self):
  self.migrate(lambda rows:None)
  self.execute(allow_project_migrations=True);result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['rowPreservation'],'verified-migration');self.assertEqual(self.launchd,RESTART)
 def test_migration_and_heartbeat_together_keep_actual_hashes_and_witness(self):
  self.verify_migration_with_heartbeat(1)
 def test_migration_and_two_heartbeats_have_replayable_typed_witness(self):
  self.verify_migration_with_heartbeat(2)
 def test_waiting_migration_and_one_heartbeat_require_database_backed_replay(self):
  self.verify_waiting_migration_heartbeat(1)
 def test_waiting_migration_and_two_heartbeats_require_database_backed_replay(self):
  self.verify_waiting_migration_heartbeat(2)
 def test_migration_without_heartbeat_opt_in_rejects_a_real_reconnect(self):
  self.prepare_heartbeat()
  with self.assertRaisesRegex(AssertionError,'Auth changed'):self.execute(allow_project_migrations=True)
  self.assertEqual(json.loads(self.output.read_text())['result'],'update-failed')
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
 def test_an_unchanged_database_is_read_once_before_the_restart_and_once_after(self):
  # The watermark lets the before-read stand for the prestate check, the check after the gate
  # settles and the last check before the stop; the read after the restart always runs.
  self.use_captured_waiting_state();reads,counting=self.counted_full_reads()
  with counting:self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['completeDatabaseContinuity'],'verified')
  self.assertEqual(reads,[False,True]);self.assertEqual(self.reused,[False])
  self.assertIn('watermarkSkip',result['timings'])
 def test_reused_reads_give_the_same_receipt_as_full_reads(self):
  def receipt(watermark):
   self.setUp();self.use_captured_waiting_state();self.on_restart=lambda:waiting_check(self.own/'userdata','after-restart')
   with contextlib.ExitStack() as stack:
    if not watermark:stack.enter_context(patch.object(update.read_watermark.Watermark,'take',return_value=None))
    self.execute()
   value=json.loads(self.output.read_text());self.assertEqual(value['phase'],'verified')
   self.assertEqual(bool(self.reused),watermark)
   for key in ('timings','backup','restartStartedAt'):value.pop(key)
   value['after'].pop('observedAt')
   # Each run has its own temporary home, which the pointer files name: their hashes differ.
   value['after'].pop('fileHashes')
   return json.dumps(value,sort_keys=True,indent=1)
  self.assertEqual(receipt(True),receipt(False))
 def test_a_change_after_the_before_read_reads_in_full_until_one_matches(self):
  # Staging wrote (a usage-limit check): the prestate check and the check after the gate read
  # in full; nothing changed after that read, so the last check before the stop lets it stand.
  state=self.use_captured_waiting_state();self.on_stage=lambda:waiting_check(state,'staging')
  reads,counting=self.counted_full_reads()
  with counting:self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(self.reused,[])
  self.assertEqual(reads,[False,False,False,True])
  self.assertEqual(result['appendedLogRows'],{'orchestration_events':1,'orchestration_command_receipts':1})
 def test_a_write_right_before_the_stop_is_read_in_full_and_refused(self):
  state=self.use_captured_waiting_state();guard=self.quiescence_guard
  def browser_stop_while_the_project_changes(*args,**kwargs):
   value=guard(*args,**kwargs);mutate_state(state,"UPDATE projection_projects SET title='changed before the stop'");return value
  self.quiescence_guard=browser_stop_while_the_project_changes
  reads,counting=self.counted_full_reads()
  with counting,patch.object(update,'assert_quiescence',side_effect=lambda *a,**k:self.quiescence_guard(*a,**k)):
   with self.assertRaisesRegex(AssertionError,'changed before restart'):self.execute()
  self.assertEqual(reads,[False,False]);self.assertEqual((self.backups,self.launchd,self.restart_calls),([],[],[]))
  result=json.loads(self.output.read_text())
  self.assertEqual((result['phase'],result['rollback']),('pointers-written','restored-exact-owned-runtime-pointers'))
 def test_readiness_is_the_cheap_check_and_one_full_read_follows_however_long_it_takes(self):
  # M4, 1.0.65: each full read took about 90 s and the accepted one ended past the 300 s
  # deadline. The cheap check now finds the service ready; the full read then runs once,
  # even when it ends long after the deadline, and its proof decides as before.
  ready_at={}
  def answers(identity,old_pid,archive_sha,source_commit):
   ready_at.setdefault('restart',self.clock[0])
   if self.clock[0]-ready_at['restart']<290:raise AssertionError('not listening yet')
   return 101
  self.service_answers=answers
  real=self.snapshot_since;after_restart=[]
  def slow_full_read(identity,expected_rows,include_auth=False,widen_from=None):
   if self.restarted:after_restart.append(self.clock[0]);self.clock[0]+=200
   return real(identity,expected_rows,include_auth,widen_from)
  self.snapshot_since=slow_full_read
  self.execute();result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(len(after_restart),1)
  self.assertGreaterEqual(result['timings']['readinessCheap'],290*1000);self.assertEqual(result['timings']['readiness'],200*1000)
 def test_a_service_that_never_answers_still_gets_its_full_read_and_rolls_back_on_a_mismatch(self):
  self.service_answers=lambda *args:(_ for _ in ()).throw(AssertionError('not listening yet'))
  self.after_mutation=lambda after:after.update(archiveSha256='another-owned-release')
  with self.assertRaisesRegex(AssertionError,'intended artifact'):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['rollback'],'restored-runtime-pointers-and-state');self.assertEqual(self.restores,[b'pre-update-state'])
  self.assertGreaterEqual(result['timings']['readinessCheap'],update.READINESS_DEADLINE_SECONDS*1000)
 def test_a_volume_that_filled_since_staging_refuses_before_the_stop(self):
  calls=[]
  def usage(path):
   calls.append(path);return DISK(1<<40,0,(1<<40) if len(calls)==1 else state_backup.CLONE_HEADROOM_MIN-1)
  with patch.object(update.shutil,'disk_usage',side_effect=usage):
   with self.assertRaisesRegex(AssertionError,r'^Not enough free disk space for the pre-update backup: .*\(checked again before the service stops\)$'):self.execute()
  self.assertEqual(len(calls),2);self.assertEqual((self.backups,self.launchd,self.stops,self.restart_calls),([],[],[],[]))
  result=json.loads(self.output.read_text())
  self.assertEqual((result['phase'],result['pointers'],result['rollback']),('pointers-written','previous-release','restored-exact-owned-runtime-pointers'))
  self.assertTrue(all(path.read_bytes()==value for path,value in self.original.items()))
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
if __name__=='__main__':unittest.main()
