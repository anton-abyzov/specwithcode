export const useNavigate = () => (to: unknown) => {
  (window as unknown as { lastNavigation: unknown }).lastNavigation = to;
};
