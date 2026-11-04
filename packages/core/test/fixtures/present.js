// Shared typed helpers for the core tests: a missing value or finding fails the test where it is
// read, not later on a property access.

/**
 * A value the test expects to be there.
 * @template T
 * @param {T | null | undefined} value
 * @returns {T}
 */
export function present(value) {
  if (value == null) throw new Error('Expected a value.');
  return value;
}

/**
 * The first item of `type`, or undefined; for tests that assert a finding is absent.
 * @template {{ type: string }} Item
 * @template {Item['type']} T
 * @param {Item[]} items
 * @param {T} type
 * @returns {Extract<Item, { type: T }> | undefined}
 */
export function firstOfType(items, type) {
  return items.find(/** @returns {item is Extract<Item, { type: T }>} */ (item) => item.type === type);
}

/**
 * The first item of `type`; fails the test when there is none.
 * @template {{ type: string }} Item
 * @template {Item['type']} T
 * @param {Item[]} items
 * @param {T} type
 * @returns {Extract<Item, { type: T }>}
 */
export function findingOfType(items, type) {
  const found = firstOfType(items, type);
  if (!found) throw new Error(`expected a ${type} finding`);
  return found;
}
