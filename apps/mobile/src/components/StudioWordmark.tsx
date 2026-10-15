import type { ColorValue } from "react-native";
import Svg, { G, Path, Rect } from "react-native-svg";

// The page-and-prompt brand mark on its indigo tile, from assets/brand/specwithcode-mark.svg.
const TILE = "#5B6CFF";
const PAGE = {
  fill: "#FFFFFF",
  d: "M29 10H60L78 28V83Q78 90 71 90H29Q22 90 22 83V17Q22 10 29 10Z",
};
const FOLD = { fill: "#AAACB2", d: "M60 10V24Q60 28 64 28H78Z" };
const PROMPT = {
  fill: "#0B1020",
  d: "M38.703 41.051L50.703 52.051A4 4 0 0 1 50.703 57.949L38.703 68.949A4 4 0 0 1 33.297 63.051L42.080 55L33.297 46.949A4 4 0 0 1 38.703 41.051ZM54 62H64A4 4 0 0 1 64 70H54A4 4 0 0 1 54 62Z",
};
// Maps the mark's 10..90 box onto the 64-unit tile with 15% padding.
const MARK_TRANSFORM = "translate(4 4) scale(0.56)";

// Always the brand colors; color and colorClassName are kept for existing callers.
export function StudioWordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel="SpecWithCode"
      height={props.height}
      width={props.height}
      viewBox="0 0 64 64"
    >
      <Rect width="64" height="64" rx="14.4" fill={TILE} />
      <G transform={MARK_TRANSFORM}>
        {[PAGE, FOLD, PROMPT].map((path) => (
          <Path key={path.d} fill={path.fill} d={path.d} />
        ))}
      </G>
    </Svg>
  );
}
