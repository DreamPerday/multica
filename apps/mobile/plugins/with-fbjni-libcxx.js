/**
 * Android startup fix: align `libc++_shared.so` with fbjni.
 *
 * Symptom without this plugin, on every launch:
 *
 *   FATAL EXCEPTION: main
 *   com.facebook.soloader.B: couldn't find DSO to load: libfbjni.so
 *   java.lang.UnsatisfiedLinkError: dlopen failed: cannot locate symbol
 *     "__cxa_init_primary_exception" referenced by .../libfbjni.so
 *
 * `libfbjni.so` (0.8.1) references `__cxa_init_primary_exception`, which only
 * exists in a newer libc++ than the `libc++_shared.so` bundled inside the
 * `com.facebook.react:react-android` AAR. The packaged copy therefore has the
 * symbol missing, and dlopen refuses the library before any JS runs.
 *
 * The fix pins fbjni to the version DSH/React Native expects and copies the
 * matching `libc++_shared.so` out of the fbjni AAR over the merged native libs
 * right after symbol stripping.
 *
 * This is a config plugin rather than a hand edit of `android/app/build.gradle`
 * because `expo prebuild` regenerates that directory; the edit previously
 * survived only until the next prebuild and the crash came back.
 */
const { withAppBuildGradle } = require("expo/config-plugins");

const FBJNI_VERSION = "0.8.1";

const GRADLE_SNIPPET = `
// --- multica: fbjni / libc++_shared alignment (see plugins/with-fbjni-libcxx.js)
configurations.all {
    resolutionStrategy { force "com.facebook.fbjni:fbjni:${FBJNI_VERSION}" }
}

dependencies {
    // react-android bundles an older libc++_shared.so; taking fbjni from the
    // React Native graph would keep that stale copy next to it.
    implementation("com.facebook.react:react-android") { exclude group: "com.facebook.fbjni" }
    implementation("com.facebook.fbjni:fbjni:${FBJNI_VERSION}")
}

def multicaFbjniCache = new File(
    gradle.gradleUserHomeDir,
    "caches/modules-2/files-2.1/com.facebook.fbjni/fbjni/${FBJNI_VERSION}"
)

androidComponents {
    onVariants(selector().all()) { variant ->
        def variantName = variant.name.capitalize()
        tasks.configureEach { task ->
            if (task.name != "strip\${variantName}DebugSymbols") return
            task.doLast {
                def aar = fileTree(multicaFbjniCache) { include "**/*.aar" }.files.find { true }
                if (aar == null) {
                    logger.warn("multica: fbjni ${FBJNI_VERSION} aar not found in \${multicaFbjniCache}")
                    return
                }

                def staging = new File(buildDir, "multica-fbjni-libcxx")
                project.copy {
                    from zipTree(aar)
                    include "jni/**/libc++_shared.so"
                    into staging
                }

                def libRoot = null
                task.outputs.files.files.each { out ->
                    if (!out.isDirectory()) return
                    if (out.name == "lib") { libRoot = out; return }
                    def nested = new File(out, "lib")
                    if (nested.isDirectory()) { libRoot = nested; return }
                    (out.listFiles() ?: []).each { child ->
                        if (libRoot == null && child.isDirectory() && child.name == "lib") libRoot = child
                    }
                }
                if (libRoot == null) {
                    logger.warn("multica: no lib directory among strip task outputs")
                    return
                }

                libRoot.eachDir { abiDir ->
                    def replacement = new File(staging, "jni/\${abiDir.name}/libc++_shared.so")
                    if (!replacement.isFile()) return
                    new File(abiDir, "libc++_shared.so").bytes = replacement.bytes
                    logger.lifecycle("multica: replaced libc++_shared.so for \${abiDir.name}")
                }
            }
        }
    }
}
`;

module.exports = function withFbjniLibcxx(config) {
  return withAppBuildGradle(config, (config) => {
    const marker = "multica: fbjni / libc++_shared alignment";
    // prebuild can run repeatedly on the same generated project.
    if (!config.modResults.contents.includes(marker)) {
      config.modResults.contents += GRADLE_SNIPPET;
    }
    return config;
  });
};
