/**
 * Router stand-ins for the design-systems fixture. The toast layer reads
 * route params; nothing in these views navigates.
 */
import type { PropsWithChildren } from "react";

export const useParams = ({
  select,
}: { select?: (params: Record<string, string>) => unknown } = {}) => (select ? select({}) : {});
export const useNavigate = () => async () => undefined;
export const useRouter = () => ({ history: { push: () => undefined } });
export const useLocation = ({ select }: { select?: (location: unknown) => unknown } = {}) => {
  const location = { pathname: "/settings/design-systems", hash: "", search: {}, state: {} };
  return select ? select(location) : location;
};
export function Link({ children, to, ...rest }: PropsWithChildren<{ to: string }>) {
  return (
    <a href={`#${to}`} {...rest}>
      {children}
    </a>
  );
}
