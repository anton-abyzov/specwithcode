// The desktop ships the background service agent and all of its local Python
// dependencies. The agent installs these siblings together on the owning Mac.
export const MAC_SERVICE_UPDATER_FILES = [
  "update_agent.py",
  "update_agent_reap.py",
  "update_agent_cache.py",
  "update_request.py",
  "update_agent_recovery.py",
  "update_agent_run.py",
  "update_agent_pause.py",
  "service_hold.py",
  "service_handles.py",
  "live_database.py",
  "installation_descriptor.py",
  "managed_updates.py",
  "studio_paths.py",
  "migrate_home.py",
  "relay_ownership.py",
] as const;

export const MAC_SERVICE_UPDATER_EXTRA_RESOURCES = [
  {
    from: "apps/desktop/prod-resources/studio-updater",
    to: "studio-updater",
  },
] as const;
