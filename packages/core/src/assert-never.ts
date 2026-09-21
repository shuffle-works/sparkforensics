export function assertNever(x: never): never {
  throw new Error(`Unreachable case: ${JSON.stringify(x)}`);
}
