"""The scheduling band of the fleet Studio service's LaunchAgent.

A LaunchAgent with no ProcessType key is started as a throttled background daemon
(`launchctl print` shows `spawn type = daemon`): launchd applies light CPU and I/O limits
and the server runs below the agent sessions it competes with. On a saturated Mac that
starved its event loop, so the browser saw "Can't reach" while the server was still up.
Interactive is the band the product's own boot service uses (apps/server/src/cloud/
bootService.ts); provider runtimes lower themselves below it when the server spawns them.

install.py writes the key for a new service. update.py adds it to an existing one and then
restarts through bootout and bootstrap, because launchd reads a LaunchAgent only when the
job is loaded and `kickstart -k` restarts the copy it already has.
"""
import plistlib
import xml.parsers.expat

SERVICE_PROCESS_TYPE = 'Interactive'


def with_service_priority(content):
    """A LaunchAgent dictionary with the service's ProcessType set."""
    return {**content, 'ProcessType': SERVICE_PROCESS_TYPE}


def upgraded_service_plist(data):
    """The LaunchAgent bytes with ProcessType Interactive, or None when `data` already has it
    or is not a plist dictionary (such a file is left exactly as it is)."""
    try:
        content = plistlib.loads(data)
    except (ValueError, xml.parsers.expat.ExpatError):
        return None
    if not isinstance(content, dict) or content.get('ProcessType') == SERVICE_PROCESS_TYPE:
        return None
    return plistlib.dumps(with_service_priority(content))
