"""The one SpecWithCode root per OS user, matching packages/shared/src/studioIdentity.ts.

Everything lives under ~/.specwithcode: identity homes (~/.specwithcode/<identity>),
backups, and the release store with the update agent (~/.specwithcode/install). The legacy
~/.specweave-studio and ~/.local/share/specweave-studio are used only until migrate_home.py
moves them; after that each is a compatibility link and is never returned here. Each path
is resolved on its own, so a fresh branded profile never hides an unmigrated service.
"""
import pathlib

HOME_DIRECTORY = '.specwithcode'
LEGACY_HOME_DIRECTORY = '.specweave-studio'
INSTALL_DIRECTORY = 'install'
LEGACY_INSTALL_DIRECTORY = '.local/share/specweave-studio'


def branded_root(home):
    return pathlib.Path(home) / HOME_DIRECTORY


def legacy_root(home):
    return pathlib.Path(home) / LEGACY_HOME_DIRECTORY


def legacy_install(home):
    return pathlib.Path(home) / LEGACY_INSTALL_DIRECTORY


def migrated(home):
    """True once migrate_home.py replaced the legacy root with a link to the branded one."""
    return legacy_root(home).is_symlink()


def studio_root(home):
    """Root for machine-wide entries (backups); a real legacy root wins only before the move."""
    legacy, branded = legacy_root(home), branded_root(home)
    if legacy.is_symlink() or branded.exists():
        return branded
    return legacy if legacy.exists() else branded


def identity_home(home, identity):
    branded = branded_root(home) / identity
    if migrated(home) or branded.exists():
        return branded
    legacy = legacy_root(home) / identity
    return legacy if legacy.exists() else branded


def install_root(home):
    """Release store, update agent and installation lock."""
    legacy, branded = legacy_install(home), branded_root(home) / INSTALL_DIRECTORY
    if legacy.is_symlink() or branded.exists():
        return branded
    return legacy if legacy.exists() else branded


def releases_root(home):
    return install_root(home) / 'releases'


def updater_root(home):
    return install_root(home) / 'updater'


def incoming_root(home):
    return install_root(home) / 'incoming'


def backups_root(home):
    return studio_root(home) / 'backups'
