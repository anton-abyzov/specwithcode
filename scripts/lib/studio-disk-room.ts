// The release's disk room check (disk_room.py) and the modules it needs beyond
// MAC_SERVICE_UPDATER_FILES. They ship beside the agent files in each runtime's
// studio-updater folder, where the server runs them for its fleet primary
// (apps/server/src/fleet/fleetDiskRoom.ts). Kept apart from the agent list so
// installed agents, which do not carry these files, stay valid.
export const DISK_ROOM_FILES = [
  "disk_room.py",
  "additive_migrations.py",
  "kept_lines.py",
  "state_backup.py",
] as const;
