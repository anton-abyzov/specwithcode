# Live check: copy a real project to the M3

Run this after the release that carries folder copy is installed on both the M4
(source) and the M3 (destination). It copies one real, mid-size project into a
scratch folder on the M3 with **Copy files only**, so the coordinator and the
original folder stay on the M4. Nothing here uses SSH; the M3 side runs in a
worker thread on the M3.

Fill in `DATE` (for example `2026-10-21`) and `PROJECT` (the absolute project
folder on the M4) before starting.

## Pick the project

- 1 to 10 GB, at least one nested repository or linked worktree, and at least
  one uncommitted change and one stash. Add a throwaway uncommitted line to a
  tracked file if it has none.
- Not an EasyChamp folder and not the SpecWithCode checkout the app runs from.
- No copy may already exist at `~/Projects/scratch/swc-copy-test-DATE` on the M3.

## 1. Versions

On both machines, **Settings → About** shows the same version, and that version
includes increment 0949. If the M3 is older, the copy must stop with _The source
machine runs an older SpecWithCode without folder copy_ (when the M4 is older)
or the **Copy from M4** method is missing (when the M3 is older). Record which
you saw; both count as a pass for the older-server case.

## 2. Fingerprint the source (M4)

```sh
mkdir -p ~/Projects/scratch/swc-copy-test-DATE-report
cd <specwithcode-dev checkout at the release commit>
node scripts/studio-folder-transfer/fingerprint.mjs snapshot "PROJECT" \
  ~/Projects/scratch/swc-copy-test-DATE-report/source.json \
  > ~/Projects/scratch/swc-copy-test-DATE-report/source.summary.json
```

The script is read-only and records secret-like files by name only. Do not edit
the project between this step and step 4.

## 3. Copy (in the app on the M4)

1. Open the project, choose **Handoff**, pick the M3.
2. Method **Copy from M4**. Folder on M3:
   `~/Projects/scratch/swc-copy-test-DATE/<project folder name>`.
3. **Copy files only**, **Measure the folder**. Note the sizes per class and that
   **Secret-like files** says it is handled in the secrets step.
4. **Preview on M3**, then **Copy and apply on M3**. Note the start and end time.
5. Midway through the file phase, quit and reopen SpecWithCode on the M3 once
   (menu bar → Quit). The copy must resume without starting over; record the
   progress before and after.

Pass: the dialog ends with _M3 has a copy in …. The coordinator stays on M4._ and
**Open on M3** opens a new project on the M3. The dialog then shows _Linked: the
copy on M3 runs workers; the coordinator on M4 sends it work._, and **Settings >
Machines** for the project on the M4 lists the M3 copy as running workers.

## 4. Fingerprint the copy (M3 worker thread)

From the lead thread, start a worker on the M3 (`studio_thread_launch` with
`machine` set to the M3) and give it this task, with the contents of
`scripts/studio-folder-transfer/fingerprint.mjs` from the release commit pasted
in, plus `source.summary.json` from step 2:

> Write the script below to `/tmp/swc-fingerprint.mjs` and the summary below to
> `/tmp/swc-source.summary.json`. Then run
> `node /tmp/swc-fingerprint.mjs snapshot ~/Projects/scratch/swc-copy-test-DATE/<name> /tmp/swc-dest.json`
> and
> `node /tmp/swc-fingerprint.mjs compare /tmp/swc-source.summary.json /tmp/swc-dest.json`.
> For every section reported as differing, run
> `node /tmp/swc-fingerprint.mjs section ~/Projects/scratch/swc-copy-test-DATE/<name> <section>`
> and return the output. Also return `df -h ~/Projects/scratch` and
> `ls ~/Projects/scratch/swc-copy-test-DATE/<name>` filtered to `.env*`.
> Read-only: do not edit, move or delete anything, and do not print the contents
> of any `.env*` or key file.

Pass:

- `compare` prints `MATCH`. For a differing section, run `section` on the M4
  for the same section and diff the two outputs; a file the app listed as
  changing while it was read is an accepted difference.
- No `.env*` file exists in the copy.
- No rebuildable folder (`node_modules`, `dist`, …) exists in the copy.

## 5. Undo (in the app on the M4)

Choose **Undo…** in the same dialog. With no edits on the M3 it offers **Undo
the copy**; choose it. Pass: `~/Projects/scratch/swc-copy-test-DATE/<name>` is gone on the M3 and the
dialog reports the copy as undone. If you edited a file on the M3 first, the dialog
must list it and offer **Undo and keep edited files aside**.

## 6. Clean up

Ask the M3 worker to remove `~/Projects/scratch/swc-copy-test-DATE` only after
the results are saved. First unlink the M3 copy in **Settings > Machines** on
the M4 (Undo restores the folder but leaves the link), then remove the scratch
project from the M3 sidebar.
Keep `~/Projects/scratch/swc-copy-test-DATE-report` on the M4 with the
timings, the screenshots of each dialog step and the worker's output.
