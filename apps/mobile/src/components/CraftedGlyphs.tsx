import { createContext, useContext } from "react";
import { View, type ColorValue } from "react-native";
import Svg, { Circle, Rect } from "react-native-svg";
import { withUniwind } from "uniwind";

import { ProviderIcon } from "./ProviderIcon";

/*
 * Native twins of the web glyphs in apps/web/src/components/chat
 * (ThinkingMark.tsx, MaskedFieldGlyph.tsx): the same 16px grid and geometry,
 * drawn in the current tint so they read as one family with EffortGlyph.
 */
const ThemedSvg = withUniwind(Svg);

type GlyphProps = {
  readonly size?: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
};

/** Three dots fading left to right: thinking, when the provider is unknown. */
export function ThinkingDotsGlyph(props: GlyphProps) {
  const size = props.size ?? 16;
  return (
    <ThemedSvg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      color={props.color}
      colorClassName={props.colorClassName}
      fill="none"
    >
      <Circle cx={3} cy={8} r={1.75} fill="currentColor" />
      <Circle cx={8} cy={8} r={1.75} fill="currentColor" opacity={0.6} />
      <Circle cx={13} cy={8} r={1.75} fill="currentColor" opacity={0.3} />
    </ThemedSvg>
  );
}

/** A field whose value is hidden: a rounded input with three masking dots. */
export function MaskedFieldGlyph(props: GlyphProps) {
  const size = props.size ?? 16;
  return (
    <ThemedSvg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      color={props.color}
      colorClassName={props.colorClassName}
      fill="none"
    >
      <Rect
        x={1.75}
        y={4.25}
        width={12.5}
        height={7.5}
        rx={2.25}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <Circle cx={5} cy={8} r={1.1} fill="currentColor" />
      <Circle cx={8} cy={8} r={1.1} fill="currentColor" />
      <Circle cx={11} cy={8} r={1.1} fill="currentColor" />
    </ThemedSvg>
  );
}

export type ThinkingMarkProvider = {
  readonly driver: string;
  readonly iconUrl?: string | null | undefined;
};

const ThinkingProviderContext = createContext<ThinkingMarkProvider | null>(null);

/** The provider a thread feed's thinking rows show; set once around the feed. */
export const ThinkingProviderScope = ThinkingProviderContext.Provider;

export function useThinkingProvider(): ThinkingMarkProvider | null {
  return useContext(ThinkingProviderContext);
}

/**
 * A thinking row's mark: the provider that is thinking, muted, so the row says
 * who is thinking. Without a known provider it falls back to the dots. The row
 * around it already shimmers while the thought streams.
 */
export function ThinkingMark(
  props: GlyphProps & { readonly provider?: ThinkingMarkProvider | null | undefined },
) {
  const size = props.size ?? 14;
  if (!props.provider) {
    return (
      <ThinkingDotsGlyph size={size} color={props.color} colorClassName={props.colorClassName} />
    );
  }
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ opacity: 0.6 }}
      testID="thinking-provider-mark"
    >
      <ProviderIcon provider={props.provider.driver} iconUrl={props.provider.iconUrl} size={size} />
    </View>
  );
}
