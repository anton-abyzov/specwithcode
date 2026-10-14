/** Native blanket approval belongs to Studio's access control, never model tuning. */
export function isProviderAllowAllOption(id: string): boolean {
  return id.replace(/[-_]/g, "").toLowerCase() === "allowall";
}
