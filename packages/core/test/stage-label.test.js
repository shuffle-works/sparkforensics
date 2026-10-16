import { describe, it, expect } from 'vitest';
import { stageDisplayLabel } from '../src/stage-label.ts';
import { normalizeStageName } from '../src/stage-identity.ts';

const YARN_PATH = '/hadoop/yarn/local/usercache/some-user/appcache/application_0000000000000_0001/container_0000000000000_0001_01_000001';

describe('stageDisplayLabel', () => {
  it('removes the YARN container directories and the user name from a call-site path', () => {
    const label = stageDisplayLabel(`collect at ${YARN_PATH}/etl.py:42`);
    expect(label).toBe('collect at etl.py:42');
    expect(label).not.toContain('some-user');
    expect(label).not.toContain('usercache');
  });

  it('removes a home directory path', () => {
    expect(stageDisplayLabel('save at /home/some-user/jobs/etl.py:7')).toBe('save at etl.py:7');
  });

  it('removes the scheme, authority and directories of a URI path', () => {
    expect(stageDisplayLabel('save at hdfs://namenode-host/user/some-user/out/part.py:3')).toBe('save at part.py:3');
  });

  it('reduces every path in one name', () => {
    expect(stageDisplayLabel('join at /a/b/left.py:1 and /c/d/right.py:2')).toBe('join at left.py:1 and right.py:2');
  });

  it('leaves a name without a path unchanged', () => {
    for (const name of ['showString at NativeMethodAccessorImpl.java:0', 'Exchange 10', 'read a/b', '']) {
      expect(stageDisplayLabel(name)).toBe(name);
    }
  });

  it('does not change the stage identity the pairing keys on', () => {
    const name = `collect at ${YARN_PATH}/etl.py:42`;
    expect(normalizeStageName(name)).toContain('some-user');
    expect(normalizeStageName(stageDisplayLabel(name))).not.toBe(normalizeStageName(name));
  });
});
