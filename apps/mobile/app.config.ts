import type { ExpoConfig, ConfigContext } from "expo/config";

/**
 * Dynamic Expo config — replaces app.json so we can read APP_ENV at runtime
 * and switch bundleIdentifier / display name for dev / staging / production.
 *
 * APP_ENV is set by package.json scripts:
 *   - dev          → APP_ENV unset (treated as "development")
 *   - dev:staging  → APP_ENV=staging
 *   - dev:prod     → APP_ENV=production (rare; usually only for EAS build)
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const env = process.env.APP_ENV ?? "development";
  const isProd = env === "production";
  const isStaging = env === "staging";

  return {
    ...config,
    name: isProd
      ? "Multica"
      : isStaging
        ? "Multica (Staging)"
        : "Multica (Dev)",
    slug: "multica-mobile",
    version: "0.1.0",
    orientation: "portrait",
    userInterfaceStyle: "automatic",
    scheme: "multica",
    // 1024x1024 full-bleed, no-alpha source that belongs to mobile alone. Do
    // not point this back at the desktop icon (apps/desktop/build/icon.png):
    // that one is padded for macOS, and iOS would mask it a second time, which
    // is the white ring from #6995. Expo prebuild generates every required iOS
    // icon size from this single PNG.
    icon: "./assets/icon.png",
    ios: {
      // Expo keeps the top-level portrait policy for iPhone while adding all
      // iPad orientations required for multitasking when tablet support is on.
      supportsTablet: true,
      // Pins DEVELOPMENT_TEAM on every prebuild. Leaving it unset is the normal
      // path — `expo run:ios` then resolves a signing identity from the Keychain
      // itself, which is right when the Apple ID owns exactly one team. With
      // several (a personal team plus an employer's) it takes the *first*
      // identity found whenever the terminal is non-interactive, writes that
      // choice into the generated ios/, and never clears it again: prebuild only
      // writes DEVELOPMENT_TEAM when a value is present, so a project pinned to
      // the wrong team stays wrong until ios/ is deleted. Setting this re-applies
      // the intended team on every `scripts/ios-run.sh` run, which also repairs
      // an already-mispinned checkout.
      appleTeamId: process.env.EXPO_APPLE_TEAM_ID,
      // Per-variant bundle id overrides exist for one reason: an Apple ID
      // can only sign bundle prefixes it owns, so contributors not on the
      // Multica Apple Developer team (and external users self-building a
      // personal copy against production) need to swap to a reverse-domain
      // they control. Each variant has its own `_<VARIANT>` suffix and is
      // only read inside that variant's branch — a generic
      // `EXPO_BUNDLE_IDENTIFIER` would leak across variants (Expo CLI
      // auto-loads `.env.<mode>.local` regardless of APP_ENV) and collapse
      // dev / staging / prod onto a single id.
      bundleIdentifier: isProd
        ? (process.env.EXPO_BUNDLE_IDENTIFIER_PROD ?? "ai.multica.mobile")
        : isStaging
          ? (process.env.EXPO_BUNDLE_IDENTIFIER_STAGING ?? "ai.multica.mobile.staging")
          : (process.env.EXPO_BUNDLE_IDENTIFIER_DEV ?? "ai.multica.mobile.dev"),
    },
    // Android mirror of the iOS per-variant bundle identifiers above. Android
    // answers to the same reverse-domain scheme, so the dev / staging / prod
    // APKs coexist on one phone exactly like the iOS builds do. There is no
    // Apple team or provisioning involved — the suffix alone keeps them apart.
    android: {
      package: isProd
        ? (process.env.EXPO_ANDROID_PACKAGE_PROD ?? "ai.multica.mobile")
        : isStaging
          ? (process.env.EXPO_ANDROID_PACKAGE_STAGING ?? "ai.multica.mobile.staging")
          : (process.env.EXPO_ANDROID_PACKAGE_DEV ?? "ai.multica.mobile.dev"),
      // The iOS icon is full-bleed and macOS masks it once; Android masks an
      // adaptive icon harder, so the same PNG loses the outer arms of the mark
      // inside the launch icon's circle/squircle. `adaptive-icon.png` is that
      // mark extracted onto a transparent field, normalised to the central 42%
      // of the 108dp canvas: Android only shows the middle 66%, so the mark
      // draws at ~63% of the visible tile — the same proportion as the original
      // — and its bounding-box corners stay inside the mask radius instead of
      // being sliced off. Over the same black the original icon uses.
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-icon.png",
        backgroundColor: "#0b0b0c",
        monochromeImage: "./assets/adaptive-icon.png",
      },
    },
    plugins: [
      "expo-router",
      // Aligns libc++_shared.so with fbjni; without it Android aborts at
      // startup with "cannot locate symbol __cxa_init_primary_exception".
      "./plugins/with-fbjni-libcxx",
      "expo-image",
      "expo-localization",
      "expo-secure-store",
      "@react-native-community/datetimepicker",
      "react-native-enriched-markdown",
      [
        "expo-image-picker",
        {
          // iOS NSPhotoLibraryUsageDescription. Without this string in
          // Info.plist, calling launchImageLibraryAsync hard-crashes on
          // iOS 14+. Camera + microphone are disabled — we only ever read
          // from the existing photo library.
          photosPermission:
            "Allow Multica to access your photos to attach images to issues and comments.",
          cameraPermission: false,
          microphonePermission: false,
        },
      ],
      [
        "expo-build-properties",
        {
          ios: {
            buildReactNativeFromSource: true,
            // SDK 57's supported scene runtime is required for Xcode 27 builds.
            // Keep this in prebuild config so clean native generations retain it.
            enableSceneSupport: true,
          },
          android: {
            // compileSdk 36 matches the platform installed by
            // .toolchain/android-sdk; targetSdk 35 keeps Android 15 behavior
            // while the app's edge-to-edge styles are verified on 16.
            compileSdkVersion: 36,
            targetSdkVersion: 36,
            minSdkVersion: 24,
            buildToolsVersion: "36.0.0",
            // Shrink the release APK so a sideload over USB stays quick;
            // resources are trimmed only for release builds.
            enableProguardInReleaseBuilds: true,
          },
        },
      ],
    ],
    extra: { APP_ENV: env },
  };
};
