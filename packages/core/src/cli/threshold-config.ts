// Reads a --thresholds config file for the CLI and the MCP server. Every failure throws an Error
// naming the file and the problem, so the caller refuses to run instead of quietly falling back
// to the defaults the user meant to change.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseThresholdOverrides } from '../threshold-overrides.ts';
import type { ThresholdOverrides } from '../detectors.ts';

export function loadThresholdOverrides(path: string): ThresholdOverrides {
  const fullPath = resolve(path);
  let text: string;
  try {
    text = readFileSync(fullPath, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read thresholds file ${fullPath}: ${(e as Error).message}`, { cause: e });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Thresholds file ${fullPath} is not valid JSON: ${(e as Error).message}`, { cause: e });
  }
  try {
    return parseThresholdOverrides(raw);
  } catch (e) {
    throw new Error(`Thresholds file ${fullPath}: ${(e as Error).message}`, { cause: e });
  }
}
