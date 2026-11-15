/**
 * Icon that renders correctly on both platforms.
 *
 * The app was built iOS-first and drew its chrome with SF Symbols through
 * `expo-image`'s `sf:` source (`<Image source="sf:tray.fill" />`). SF Symbols
 * are an iOS system asset: on Android the image resolves to nothing, so the
 * bottom tab bar and the "more" menu showed blank space where their glyphs
 * belong — the tabs were still tappable, which made it look like icons were
 * merely unfinished.
 *
 * This component keeps the platform-native look on iOS and falls back to the
 * bundled `@expo/vector-icons` set elsewhere. Each call site pairs its SF
 * symbol with the Ionicons equivalent so the two stay recognisably the same
 * glyph (outline when inactive, filled when active).
 */
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import {
  Platform,
  type ColorValue,
  type StyleProp,
  type TextStyle,
} from "react-native";

export type PlatformIconName = React.ComponentProps<typeof Ionicons>["name"];

export interface PlatformIconProps {
  /** SF Symbol name without the `sf:` prefix, used on iOS. */
  sf: string;
  /** Ionicons name, used everywhere else. */
  ion: PlatformIconName;
  size?: number;
  /** Tab bar hands us a `ColorValue`, so this stays as wide as React Native allows. */
  color?: ColorValue;
  style?: StyleProp<TextStyle>;
}

export function PlatformIcon({ sf, ion, size = 24, color, style }: PlatformIconProps) {
  if (Platform.OS === "ios") {
    return (
      <Image
        source={`sf:${sf}`}
        style={[{ width: size, height: size, color }, style] as never}
      />
    );
  }

  return (
    <Ionicons
      name={ion}
      size={size}
      color={color as string | undefined}
      style={style as never}
    />
  );
}
