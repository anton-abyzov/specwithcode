#!/usr/bin/env python3
"""Every server migration after 066 that names a sign-in, pairing, revocation, provider, schedule or
history table runs through the updater's migration proof in a fleet test:
some test-*.py here names its file. Migration 067 shipped in 1.0.84 without one, and every update
to it rolled back (update_migration.principal_widening).

Every migration after 066 also has its own server test beside it (NNN_Name.test.ts): 068, 070 and
072 shipped without one, and 072's rebuild was first exercised by the fleet on M4 (1.0.184). One
that rebuilds a table (create _next, copy, drop, rename) has a declared additive_migrations.REBUILT
entry for each table it drops, and one that alters a table is in REBUILT or FULL_READ; either has a
populated additive_migrations.FIXTURES entry for each table it rebuilds or alters, which
test-full-read-completes.py runs through update.apply. Pure file reads."""
import pathlib,re,unittest
import additive_migrations
from update_read import AUTHORITY_TABLES,LOG_TABLES
HERE=pathlib.Path(__file__).resolve().parent
MIGRATIONS=HERE.parents[1]/'apps/server/src/persistence/Migrations'
# Migrations up to here shipped before this check and are installed on every machine.
LAST_UNCHECKED=66
PROTECTED='|'.join(AUTHORITY_TABLES+LOG_TABLES)
# Any mention: an index, trigger, write or rebuild of these tables changes what the proof compares.
TOUCHES=re.compile(r'\b(?:'+PROTECTED+r')\b',re.I)
# Statements that rewrite an existing table's definition, by the table they name.
DROPPED=re.compile(r'\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?',re.I)
RENAMED=re.compile(r'\bALTER\s+TABLE\s+"?(\w+)"?\s+RENAME\s+TO\s+"?(\w+)"?',re.I)
ALTERED=re.compile(r'\bALTER\s+TABLE\s+"?(\w+)"?\s+(?:ADD|DROP|RENAME)\b',re.I)
def statements(text):
 """The SQL of each sql`...` template in a migration's source, comments left out."""
 return re.findall(r'sql(?:<[^`]*?>)?`(.*?)`',text,re.S)
def rewritten_tables(text):
 """{'rebuilt': tables dropped (or renamed onto), 'altered': tables altered in place}."""
 sql='\n'.join(statements(text))
 rebuilt={name for name in DROPPED.findall(sql)}|{target for _,target in RENAMED.findall(sql)}
 altered={name for name in ALTERED.findall(sql) if name not in {source for source,_ in RENAMED.findall(sql)}}-rebuilt
 return {'rebuilt':sorted(rebuilt),'altered':sorted(altered)}
def classification_problems(number,text,rebuilt=None,full_read=None,fixtures=None):
 """Why migration `number` (its source `text`) breaks the rebuild rule, or [] when it does not."""
 rebuilt=additive_migrations.REBUILT if rebuilt is None else rebuilt
 full_read=additive_migrations.FULL_READ if full_read is None else full_read
 fixtures=additive_migrations.FIXTURES if fixtures is None else fixtures
 tables,problems=rewritten_tables(text),[]
 for table in tables['rebuilt']:
  if table not in (rebuilt.get(number) or ('',{}))[1]:problems.append('%03d rebuilds %s without a REBUILT entry'%(number,table))
 if tables['altered'] and number not in rebuilt and number not in full_read:
  problems.append('%03d alters %s but is in neither REBUILT nor FULL_READ'%(number,', '.join(tables['altered'])))
 for table in tables['rebuilt']+tables['altered']:
  if not (fixtures.get(number) or {}).get(table):problems.append('%03d has no populated FIXTURES entry for %s'%(number,table))
 for table in (rebuilt.get(number) or ('',{}))[1]:
  if not (fixtures.get(number) or {}).get(table):problems.append('%03d has no populated FIXTURES entry for %s'%(number,table))
 return sorted(set(problems))
def checked_migrations():
 for path in sorted(MIGRATIONS.glob('[0-9][0-9][0-9]_*.ts')):
  if not path.name.endswith('.test.ts') and int(path.name[:3])>LAST_UNCHECKED:yield path
def migration_number(path):return int(path.name[:3])
def source(number):return next(path for path in checked_migrations() if migration_number(path)==number).read_text()
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
 def test_each_migration_after_066_has_its_own_server_test(self):
  missing=[path.name for path in checked_migrations() if not path.with_name(path.name[:-3]+'.test.ts').is_file()]
  self.assertEqual(missing,[],'Add a sibling NNN_Name.test.ts: the migration on a populated table keeps every row and creates its objects')
 def test_each_rebuild_or_alter_is_declared_with_a_fixture(self):
  problems=[problem for path in checked_migrations() if migration_number(path)>=additive_migrations.FIRST_TRACKED
            for problem in classification_problems(migration_number(path),path.read_text())]
  self.assertEqual(problems,[],'Declare it in additive_migrations.REBUILT (or FULL_READ) and add a populated FIXTURES entry')
 def test_every_full_read_and_rebuilt_entry_has_a_populated_fixture(self):
  for number in sorted(set(additive_migrations.FULL_READ)|set(additive_migrations.REBUILT)):
   with self.subTest(migration=number):
    self.assertTrue(additive_migrations.FIXTURES.get(number),number)
    for table,rows in additive_migrations.FIXTURES[number].items():
     self.assertGreaterEqual(len(rows),2,table);self.assertTrue(all(isinstance(row,dict) and row for row in rows),table)
 def test_072_is_seen_as_a_rebuild_and_069_as_an_alter(self):
  self.assertEqual(rewritten_tables(source(72)),
                   {'rebuilt':['orchestration_v2_thread_history_compactions'],'altered':[]})
  self.assertEqual(rewritten_tables(source(69)),{'rebuilt':[],'altered':['auth_sessions']})
  self.assertEqual(rewritten_tables(source(68)),{'rebuilt':[],'altered':[]})
 def test_the_rule_fails_an_undeclared_rebuild_alter_or_missing_fixture(self):
  rebuild="yield* sql`CREATE TABLE notes_next (id TEXT)`;\nyield* sql`INSERT INTO notes_next SELECT * FROM notes`;\n" \
          "yield* sql`DROP TABLE notes`;\nyield* sql`ALTER TABLE notes_next RENAME TO notes`;"
  self.assertEqual(classification_problems(90,rebuild,rebuilt={},full_read={},fixtures={}),
                   ['090 has no populated FIXTURES entry for notes','090 rebuilds notes without a REBUILT entry'])
  declared={90:('Notes',{'notes':{}})}
  self.assertEqual(classification_problems(90,rebuild,rebuilt=declared,full_read={},fixtures={}),['090 has no populated FIXTURES entry for notes'])
  self.assertEqual(classification_problems(90,rebuild,rebuilt=declared,full_read={},fixtures={90:{'notes':()}}),['090 has no populated FIXTURES entry for notes'])
  self.assertEqual(classification_problems(90,rebuild,rebuilt=declared,full_read={},fixtures={90:{'notes':({'id':'a'},)}}),[])
  alter='yield* sql`ALTER TABLE "notes" ADD COLUMN extra TEXT`;'
  self.assertEqual(classification_problems(91,alter,rebuilt={},full_read={},fixtures={}),
                   ['091 alters notes but is in neither REBUILT nor FULL_READ','091 has no populated FIXTURES entry for notes'])
  self.assertEqual(classification_problems(91,alter,rebuilt={},full_read={91:'Notes'},fixtures={91:{'notes':({'id':'a'},)}}),[])
  self.assertEqual(classification_problems(92,'yield* sql`CREATE INDEX i ON notes(id)`;',rebuilt={},full_read={},fixtures={}),[])
  # A comment or a log line naming DROP TABLE outside a sql`...` template is not a statement.
  self.assertEqual(classification_problems(93,'// DROP TABLE notes\nconsole.log("ALTER TABLE notes ADD x")',rebuilt={},full_read={},fixtures={}),[])
 def test_the_sibling_test_rule_fails_a_migration_without_one(self):
  import tempfile
  with tempfile.TemporaryDirectory() as folder:
   root=pathlib.Path(folder);(root/'090_Notes.ts').write_text('');(root/'091_Other.ts').write_text('');(root/'091_Other.test.ts').write_text('')
   missing=[path.name for path in sorted(root.glob('[0-9][0-9][0-9]_*.ts')) if not path.name.endswith('.test.ts')
            and not path.with_name(path.name[:-3]+'.test.ts').is_file()]
   self.assertEqual(missing,['090_Notes.ts'])
if __name__=='__main__':unittest.main()
