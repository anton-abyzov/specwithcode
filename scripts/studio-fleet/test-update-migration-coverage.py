#!/usr/bin/env python3
"""Every server migration after 066 that names a sign-in, pairing, revocation, provider, schedule or
history table runs through the updater's migration proof in a fleet test:
some test-*.py here names its file. Migration 067 shipped in 1.0.84 without one, and every update
to it rolled back (update_migration.principal_widening). Pure file reads."""
import pathlib,re,unittest
from update_read import AUTHORITY_TABLES,LOG_TABLES
HERE=pathlib.Path(__file__).resolve().parent
MIGRATIONS=HERE.parents[1]/'apps/server/src/persistence/Migrations'
# Migrations up to here shipped before this check and are installed on every machine.
LAST_UNCHECKED=66
PROTECTED='|'.join(AUTHORITY_TABLES+LOG_TABLES)
# Any mention: an index, trigger, write or rebuild of these tables changes what the proof compares.
TOUCHES=re.compile(r'\b(?:'+PROTECTED+r')\b',re.I)
def checked_migrations():
 for path in sorted(MIGRATIONS.glob('[0-9][0-9][0-9]_*.ts')):
  if not path.name.endswith('.test.ts') and int(path.name[:3])>LAST_UNCHECKED:yield path
class MigrationCoverage(unittest.TestCase):
 def test_the_migrations_folder_is_read(self):
  self.assertTrue(any(MIGRATIONS.glob('067_*.ts')),MIGRATIONS)
 def test_each_protected_migration_has_an_updater_test(self):
  tests=''.join(path.read_text() for path in HERE.glob('test-*.py') if path.name!=pathlib.Path(__file__).name)
  missing=[path.name for path in checked_migrations() if TOUCHES.search(path.read_text()) and path.name not in tests]
  self.assertEqual(missing,[],'Run these migrations through update.apply in a fleet test (see test-update-auth-principal.py)')
 def test_the_pattern_finds_what_067_does(self):
  for text in ['ALTER TABLE auth_sessions ADD COLUMN x TEXT','CREATE TRIGGER t BEFORE INSERT ON auth_pairing_links BEGIN SELECT 1; END',
               'DROP TABLE IF EXISTS scheduled_tasks','alter table "orchestration_events" add column y']:
   self.assertTrue(TOUCHES.search(text),text)
  for text in ['CREATE INDEX i ON auth_sessions(subject)','DELETE FROM auth_pairing_links','UPDATE auth_principal_revocations SET generation=0']:
   self.assertTrue(TOUCHES.search(text),text)
  for text in ['ALTER TABLE projection_threads ADD COLUMN x TEXT','CREATE TABLE auth_sessions_archive (id TEXT)']:
   self.assertFalse(TOUCHES.search(text),text)
if __name__=='__main__':unittest.main()
