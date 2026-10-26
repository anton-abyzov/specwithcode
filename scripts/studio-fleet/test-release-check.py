#!/usr/bin/env python3
"""release_check.release_verified: a release is hashed once per process, then checked by each
file's identity; any change to a file, the manifest, package.json or the file set is hashed again
and refused. Temporary folders only.

Run: cd scripts/studio-fleet && python3 -B test-release-check.py
"""
import hashlib,importlib.util,json,os,pathlib,sys,tempfile,time,unittest
from unittest import mock
HERE=pathlib.Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
import release_check  # noqa: E402
import studio_paths  # noqa: E402
import update  # noqa: E402
spec=importlib.util.spec_from_file_location('release_check_update_base',HERE/'test-update.py')
updater_base=importlib.util.module_from_spec(spec);spec.loader.exec_module(updater_base)
apply_update=updater_base.update  # The harness's own update.py module, so a patch here reaches the apply it runs.
FILES=24;SIZE=1<<20
class ReleaseVerified(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='studio-release-check-');self.root=pathlib.Path(self.temp.name).resolve()
  self.addCleanup(self.temp.cleanup);self.addCleanup(release_check._VERIFIED.clear);release_check._VERIFIED.clear()
  # The fixtures are written just now; an installed release's files are older than the window.
  window=mock.patch.object(release_check,'RACY_NANOSECONDS',0);window.start();self.addCleanup(window.stop)
  self.release=self.make(self.root/'staged')
 def make(self,release):
  release.mkdir(parents=True);files=[]
  for index in range(FILES):
   data=bytes([index])*SIZE;(release/('chunk-%02d.bin'%index)).write_bytes(data)
   files.append({'path':'chunk-%02d.bin'%index,'type':'file','sha256':hashlib.sha256(data).hexdigest()})
  (release/'lib').mkdir();os.symlink('chunk-00.bin',release/'lib'/'first')
  files.append({'path':'lib/first','type':'symlink','target':'chunk-00.bin'})
  (release/'studio-manifest.json').write_text(json.dumps({'product':'SpecWeave Studio','version':'0.1.0','sourceCommit':'fixture','files':files}))
  return release
 def hashed(self):
  """The file contents hashed during the calls in the block (the manifest's small digests aside)."""
  calls=[];real=release_check._sha256
  def counting(data):
   if len(data)==SIZE:calls.append(data[:1])
   return real(data)
  return calls,mock.patch.object(release_check,'_sha256',side_effect=counting)
 def test_a_second_verify_checks_by_stat_and_is_fast(self):
  calls,counting=self.hashed()
  with counting:
   first=release_check.release_verified(self.release)
   self.assertEqual(len(calls),FILES)
   started=time.monotonic();second=release_check.release_verified(self.release);elapsed=time.monotonic()-started
  self.assertEqual(len(calls),FILES);self.assertEqual(first,second)
  self.assertLess(elapsed,0.5)
 def test_a_cached_verify_resolves_only_the_links(self):
  # Readiness after a restart makes one service check; a resolve() per file made it 2.3 s on M4's 7,800-file release.
  release_check.release_verified(self.release)
  resolved=[];real=pathlib.Path.resolve
  def counting(path,*args,**kwargs):
   resolved.append(path.name);return real(path,*args,**kwargs)
  with mock.patch.object(pathlib.Path,'resolve',counting):release_check.release_verified(self.release)
  self.assertEqual(resolved,['first'])
 def test_a_file_reached_through_a_linked_folder_is_refused(self):
  outside=self.root/'outside';outside.mkdir();data=b'outside';(outside/'x.js').write_bytes(data)
  release=self.root/'linked';release.mkdir();os.symlink(str(outside),release/'lib')
  files=[{'path':'lib','type':'symlink','target':str(outside)},
         {'path':'lib/x.js','type':'file','sha256':hashlib.sha256(data).hexdigest()}]
  (release/'studio-manifest.json').write_text(json.dumps({'product':'SpecWeave Studio','version':'0.1.0','sourceCommit':'fixture','files':files[1:]}))
  self.assertRaises(AssertionError,release_check.release_verified,release)
  (release/'studio-manifest.json').write_text(json.dumps({'product':'SpecWeave Studio','version':'0.1.0','sourceCommit':'fixture','files':files}))
  self.assertRaises(AssertionError,release_check.release_verified,release)
 def test_a_byte_rewritten_at_the_same_size_and_mtime_is_hashed_again_and_refused(self):
  release_check.release_verified(self.release)
  path=self.release/'chunk-07.bin';info=os.stat(path)
  with open(path,'r+b') as handle:handle.seek(SIZE//2);handle.write(b'\xff')
  os.utime(path,ns=(info.st_atime_ns,info.st_mtime_ns))  # Same size, same mtime: only its ctime moved.
  self.assertEqual((os.stat(path).st_size,os.stat(path).st_mtime_ns),(info.st_size,info.st_mtime_ns))
  calls,counting=self.hashed()
  with counting,self.assertRaises(AssertionError):release_check.release_verified(self.release)
  self.assertEqual(calls,[b'\x07'])
  with self.assertRaises(AssertionError):release_check.release_verified(self.release)  # Still refused next time.
 def test_a_replaced_file_or_a_changed_set_or_link_is_refused_on_the_fast_path(self):
  release_check.release_verified(self.release)
  path=self.release/'chunk-03.bin';data=bytearray(path.read_bytes());data[0]^=1
  replacement=self.root/'replacement';replacement.write_bytes(bytes(data));os.replace(replacement,path)  # A new inode.
  with self.assertRaises(AssertionError):release_check.release_verified(self.release)
  release=self.make(self.root/'second');release_check.release_verified(release)
  (release/'extra.js').write_text('added');self.assertRaises(AssertionError,release_check.release_verified,release)
  (release/'extra.js').unlink();release_check.release_verified(release)
  os.unlink(release/'lib'/'first');os.symlink('chunk-01.bin',release/'lib'/'first')
  self.assertRaises(AssertionError,release_check.release_verified,release)
 def test_a_changed_manifest_is_hashed_again(self):
  release_check.release_verified(self.release)
  manifest=json.loads((self.release/'studio-manifest.json').read_text())
  manifest['files'][5]['sha256']='0'*64;(self.release/'studio-manifest.json').write_text(json.dumps(manifest))
  calls,counting=self.hashed()
  with counting,self.assertRaises(AssertionError):release_check.release_verified(self.release)
  self.assertEqual(len(calls),6)  # A full pass again, up to the file the new manifest gets wrong.
 def test_a_published_release_keeps_its_record_and_update_uses_this_check(self):
  self.assertIs(update.release_verified,release_check.release_verified)
  release_check.release_verified(self.release)
  destination=self.root/'releases'/'published';destination.parent.mkdir()
  calls,counting=self.hashed()
  with counting:manifest=update.publish_release(self.release,destination)  # A rename: the same folder and files.
  self.assertEqual((calls,manifest['version']),([],'0.1.0'))
  self.assertEqual(release_check.release_manifest(destination),manifest)
 def test_a_file_changed_within_the_window_is_hashed_again_by_the_next_pass(self):
  # A coarse timestamp can hide a write made in the same second as the pass that read the file.
  with mock.patch.object(release_check,'RACY_NANOSECONDS',3600*10**9):
   release_check.release_verified(self.release)
   calls,counting=self.hashed()
   with counting:release_check.release_verified(self.release)
   self.assertEqual(len(calls),FILES)  # Every fixture was written within the hour.
  calls,counting=self.hashed()
  with counting:
   release_check.release_verified(self.release);self.assertEqual(len(calls),FILES)  # The last pass recorded none of them.
   release_check.release_verified(self.release);self.assertEqual(len(calls),FILES)
 def test_the_record_is_in_memory_only(self):
  before={path:path.stat().st_mtime_ns for path in self.root.rglob('*') if not path.is_symlink()}
  release_check.release_verified(self.release)
  self.assertEqual({path:path.stat().st_mtime_ns for path in self.root.rglob('*') if not path.is_symlink()},before)
  release_check._VERIFIED.clear()  # A new process starts with no record: the next call hashes everything.
  calls,counting=self.hashed()
  with counting:release_check.release_verified(self.release)
  self.assertEqual(len(calls),FILES)
class StagedRelease(updater_base.ApplyRecovery):
 # update.apply checks the staged release once, in publish_release; its version gate reads manifests.
 def setUp(self):
  super().setUp();self.addCleanup(release_check._VERIFIED.clear)
  self.published=studio_paths.releases_root(self.home)/self.sha[:20]
 def assert_nothing_changed(self):
  self.assertFalse(self.published.exists());self.assertEqual((self.restart_calls,self.backups,self.stops),([],[],[]))
  self.assertEqual({p:p.read_bytes() for p in self.original},self.original)
 def test_a_downgrade_is_refused_before_the_staged_release_is_published(self):
  old=pathlib.Path(self.oldrelease)/'studio-manifest.json'
  old.write_text(json.dumps({'product':'SpecWeave Studio','version':'1.0.0','schemaVersion':1,'sourceCommit':'c'*40,'lockSha256':'b'*64,
                             'runtime':'Node22.20.0','noAuthOrUserStores':True,'files':[{'path':'package.json','type':'file','sha256':'0'*64}]}))
  self.incoming_version,self.incoming_source='0.2.0','a'*40
  with mock.patch.object(apply_update,'release_verified',side_effect=AssertionError('no release is hashed before the gate')):
   with self.assertRaisesRegex(AssertionError,'Downgrade requires explicit rollback'):self.execute()
  self.assertEqual(len(self.stage_timeouts),1);self.assert_nothing_changed()
 def test_staged_bytes_changed_after_install_py_are_refused_when_published(self):
  self.on_stage=lambda:next(self.home.rglob('owned-update-stage-*/.specwithcode/install/releases/*/bin.mjs')).write_bytes(b'changed-owned-code')
  with self.assertRaises(AssertionError):self.execute()
  self.assert_nothing_changed()
 def test_a_staged_release_is_hashed_once_for_staging_and_publication(self):
  calls=[];real=release_check.release_verified
  def counted(release):calls.append(pathlib.Path(release).name);return real(release)
  with mock.patch.object(apply_update,'release_verified',side_effect=counted):self.execute()
  self.assertEqual(json.loads(self.output.read_text())['phase'],'verified')
  self.assertEqual(calls,[self.sha[:20]])  # publish_release's one check; the old release only by its manifest.
if __name__=='__main__':unittest.main()
