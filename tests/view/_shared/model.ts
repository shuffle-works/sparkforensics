import type { AppResources, SparkAppInfo, Stage } from '@sparkforensics/core/types';

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** A test fixture stage holding only the fields the test needs. Every field given must exist on
 * the stage with its declared type, but fields a test doesn't read may be left out. */
export function testStage(fields: { id: number } & Partial<Stage>): Stage {
  return fields as Stage;
}

/** A test fixture app holding only the fields the test needs, with `resources` as deep as the test
 * sets it. */
export function testApp(fields: Omit<SparkAppInfo, 'resources'> & { resources?: DeepPartial<AppResources> }): SparkAppInfo {
  return fields as SparkAppInfo;
}
