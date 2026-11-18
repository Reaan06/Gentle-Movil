/**
 * Expo config plugin: keep `expo.useLegacyPackaging=true` in the generated
 * `android/gradle.properties` (T9a, `odd/tasks/mobile-app.md`).
 *
 * Why the app needs it: `mobile/modules/gentle-core/android/src/main/jniLibs/`
 * carries the bundled phone runtime (node + gentle-ai as `lib*.so`, built by
 * `scripts/fetch-runtime.sh`). With the Expo default
 * (`jniLibs.useLegacyPackaging = false`) the APK stores those entries
 * uncompressed inside the archive and `ApplicationInfo.nativeLibraryDir`
 * becomes a pseudo path (`…/base.apk!/lib/arm64-v8a`) with no file on disk —
 * and SELinux forbids executing anything the app writes to its own data dir, so
 * `GcRuntimePackage.kt` would have nothing to exec. Legacy packaging makes the
 * installer extract every `lib/<abi>/*.so` into `nativeLibraryDir`, which is the
 * one place an app may spawn a process from.
 *
 * Why a plugin and not a hand edit: `mobile/android/` is generated. Every
 * `expo prebuild` (and `expo prebuild --clean`, which already cost this project
 * a `.so` once) rewrites `android/gradle.properties` from the template, so the
 * property has to be re-applied by a plugin or it silently disappears.
 *
 * Mechanism: `withGradleProperties` from `expo/config-plugins`
 * (`@expo/config-plugins` 58.x, the version `expo` 58.0.26 depends on) — the
 * documented `gradleProperties` mod. `config.modResults` is the parsed property
 * list (`{type:'property'|'comment'|'empty', key, value}`) produced by
 * `AndroidConfig.Properties.parsePropertiesFile`, and the mod serializes it back
 * with `propertiesListToString`. Idempotent by construction: the same key is
 * rewritten in place when it exists (whatever its value, duplicates included)
 * and appended only when it is absent, so repeated prebuilds never add a second
 * line.
 *
 * No new dependency: `expo/config-plugins` re-exports `@expo/config-plugins`,
 * which ships with Expo.
 */

const { withGradleProperties } = require('expo/config-plugins');

/** Gradle property that decides whether native libs are extracted from the APK. */
const PACKAGING_KEY = 'expo.useLegacyPackaging';

/** The only value that makes `nativeLibraryDir` a real directory. */
const PACKAGING_VALUE = 'true';

/**
 * Ensures the property is present exactly once with the wanted value.
 *
 * Pure function over the mod's property list, so the rule is one sentence: keep
 * the first occurrence (rewritten) and drop the extra ones, or append it at the
 * end when the file does not mention it. `propertiesListToString` skips
 * `undefined` entries, so removal is `undefined` in place of the duplicate.
 *
 * @param {Array<{type: string, key?: string, value?: string}>} properties
 * @returns {Array} a new list; the input is not mutated
 */
function withLegacyPackagingProperty(properties) {
  const list = Array.isArray(properties) ? properties.slice() : [];
  let kept = false;
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index];
    if (entry === null || typeof entry !== 'object' || entry.type !== 'property') {
      continue;
    }
    if (entry.key !== PACKAGING_KEY) {
      continue;
    }
    if (kept) {
      list[index] = undefined;
      continue;
    }
    list[index] = { type: 'property', key: PACKAGING_KEY, value: PACKAGING_VALUE };
    kept = true;
  }
  if (!kept) {
    list.push({ type: 'property', key: PACKAGING_KEY, value: PACKAGING_VALUE });
  }
  return list;
}

/**
 * The plugin itself: `expo.plugins` entry, so prebuild applies it every time.
 *
 * @param {import('expo/config').ExpoConfig} config
 * @returns {import('expo/config').ExpoConfig}
 */
module.exports = function withLegacyPackaging(config) {
  return withGradleProperties(config, (gradleConfig) => {
    gradleConfig.modResults = withLegacyPackagingProperty(gradleConfig.modResults);
    return gradleConfig;
  });
};

// Exported so the rule can be exercised without running a prebuild.
module.exports.withLegacyPackagingProperty = withLegacyPackagingProperty;
module.exports.PACKAGING_KEY = PACKAGING_KEY;
module.exports.PACKAGING_VALUE = PACKAGING_VALUE;
