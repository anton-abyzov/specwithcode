#!/usr/bin/env python3
"""state_backup_prune and its place in update.apply: older state copies are pruned after a verified
update exits, not before the free-space check; a shortfall still prunes before it refuses, and
copies a failed or hand-run update left are bounded before the next copy. Runs
under test-update.py's ApplyRecovery harness in temporary homes, never production services.

Run: cd scripts/studio-fleet && python3 -B test-state-backup-prune.py
"""
import contextlib,datetime,importlib.util,sqlite3,json,os,pathlib,re,shutil,subprocess,sys,tempfile,time,unittest,warnings
from unittest.mock import patch
import state_backup_prune
import release_retention
import state_backup
import studio_paths
from installation_descriptor import installation_lock
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('prune_update_base',HERE/'test-update.py')
updater_base=importlib.util.module_from_spec(spec);spec.loader.exec_module(updater_base)
update,DISK=updater_base.update,updater_base.DISK
DAY=86400
def database(path):  # A whole SQLite file, as backup_state and clone_state leave the copy.
 connection=sqlite3.connect(str(path));connection.execute('create table t(x)');connection.commit();connection.close()
def proven(hours,**extra):  # A receipt update.py writes after a verified update, verified `hours` ago.
 at=datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(hours=hours)
 return {'phase':'verified','preservedRowsAuthAndIdentity':True,'originalServicesPreserved':True,
         'onlyKnownOwnedServiceRestarted':True,'verifiedAt':at.isoformat(),**extra}
class StateBackupPrune(updater_base.ApplyRecovery):
 def setUp(self):
  super().setUp()
  self.root=studio_paths.backups_root(self.home)
  receipts=self.own/'updates'/'receipts';receipts.mkdir(parents=True)
  self.output=receipts/'update-0.1.0-20261025T000000Z.json'  # Where the update agent has the helper write it.
  def backup_state(own,commit):  # Like state_backup.clone_state: a new folder in the backups root.
   self.assertFalse(self.loaded,'State must be copied while the old service is stopped')
   folder=self.root/('pre-%s-20261025T000000Z-%s'%(commit[:12] if re.fullmatch('[a-f0-9]{40}',commit) else 'unknown','1'*32))
   folder.mkdir(parents=True);database(folder/'statev2.sqlite');self.backups.append(commit)
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
  old=self.old_copies(1);measured=[];calls=[]  # What a verified update leaves: its own copy, nothing else.
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
 def test_a_shortfall_prunes_older_copies_but_keeps_the_newest_before_refusing(self):
  old=self.old_copies(2,3<<30);calls=[]
  with patch.object(update.shutil,'disk_usage',return_value=DISK(1<<40,0,1<<20)),self.spawned(calls):
   with self.assertRaisesRegex(AssertionError,r'needs [0-9.]+ GB, 0\.0 GB free$'):self.execute()
  # The newest older copy is the last valid rollback copy until a new one exists; it stays.
  self.assertEqual(sorted(self.root.iterdir()),[old[1]])
  self.assertEqual((calls,self.stage_timeouts,self.restart_calls,self.backups,self.stops),([],[],[],[],[]))
  self.assertEqual({p:p.read_bytes() for p in self.original},self.original)
  self.assertFalse(self.output.exists())
 def test_a_shortfall_only_the_newest_copy_would_cover_refuses_and_keeps_it(self):
  old=self.old_copies(1,3<<30);calls=[]
  def usage(path):
   return DISK(1<<40,0,(1<<40) if not old[0].exists() else 1<<20)  # Room only if the newest copy went.
  with patch.object(update.shutil,'disk_usage',side_effect=usage),self.spawned(calls):
   with self.assertRaises(AssertionError):self.execute()
  self.assertTrue(old[0].is_dir());self.assertEqual((calls,self.backups,self.stops),([],[],[]))
 def test_a_refused_update_starts_no_prune_and_the_next_one_bounds_its_copies(self):
  old=self.old_copies(2);calls=[]
  self.scenario='pre-restart-active'
  with self.spawned(calls),self.assertRaises(AssertionError):self.execute()
  # Only the previous update's copy stays before a copy; a refused update makes none of its own.
  self.assertEqual(calls,[]);self.assertEqual(sorted(self.root.iterdir()),old[1:])
  self.assertIsNone(state_backup_prune.after_install('m4',self.home,self.output))  # Not a verified receipt.
  self.assertEqual(sorted(self.root.iterdir()),old[1:])
 def test_copies_failed_updates_left_are_pruned_before_the_next_copy(self):
  old=self.old_copies(4);measured=[];calls=[]  # Two failed attempts left their copies behind.
  def usage(path):
   measured.append(sorted(p.name for p in self.root.iterdir()));return DISK(1<<40,0,1<<40)
  with patch.object(update.shutil,'disk_usage',side_effect=usage),self.spawned(calls):self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual(result['phase'],'verified');self.assertEqual(sorted(result['prunedStateBackups']),[p.name for p in old[:3]])
  self.assertEqual(measured[0],[old[3].name])
 def test_a_helper_writing_outside_the_agent_receipts_prunes_before_the_copy(self):
  old=self.old_copies(3);self.output=self.home/'result.json'
  self.execute()
  result=json.loads(self.output.read_text())
  self.assertEqual((result['phase'],result['stateBackupPrune']),('verified','not-an-agent-receipt'))
  self.assertIsNone(state_backup_prune.after_install('m4',self.home,self.output))
  self.assertEqual([p for p in self.root.iterdir() if p in old],[old[2]])  # As before: the newest older copy stays.
 def verified_receipt(self,old):
  new=self.root/('pre-fedcba987654-20261025T000000Z-%s'%('1'*32));new.mkdir(parents=True);database(new/'statev2.sqlite')
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
 def test_a_held_copy_goes_as_soon_as_a_later_update_of_its_identity_verifies(self):
  old=self.old_copies(3);new=self.verified_receipt(old)
  receipts=self.output.parent
  failed=receipts/'update-1.0.180-20261004T065947957939Z.json'
  failed.write_text(json.dumps({'phase':'restart-requested','rollback':'held-for-safe-review','rollbackError':'kept','stateBackup':str(old[0]/'statev2.sqlite')}))
  later=receipts/'update-1.0.186-20261004T154001941726Z.json'
  later.write_text(json.dumps({'phase':'restart-requested','stateBackup':str(old[1]/'statev2.sqlite')}))
  # A later update still in flight supersedes nothing: both its copy and the held one stay.
  self.assertEqual(release_retention.held_state_backups(self.own),[str(old[0]/'statev2.sqlite')])
  self.assertTrue({old[0].name,old[1].name}<=release_retention.state_backup_references(self.home)[0])
  later.write_text(json.dumps(proven(hours=0,stateBackup=str(old[1]/'statev2.sqlite'))))
  self.assertEqual(release_retention.held_state_backups(self.own),[])
  held,finished=release_retention.state_backup_references(self.home)
  self.assertNotIn(old[0].name,held);self.assertIn(old[0].name,finished)
  self.assertEqual(state_backup_prune.after_install('m4',self.home,self.output),[p.name for p in old])
  self.assertEqual(sorted(p.name for p in self.root.iterdir()),[new.name])
 def test_a_held_copy_stays_unless_a_later_update_of_its_identity_proved_completion(self):
  old=self.old_copies(2);new=self.verified_receipt(old)
  receipts=self.output.parent
  (receipts/'update-1.0.179-20261003T000000Z.json').write_text(json.dumps(proven(hours=72)))
  (receipts/'update-1.0.180-20261004T000000Z.json').write_text(json.dumps({'phase':'restart-requested','rollback':'held-for-safe-review','stateBackup':str(old[0]/'statev2.sqlite')}))
  remote=studio_paths.identity_home(self.home,'m3')/'updates'/'receipts';remote.mkdir(parents=True)
  (remote/'update-1.0.190-20261005T000000Z.json').write_text(json.dumps(proven(hours=72)))
  (receipts/'update-later.json').write_text(json.dumps(proven(hours=72)))
  for name,value in (('1.0.181-20261005T000000Z',dict(proven(hours=72),result='update-failed')),
                     ('1.0.182-20261006T000000Z',dict(proven(hours=72),onlyKnownOwnedServiceRestarted=False)),
                     ('1.0.183-20261007T000000Z',dict(proven(hours=72),verifiedAt='2026-10-07T00:00:00')),
                     ('1.0.184-20261008T000000Z',dict(proven(hours=72),verifiedAt='soon'))):
   (receipts/('update-%s.json'%name)).write_text(json.dumps(value))
  self.assertEqual(release_retention.held_state_backups(self.own),[str(old[0]/'statev2.sqlite')])
  self.assertEqual(state_backup_prune.after_install('m4',self.home,self.output),[old[1].name])
  self.assertTrue(old[0].is_dir() and new.is_dir())
 def test_superseded_receipts_needs_a_stamped_later_proof(self):
  held=pathlib.Path('update-1.0.1-20261001T000000Z.json');later=pathlib.Path('update-1.0.4-20261004T000000Z.json')
  self.assertEqual(release_retention.superseded_receipts([(held,{}),(later,proven(hours=0))]),{held})
  self.assertEqual(release_retention.superseded_receipts([(held,{}),(later,proven(hours=2))],grace=DAY),set())
  self.assertEqual(release_retention.superseded_receipts([(held,{}),(later,proven(hours=2))],now=time.time()+DAY,grace=DAY),{held})
  self.assertEqual(release_retention.superseded_receipts([(held,{}),(later,{'phase':'restart-requested'})]),set())
  self.assertEqual(release_retention.superseded_receipts([(held,{}),(pathlib.Path('update-x.json'),proven(hours=48))]),set())
 def test_older_copies_stay_until_the_new_copy_is_a_whole_database(self):
  old=self.old_copies(2);new=self.verified_receipt(old)
  copy=new/'statev2.sqlite'
  whole=copy.read_bytes()
  for label,write in (('not a database',lambda:copy.write_bytes(b'x'*4096)),
                      ('cut short',lambda:copy.write_bytes(whole[:len(whole)//2])),
                      ('log not folded',lambda:(copy.write_bytes(whole),pathlib.Path(str(copy)+'-wal').write_bytes(b'log'))),
                      ('missing',lambda:(pathlib.Path(str(copy)+'-wal').unlink(),copy.unlink()))):
   write()
   self.assertEqual(state_backup_prune.after_install('m4',self.home,self.output),[],label)
   self.assertTrue(all(p.is_dir() for p in old),label)
   self.assertEqual(json.loads(self.output.read_text())['stateBackupPruneError'],'CurrentCopyIncomplete')
  database(copy)
  self.assertEqual(state_backup_prune.after_install('m4',self.home,self.output),[p.name for p in old])
  self.assertEqual(sorted(p.name for p in self.root.iterdir()),[new.name])
 def test_one_copy_after_a_failed_update_then_a_verified_one(self):
  old=self.old_copies(2)
  receipts=self.output.parent
  # A failed update left its own copy, the newest one, held for review.
  held=self.root/('pre-0123456789ab-20261020T000000Z-%s'%('2'*32));held.mkdir();database(held/'statev2.sqlite')
  os.utime(held,(time.time()-DAY,)*2)
  (receipts/'update-1.0.180-20261020T000000Z.json').write_text(json.dumps({'phase':'restart-requested','rollback':'held-for-safe-review','stateBackup':str(held/'statev2.sqlite')}))
  measured=[];calls=[]
  def usage(path):
   measured.append(sorted(p.name for p in self.root.iterdir()));return DISK(1<<40,0,1<<40)
  with patch.object(update.shutil,'disk_usage',side_effect=usage),self.spawned(calls):self.execute()
  self.assertEqual(measured[0],[held.name])  # Before the copy: only the held, newest one.
  result=json.loads(self.output.read_text());new=pathlib.Path(result['stateBackup']).parent
  self.assertEqual(result['phase'],'verified')
  self.assertEqual(sorted(p.name for p in self.root.iterdir()),sorted([held.name,new.name]))
  self.assertEqual(state_backup_prune.after_install('m4',self.home,self.output),[held.name])
  self.assertEqual([p.name for p in self.root.iterdir()],[new.name])
 def test_a_late_prune_for_an_earlier_update_keeps_the_later_updates_copy(self):
  old=self.old_copies(2);new=self.verified_receipt(old)
  later=self.root/('pre-fedcba987654-20261026T000000Z-%s'%('2'*32));later.mkdir();database(later/'statev2.sqlite')
  self.assertEqual(state_backup_prune.after_install('m4',self.home,self.output),[old[0].name,old[1].name])
  self.assertEqual(sorted(self.root.iterdir()),sorted([new,later]))  # The later update's own helper removes `new`.
 def test_the_newest_whole_copy_is_the_one_kept_before_copying(self):
  old=self.old_copies(3)
  for folder in old[:2]:(folder/'statev2.sqlite').unlink();database(folder/'statev2.sqlite');os.utime(folder,(time.time()-DAY,)*2)
  self.assertEqual(state_backup_prune.newest_complete_copy(self.home),old[1])  # old[2] stopped mid-copy.
  self.assertEqual(release_retention.prune_state_backups(self.home,keep=[state_backup_prune.newest_complete_copy(self.home)],keep_newest=1),[old[0].name])
  self.assertEqual(sorted(self.root.iterdir()),[old[1],old[2]])
  self.assertIsNone(state_backup_prune.newest_complete_copy(self.home/'nowhere'))
 def test_a_header_count_sqlite_no_longer_vouches_for_is_not_whole(self):
  folder=self.home/'stale';folder.mkdir();path=folder/'statev2.sqlite';database(path)
  data=bytearray(path.read_bytes());data[92:96]=(int.from_bytes(data[24:28],'big')+1).to_bytes(4,'big');path.write_bytes(bytes(data))
  self.assertFalse(state_backup_prune.complete_copy(path))
 def test_a_clone_killed_part_way_is_never_a_whole_copy(self):
  own=self.home/'own';(own/'userdata').mkdir(parents=True);live=own/'userdata'/'statev2.sqlite'
  connection=sqlite3.connect(str(live));connection.execute('pragma journal_mode=wal');connection.execute('pragma wal_autocheckpoint=0')
  connection.execute('create table t(x)');connection.execute('insert into t values (1)');connection.commit()
  self.assertGreater(os.path.getsize(str(live)+'-wal'),0)
  cloned=[]
  def clones(source,target,flags):
   shutil.copyfile(os.fsdecode(source),os.fsdecode(target));cloned.append(pathlib.Path(os.fsdecode(target)))
   folder=cloned[-1].parent
   # Whatever the kill point, what is on disk so far is not a whole copy.
   self.assertFalse(state_backup_prune.complete_copy(folder/'statev2.sqlite'))
   return 0
  with patch.object(state_backup,'backup_folder',side_effect=lambda commit:self.root/('pre-abc123def456-20261027T000000Z-%s'%('3'*32))):
   (self.root).mkdir(parents=True,exist_ok=True);(self.root/('pre-abc123def456-20261027T000000Z-%s'%('3'*32))).mkdir()
   target,method=state_backup.clone_state(own,'abc123def456',clones)
  connection.close()
  self.assertEqual([path.name for path in cloned][-1],'statev2.sqlite')
  self.assertTrue(state_backup_prune.complete_copy(target))
 def test_complete_copy_reads_only_the_header(self):
  folder=self.home/'probe';folder.mkdir();path=folder/'statev2.sqlite';database(path)
  self.assertTrue(state_backup_prune.complete_copy(path))
  link=folder/'link.sqlite';link.symlink_to(path);self.assertFalse(state_backup_prune.complete_copy(link))
  self.assertFalse(state_backup_prune.complete_copy(folder))
  self.assertFalse(state_backup_prune.complete_copy(folder/'absent.sqlite'))
  journal=pathlib.Path(str(path)+'-journal');journal.write_bytes(b'');self.assertFalse(state_backup_prune.complete_copy(path));journal.unlink()
  size=path.stat().st_size
  with open(path,'ab') as handle:handle.write(b'\0'*4096)  # Longer than its page count: SQLite still reads it.
  self.assertTrue(state_backup_prune.complete_copy(path))
  with open(path,'r+b') as handle:handle.truncate(size-1)  # Cut short: not whole pages.
  self.assertFalse(state_backup_prune.complete_copy(path))
  page=int.from_bytes(path.read_bytes()[16:18],'big');self.assertGreater(size,page)
  with open(path,'r+b') as handle:handle.truncate(page)  # Whole pages, but fewer than the header counts.
  self.assertFalse(state_backup_prune.complete_copy(path))
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
  # Under the lock after a verified update every older copy goes, also a recent one no receipt
  # names; another identity's unfinished recovery copy stays.
  self.assertEqual(state_backup_prune.after_install('m4',self.home,self.output),[old[1].name,old[2].name])
  self.assertTrue(old[0].is_dir() and new.is_dir() and not old[2].exists())
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
  # A local copy no receipt names goes too; only this update's copy stays locally.
  (self.output.parent/'update-old-6.json').unlink()
  self.assertEqual(state_backup_prune.after_install('m4',self.home,self.output),[old[4].name,old[5].name])
  self.assertTrue(new.is_dir() and not old[5].exists())
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
