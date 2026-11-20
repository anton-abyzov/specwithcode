// The router, for the toast region only: the fixture has no routes.
import type { ReactNode } from "react";

export const useParams = (options?: { select?: (params: Record<string, string>) => unknown }) =>
  options?.select ? options.select({}) : {};
export const useNavigate = () => () => {};
export const useLocation = () => ({ pathname: "/" });
export const Link = (props: { children?: ReactNode }) => <a>{props.children}</a>;
