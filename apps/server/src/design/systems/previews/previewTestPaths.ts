/** Find a fixture dependency's package root without changing native path separators. */
export function previewTestPackageRoot(entry: string, name: string): string | null {
  const marker = `/node_modules/${name}/`;
  const index = entry.replaceAll("\\", "/").lastIndexOf(marker);
  return index < 0 ? null : entry.slice(0, index + marker.length - 1);
}
