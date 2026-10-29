#!/usr/bin/env python3
"""state_backup_prune and its place in update.apply: older state copies are pruned after a verified
update exits, not before the free-space check; a shortfall still prunes before it refuses, and
copies a failed or hand-run update left are bounded before the next copy. Runs
under test-update.py's ApplyRecovery harness in temporary homes, never production services.

Run: cd scripts/studio-fleet && python3 -B test-state-backup-prune.py
"""
import contextlib,importlib.util,json,os,pathlib,re,subprocess,sys,tempfile,time,unittest,warnings
from unittest.mock import patch
import state_backup_prune
import release_retention
import studio_paths
from installation_descriptor import installation_lock
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('prune_update_base',HERE/'test-update.py')
updater_base=importlib.util.module_from_spec(spec);spec.loader.exec_module(updater_base)
update,DISK=updater_base.update,updater_base.DISK
DAY=86400
class StateBackupPrune(updater_base.ApplyRecovery):
 def setUp(self):
  super().setUp()
  self.root=studio_paths.backups_root(self.home)
  receipts=self.own/'updates'/'receipts';receipts.mkdir(parents=True)
  self.output=receipts/'update-0.1.0-20261025T000000Z.json'  # Where the update agent has the helper write it.
  def backup_state(own,commit):  # Like state_backup.clone_state: a new folder in the backups root.
   self.assertFalse(self.loaded,'State must be copied while the old service is stopped')
   folder=self.root/('pre-%s-20261025T000000Z-%s'%(commit[:12] if re.fullmatch('[a-f0-9]{40}',commit) else 'unknown','1'*32))
   folder.mkdir(parents=True);(folder/'statev2.sqlite').write_bytes(b'pre-update-state');self.backups.append(commit)
   return folder/'statev2.sqlite'
  self.backup_state=backup_state
 def old_copies(self,count,size=1):
  old=[]
  for day in range(1,count+1):
   folder=self.root/('pre-abc123def456-2026100%dT000000Z-%s'%(day,'0'*32));folder.mkdir(parents=True)
   with open(folder/'statev2.sqlite','wb') as handle:handle.truncate(size)  # Sparse: its size, not its blocks.
   os.utime(folder,(time.time()-DAY,)*2);old.append(folder)
   (self.output.parent/('update-old-%d.json'%day)).write_text(json.dumps({'phase':'verified','stateBackup':str(folder/'statev2.sqlite')}))
  return old
 def spawned(self,calls):
  def spawn(identity,home,receipt,script):
   calls.append({'args':(identity,home,receipt,script),'copies':sorted(p.name for p in self.root.iterdir())})
   return 'started'
  return patch.object(update.state_backup_prune,'spawn',side_effect=spawn)
 def test_a_verified_update_keeps_old_copies_until_it_exits_then_prunes_and_records_them(self):
  old=self.old_copies(2);measured=[];calls=[]  # What a verified update leaves: its copy and the newest older one.
  def usage(path):
   measured.append(sorted(p.name for p in self.root.iterdir()));return DISK(1<<40,0,1<<40)
  with patch.object(update.shutil,'disk_usage',side_effect=usage),self.spawned(calls):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual((result['phase'],result['prunedStateBackups'],result['stateBackupPrune']),('verified',[],'started'))
  self.assertEqual(measured[0],[p.name for p in old])  # The space check no longer waits for a prune.
  new=pathlib.Path(result['stateBackup']).parent
  self.assertEqual(len(calls),1);self.assertEqual(calls[0]['args'],('m4',self.home,self.output,pathlib.Path(update.__file__).resolve()))
  self.assertEqual(calls[0]['copies'],sorted([p.name for p in old]+[new.name]))  # Nothing deleted while the service was held.
  # What the started process does once this helper has exited and released the installation lock:
  removed=state_backup_prune.after_install('m4',self.home,self.output)
  self.assertEqual(sorted(removed),[p.name for p in old])
  self.assertEqual(sorted(p.name for p in self.root.iterdir()),[new.name])
  receipt=json.loads(self.output.read_text())
  self.assertEqual(sorted(receipt['prunedStateBackups']),[p.name for p in old])
  self.assertIsInstance(receipt['stateBackupPruneAfterInstall']['milliseconds'],int)
  self.assertEqual({key:value for key,value in receipt.items() if key not in ('prunedStateBackups','stateBackupPruneAfterInstall')},
                   {key:value for key,value in result.items() if key!='prunedStateBackups'})
  self.assertEqual([p.name for p in self.output.parent.iterdir() if p.name.startswith('.')],[])
 def test_a_shortfall_still_prunes_before_refusing(self):
  self.old_copies(2,3<<30);calls=[]
  with patch.object(update.shutil,'disk_usage',return_value=DISK(1<<40,0,1<<20)),self.spawned(calls):
   with self.assertRaisesRegex(AssertionError,r'free \(after removing 2 older update copies\)$'):self.execute()
  self.assertEqual(list(self.root.iterdir()),[])
  self.assertEqual((calls,self.stage_timeouts,self.restart_calls,self.backups,self.stops),([],[],[],[],[]))
  self.assertEqual({p:p.read_bytes() for p in self.original},self.original)
  self.assertFalse(self.output.exists())
 def test_a_shortfall_the_old_copies_cover_installs_and_records_them(self):
  old=self.old_copies(2,3<<30);calls=[]
  def usage(path):
   return DISK(1<<40,0,(1<<40) if not any(p.name.startswith('pre-abc') for p in self.root.iterdir()) else 1<<20)
  with patch.object(update.shutil,'disk_usage',side_effect=usage),self.spawned(calls):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(sorted(result['prunedStateBackups']),[p.name for p in old])
  self.assertEqual(len(calls),1)
 def test_a_shortfall_the_older_copies_cover_keeps_the_newest_older_one(self):
  old=self.old_copies(2,3<<30);calls=[]
  def usage(path):
   return DISK(1<<40,0,(1<<40) if not old[0].exists() else 1<<20)  # Full until the oldest copy goes.
  with patch.object(update.shutil,'disk_usage',side_effect=usage),self.spawned(calls):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(result['prunedStateBackups'],[old[0].name])
  self.assertTrue(old[1].is_dir())
 def test_a_refused_update_starts_no_prune_and_the_next_one_bounds_its_copies(self):
  old=self.old_copies(2);calls=[]
  self.scenario='pre-restart-active'
  with self.spawned(calls),self.assertRaises(AssertionError):self.execute()
  self.assertEqual(calls,[]);self.assertEqual(sorted(self.root.iterdir()),old)
  self.assertIsNone(state_backup_prune.after_install('m4',self.home,self.output))  # Not a verified receipt.
  self.assertEqual(sorted(self.root.iterdir()),old)
 def test_copies_failed_updates_left_are_pruned_before_the_next_copy(self):
  old=self.old_copies(4);measured=[];calls=[]  # Two failed attempts left their copies behind.
  def usage(path):
   measured.append(sorted(p.name for p in self.root.iterdir()));return DISK(1<<40,0,1<<40)
  with patch.object(update.shutil,'disk_usage',side_effect=usage),self.spawned(calls):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(sorted(result['prunedStateBackups']),[old[0].name,old[1].name])
  self.assertEqual(measured[0],[old[2].name,old[3].name])
 def test_a_helper_writing_outside_the_agent_receipts_prunes_before_the_copy(self):
  old=self.old_copies(3);self.output=self.home/'result.json'
  self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual((result['phase'],result['stateBackupPrune']),('verified','not-an-agent-receipt'))
  self.assertIsNone(state_backup_prune.after_install('m4',self.home,self.output))
  self.assertEqual([p for p in self.root.iterdir() if p in old],[old[2]])  # As before: the newest older copy stays.
 def verified_receipt(self,old):
  new=self.root/('pre-fedcba987654-20261025T000000Z-%s'%('1'*32));new.mkdir(parents=True);(new/'statev2.sqlite').write_bytes(b'x')
  self.output.write_text(json.dumps({'phase':'verified','before':{'identity':'m4'},'stateBackup':str(new/'statev2.sqlite'),'prunedStateBackups':[]}))
  return new
 def test_after_install_waits_for_the_helper_to_release_the_installation_lock(self):
  old=self.old_copies(3);new=self.verified_receipt(old)
  with contextlib.ExitStack() as held:
   held.enter_context(installation_lock(self.home))
   self.assertIsNone(state_backup_prune.after_install('m4',self.home,self.output,wait=0))
   self.assertEqual(len(list(self.root.iterdir())),4)
   sleeps=[]
   def sleep(seconds):sleeps.append(seconds);held.close()  # The helper exits.
   removed=state_backup_prune.after_install('m4',self.home,self.output,sleep=sleep)
  self.assertEqual(sleeps,[0.5]);self.assertEqual(sorted(removed),[p.name for p in old])
  self.assertEqual(sorted(p.name for p in self.root.iterdir()),[new.name])
 def test_after_install_keeps_a_copy_a_held_rollback_names(self):
  old=self.old_copies(3);new=self.verified_receipt(old)
  (self.output.parent/'update-0.0.9-20261001T000000Z.json').write_text(json.dumps({'rollback':'held-new-release-state-restore-failed','stateBackup':str(old[0]/'statev2.sqlite')}))
  self.assertEqual(state_backup_prune.after_install('m4',self.home,self.output),[old[1].name,old[2].name])
  self.assertEqual(sorted(p.name for p in self.root.iterdir()),sorted([old[0].name,new.name]))
 def test_finder_view_files_do_not_keep_a_copy_but_other_extras_and_links_do(self):
  old=self.old_copies(4);new=self.verified_receipt(old)
  (old[0]/'.DS_Store').write_bytes(b'Bud1');(old[1]/'notes.txt').write_text('added')
  os.symlink('statev2.sqlite',old[2]/'.DS_Store')  # A link is never Finder's.
  for folder in old[:3]:os.utime(folder,(time.time()-DAY,)*2)
  self.assertEqual(state_backup_prune.after_install('m4',self.home,self.output),[old[0].name,old[3].name])
  self.assertEqual(sorted(p.name for p in self.root.iterdir()),sorted([old[1].name,old[2].name,new.name]))
 def test_verified_recent_copy_goes_but_unfinished_other_identity_recovery_stays(self):
  old=self.old_copies(3);new=self.verified_receipt(old)
  remote=studio_paths.identity_home(self.home,'m3')/'updates'/'receipts';remote.mkdir(parents=True)
  (remote/'update-1.0.0.json').write_text(json.dumps({'phase':'restart-requested','rollbackError':'restore failed','stateBackup':str(old[0]/'statev2.sqlite')}))
  (self.output.parent/'update-0.0.9.json').write_text(json.dumps({'phase':'verified','stateBackup':str(old[1]/'statev2.sqlite')}))
  (self.output.parent/'update-old-3.json').unlink()
  for folder in old:os.utime(folder,None)
  # Only an explicitly finished receipt releases a recent copy. Unknown recent copies stay.
  self.assertEqual(state_backup_prune.after_install('m4',self.home,self.output),[old[1].name])
  self.assertTrue(old[0].is_dir() and old[2].is_dir() and new.is_dir())
 def test_unreadable_foreign_receipt_keeps_every_copy_and_legacy_alias_is_accepted(self):
  old=self.old_copies(2);new=self.verified_receipt(old)
  studio_paths.legacy_root(self.home).symlink_to(studio_paths.branded_root(self.home))
  remote=studio_paths.identity_home(self.home,'m3')/'updates'/'receipts';remote.mkdir(parents=True)
  broken=remote/'update-unfinished.json';broken.write_text('{partial')
  self.assertEqual(state_backup_prune.after_install('m4',self.home,self.output),[])
  self.assertTrue(all(p.is_dir() for p in old))
  broken.write_text('{}')
  self.assertEqual(state_backup_prune.after_install('m4',self.home,self.output),[p.name for p in old])
  self.assertTrue(new.is_dir())
 def test_foreign_or_symlink_backup_reference_never_authorizes_local_deletion(self):
  old=self.old_copies(2);new=self.verified_receipt(old)
  source=self.output.parent/'update-old-1.json'
  source.write_text(json.dumps({'phase':'verified','stateBackup':str(self.home/'outside'/old[0].name/'statev2.sqlite')}))
  self.assertEqual(state_backup_prune.after_install('m4',self.home,self.output),[])
  self.assertTrue(all(p.is_dir() for p in old))
  source.write_text(json.dumps({'phase':'verified','stateBackup':str(old[0]/'statev2.sqlite')}))
  outside=self.home/'unrelated.sqlite';outside.write_bytes(b'private')
  (old[0]/'statev2.sqlite').unlink();(old[0]/'statev2.sqlite').symlink_to(outside)
  self.assertEqual(state_backup_prune.after_install('m4',self.home,self.output),[])
  self.assertEqual(outside.read_bytes(),b'private')
  self.assertTrue(old[1].is_dir() and new.is_dir())
 def test_archived_links_hold_their_names_without_blocking_verified_local_pruning(self):
  old=self.old_copies(6);new=self.verified_receipt(old)
  archive_links=[]
  for folder in old[:4]:
   for entry in folder.iterdir():entry.unlink()
   folder.rmdir()
   destination='/Volumes/Offline Archive/Archive/specwithcode/db-backups-20261028/'+folder.name
   folder.symlink_to(destination);archive_links.append((folder,destination))
  # One local copy has no verified receipt and must stay, alongside the newest recovery copy.
  (self.output.parent/'update-old-6.json').unlink()
  self.assertEqual(state_backup_prune.after_install('m4',self.home,self.output),[old[4].name])
  self.assertTrue(new.is_dir() and old[5].is_dir())
  self.assertTrue(all(p.is_symlink() and os.readlink(p)==target for p,target in archive_links))
  held,finished=release_retention.state_backup_references(self.home)
  self.assertTrue({p.name for p,_ in archive_links}<=held)
  self.assertFalse({p.name for p,_ in archive_links}&finished)
 def test_unknown_directory_link_keeps_every_local_copy(self):
  old=self.old_copies(2);new=self.verified_receipt(old)
  for entry in old[0].iterdir():entry.unlink()
  old[0].rmdir();old[0].symlink_to(self.home/'unknown-archive')
  self.assertEqual(state_backup_prune.after_install('m4',self.home,self.output),[])
  self.assertTrue(old[0].is_symlink() and old[1].is_dir() and new.is_dir())
 def test_archive_link_with_different_backup_name_is_not_trusted(self):
  old=self.old_copies(2);new=self.verified_receipt(old)
  for entry in old[0].iterdir():entry.unlink()
  old[0].rmdir()
  old[0].symlink_to('/Volumes/Archive/Archive/specwithcode/db-backups-20261028/'+old[1].name)
  self.assertEqual(state_backup_prune.after_install('m4',self.home,self.output),[])
  self.assertTrue(old[1].is_dir() and new.is_dir())
class Spawn(unittest.TestCase):
 def setUp(self):
  # spawn never waits for its child to exit (it runs on after the helper): no warning for that here.
  self.warnings=warnings.catch_warnings();self.warnings.__enter__();warnings.simplefilter('ignore',ResourceWarning);self.addCleanup(self.warnings.__exit__,None,None,None)
  self.temp=tempfile.TemporaryDirectory(prefix='studio-prune-spawn-');self.home=pathlib.Path(self.temp.name).resolve()
  receipts=studio_paths.identity_home(self.home,'m4')/'updates'/'receipts';receipts.mkdir(parents=True)
  self.receipt=receipts/'update-1.0.0-20261025T000000Z.json';self.receipt.write_text('{}')
  self.record=self.home/'child.json'
 def tearDown(self):self.temp.cleanup()
 def child(self,body):
  script=self.home/'stand-in.py';script.write_text('import json,os,sys\n'+body);return script
 def test_spawn_waits_until_the_child_is_ready_and_runs_it_in_its_own_session(self):
  script=self.child('json.dump({"argv":sys.argv[1:],"sid":os.getsid(0),"cwd":os.getcwd()},open(%r,"w"))\n'
                    'sys.stdout.buffer.write(b"ready\\n");sys.stdout.flush()\n'%str(self.record))
  self.assertEqual(state_backup_prune.spawn('m4',self.home,self.receipt,script),'started')
  child=json.loads(self.record.read_text())
  self.assertEqual(child['argv'],['--identity','m4','--prune-state-backups',str(self.receipt)])
  self.assertNotEqual(child['sid'],os.getsid(0));self.assertEqual(child['cwd'],'/')
 def test_a_child_that_never_reports_ready_or_cannot_start_is_reported(self):
  self.assertEqual(state_backup_prune.spawn('m4',self.home,self.receipt,self.child('pass\n')),'not-ready')
  with patch.object(state_backup_prune.subprocess,'Popen',side_effect=PermissionError):
   self.assertEqual(state_backup_prune.spawn('m4',self.home,self.receipt,self.home/'missing.py'),'PermissionError')
  self.assertEqual(state_backup_prune.spawn('m4',self.home,self.home/'elsewhere.json',self.child('raise SystemExit\n')),'not-an-agent-receipt')
 def test_the_helper_entry_point_reports_ready_and_leaves_a_foreign_receipt_alone(self):
  # This user's real home, with an identity that has no receipts folder: after_install refuses it.
  value=subprocess.run([sys.executable,'-B',str(HERE/'update.py'),'--identity','pruneprobe','--prune-state-backups',str(self.receipt)],
                       stdin=subprocess.DEVNULL,capture_output=True,timeout=60)
  self.assertEqual((value.returncode,value.stdout),(0,b'ready\n'),value.stderr.decode()[-2000:])
  self.assertEqual(self.receipt.read_text(),'{}')
if __name__=='__main__':unittest.main()
