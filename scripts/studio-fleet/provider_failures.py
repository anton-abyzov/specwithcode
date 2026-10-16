#!/usr/bin/env python3
"""Read-only report of failed Studio runs and the reason each one showed.

Opens the machine's Studio database read-only and lists every failed run since a
time, with its thread title and the error the thread displayed, then counts the
failures by reason. Run it after an update or on a schedule to see whether
provider errors keep happening. It never writes to the database.
"""
import argparse
import datetime
import json
import pathlib
import sqlite3
import sys
import studio_paths

import live_database

GENERIC_MESSAGES = {
    'Provider turn failed.',
    'The provider could not start this turn. Retry the turn; if it keeps failing, '
    'check the provider setup and server logs.',
}

QUERY = '''
select r.run_id, r.thread_id, r.provider, r.requested_at, r.completed_at,
       t.title,
       (select i.payload_json from orchestration_v2_projection_turn_items i
         where i.run_id = r.run_id and i.type = 'error'
         order by i.updated_at desc limit 1)
  from orchestration_v2_projection_runs r
  left join orchestration_v2_projection_threads t on t.thread_id = r.thread_id
 where r.status = 'failed' and r.requested_at >= ?
 order by r.requested_at
'''


def open_read_only(database):
    return live_database.connect(pathlib.Path(database).resolve())


def failures(connection, since):
    rows = []
    for run_id, thread_id, provider, requested, completed, title, payload in connection.execute(QUERY, (since,)):
        item = json.loads(payload) if payload else {}
        failure = item.get('failure') or {}
        message = failure.get('message') or 'No error was recorded for this run.'
        rows.append({
            'runId': run_id,
            'threadId': thread_id,
            'threadTitle': title,
            'provider': provider,
            'requestedAt': requested,
            'completedAt': completed,
            'errorTitle': item.get('title'),
            'class': failure.get('class'),
            'message': message,
            'explained': message not in GENERIC_MESSAGES,
        })
    return rows


def summary(rows):
    counts = {}
    for row in rows:
        key = (row['class'] or 'unknown', row['message'])
        counts[key] = counts.get(key, 0) + 1
    return [{'class': key[0], 'message': key[1], 'count': count}
            for key, count in sorted(counts.items(), key=lambda entry: -entry[1])]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--identity', choices=['m4', 'm1', 'm3', 'stage'], default='m4')
    parser.add_argument('--database', help='Path to statev2.sqlite (defaults to the identity home).')
    parser.add_argument('--hours', type=float, default=24.0, help='How far back to look.')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    database = args.database or str(studio_paths.identity_home(pathlib.Path.home(), args.identity) / 'userdata' / 'statev2.sqlite')
    since = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=args.hours)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    with open_read_only(database) as connection:
        rows = failures(connection, since)
    report = {'since': since, 'failedRuns': len(rows), 'unexplained': sum(not row['explained'] for row in rows),
              'byReason': summary(rows), 'runs': rows}
    if args.json:
        json.dump(report, sys.stdout, indent=2)
        print()
        return 0
    print('Failed runs since %s: %d (%d without a specific reason)' % (since, report['failedRuns'], report['unexplained']))
    for entry in report['byReason']:
        print('  %3d  %-16s %s' % (entry['count'], entry['class'], entry['message']))
    for row in rows:
        print('- %s  %s  %s: %s' % (row['requestedAt'], row['threadTitle'] or row['threadId'], row['errorTitle'] or 'Error', row['message']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
