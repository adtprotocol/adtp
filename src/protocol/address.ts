/** ADTP addresses are `local@domain`, compared case-insensitively. */

const LOCAL_RE = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;
const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export interface ParsedAddress {
  local: string;
  domain: string;
  address: string;
}

export function parseAddress(input: unknown): ParsedAddress | null {
  if (typeof input !== 'string') return null;
  const value = input.trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!LOCAL_RE.test(local) || !DOMAIN_RE.test(domain)) return null;
  return { local, domain, address: `${local}@${domain}` };
}

export function normalizeAddress(input: string): string {
  const parsed = parseAddress(input);
  if (!parsed) throw new Error(`invalid ADTP address: ${JSON.stringify(input)}`);
  return parsed.address;
}

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

export function localOf(address: string): string {
  return address.slice(0, address.lastIndexOf('@')).toLowerCase();
}

export function isValidLocalPart(local: string): boolean {
  return LOCAL_RE.test(local);
}

export function isValidDomain(domain: string): boolean {
  return DOMAIN_RE.test(domain);
}
