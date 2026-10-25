// Stand-ins for the chip's provider catalogue and detail store; labels and counts stay real.
export const useProviderEntriesByEnvironment = () => new Map();
export const useThreadProjection = () => null;
export function ModelBadge(props: { readonly model: string }) {
  return <span className="sws-subagent-kind">{props.model}</span>;
}
