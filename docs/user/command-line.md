# The command line

`specwithcode` is SpecWithCode driven from a terminal. The command that the desktop app installs runs the app's own copy of the tool, so it is always the same version as the app. It talks to the app that is already running. It is not a second copy of SpecWithCode, and it needs no separate sign-in.

You need it to add or join a machine over SSH or on a server with no screen, to link Connect from a terminal, to pair a phone, to check the background service, and in scripts and agents. You do not need it for anything you do in the app's own windows.

## Install it from the app

Open **Settings > Machines > Command line** and choose **Install command-line tool**. The last step of first-run setup offers the same button.

What installing changes on disk, with no administrator password:

| System                   | What the app writes                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| macOS and Linux (`.deb`) | `~/.local/bin/specwithcode`, a link to the command inside the app                                                          |
| Linux AppImage           | `~/.local/bin/specwithcode`, a small launcher that opens the AppImage and runs the command inside it (AppImages need FUSE) |
| Windows                  | `%LOCALAPPDATA%\SpecWithCode\bin\specwithcode.cmd`, and that folder added to your user `PATH`                              |

Open a new terminal window afterwards and check it:

```bash
specwithcode --version
```

### When the folder is not on PATH

macOS does not put `~/.local/bin` on a terminal's `PATH` by default. When a new terminal would not find the command, the card says so and offers two ways forward:

- **Add it to `<file>`** appends one line to your shell's startup file, marked `# Added by SpecWithCode`. The app only edits the file after you click: `~/.zprofile` for zsh on macOS (`~/.zshrc` on Linux), `~/.bash_profile` for bash on macOS (or `~/.profile` when that is the file bash reads; `~/.bashrc` on Linux), and its own `~/.config/fish/conf.d/specwithcode.fish` for fish.
- Or copy the line and add it yourself:

```bash
export PATH="$HOME/.local/bin:$PATH" # Added by SpecWithCode
```

The card checks the kind of shell a new terminal window starts: a login shell on macOS, an interactive non-login shell on Linux (which reads `~/.bashrc`). A Linux login shell, such as an SSH session, reads `~/.profile` instead; most distributions' default `~/.profile` already adds `~/.local/bin` when that folder exists.

On Windows, a new terminal window picks up the user `PATH` change. If the `PATH` step did not happen, the card shows **Add to PATH** to try it again. A `.cmd` command cannot pass every argument through untouched: an argument with `%NAME%` in it, or with an embedded double quote, may arrive changed. Use PowerShell quoting or put such values in a file.

## Updates, moves and repairs

Updates keep the command current: it points at the app's location, not at a version. If the app moves (for example from Downloads into Applications) or an old copy is deleted, the app points the command at itself the next time it opens. The card shows **Repair** for a command that points at a copy of the app that is gone, and **Use this copy** when it runs a different copy that still exists.

The app does not install the command while it runs from a disk image (any read-only volume) or a translocated folder. Move SpecWithCode to Applications first.

Before it replaces or deletes its own command, the app checks the file is still the one it looked at. If something else was put there in the meantime, it stops and changes nothing.

## What the app never touches

- A `specwithcode` launcher that `install.sh` or the fleet installer wrote. That install keeps its own command up to date, so the card says so and leaves it.
- Any other file or link at the same path.
- Another `specwithcode` earlier on your `PATH`, such as an npm global install. The card names it, so you know which one a terminal runs.

## Remove it

**Remove** on the same card deletes the app's command and the `PATH` change the app made: the marked line in every shell startup file it knows (even if you changed shells since), the app's two lines in the fish file (the file goes only if nothing else is left in it), or the Windows user `PATH` entry. It leaves `~/.local/bin` and everything else in it. If a startup file cannot be changed, for example because it is read-only, the card says which file still has the marked line so you can delete it yourself.

## Common commands

| Task                                             | Example                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| Show the version                                 | `specwithcode --version`                                                  |
| Make a line to add this machine to your main one | `specwithcode fleet invite --coordinator '<main-machine-environment-id>'` |
| Add a machine from its line                      | `specwithcode fleet add '<line>'`                                         |
| Link this machine to Connect                     | `specwithcode connect link`                                               |
| Pair a phone                                     | `specwithcode pair`                                                       |
| Check the background service                     | `specwithcode service status`                                             |
| Full reference                                   | `specwithcode --help`                                                     |
