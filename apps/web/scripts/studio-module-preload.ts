/** Filter optional preload hints; Vite retains actual ES imports and CSS loading. */
export function studioModulePreloadDependencies(_url: string, dependencies: string[]): string[] {
  return dependencies.filter((dependency) => !/\.[cm]?js(?:[?#].*)?$/i.test(dependency));
}
