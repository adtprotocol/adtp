/**
 * Canonical JSON for signing: RFC 8785 (JSON Canonicalization Scheme).
 *
 * - object members sorted by the UTF-16 code units of their names
 * - no insignificant whitespace
 * - numbers and strings serialized as ECMAScript's JSON.stringify does
 * - no NaN or Infinity, and no strings that are not valid Unicode (lone surrogates)
 * - `undefined` members are omitted (they do not exist in JSON)
 */
// A surrogate code unit that is not half of a pair.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function canonicalString(value: string): string {
  if (LONE_SURROGATE.test(value)) throw new TypeError('cannot canonicalize a string that is not valid Unicode');
  return JSON.stringify(value);
}

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return canonicalString(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('cannot canonicalize a non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((v) => canonicalize(v === undefined ? null : v)).join(',') + ']';
      }
      const obj = value as Record<string, unknown>;
      const members: string[] = [];
      // Array.prototype.sort on strings compares UTF-16 code units, which is the order RFC 8785 asks for.
      for (const key of Object.keys(obj).sort()) {
        const v = obj[key];
        if (v === undefined) continue;
        members.push(canonicalString(key) + ':' + canonicalize(v));
      }
      return '{' + members.join(',') + '}';
    }
    default:
      throw new TypeError(`cannot canonicalize a value of type ${typeof value}`);
  }
}
