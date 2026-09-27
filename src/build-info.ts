// Replaced at build time by vite.config.ts's `define`; absent under vitest, hence the typeof
// guards and the 'dev' fallbacks.
declare const __SPARKFORENSICS_WEB_VERSION__: string | undefined;
declare const __SPARKFORENSICS_CORE_BUILD_ID__: string | undefined;

/** The build id of the core compiled into this bundle (`coreSourceHash` of packages/core/src). */
export const CORE_BUILD_ID: string =
  typeof __SPARKFORENSICS_CORE_BUILD_ID__ === 'string' ? __SPARKFORENSICS_CORE_BUILD_ID__ : 'dev';

/** How this app names itself in an export's provenance stamp. */
export const WEB_PRODUCER = `sparkforensics-web ${
  typeof __SPARKFORENSICS_WEB_VERSION__ === 'string' ? __SPARKFORENSICS_WEB_VERSION__ : 'dev'
}`;
