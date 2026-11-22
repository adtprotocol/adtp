/**
 * Which addresses this node answers for.
 *
 * A single-domain node reads this straight from its config file. The node
 * only ever asks through `DomainResolver`, so a wrapper that serves many
 * domains can answer from wherever it keeps them.
 */
import type { AddressConfig } from '../config.js';
import { domainOf } from '../protocol/address.js';

export interface DomainResolver {
  /** The settings of a hosted address, or null if this node does not serve it. Addresses are lowercase. */
  lookup(address: string): AddressConfig | null;
  /** True if this node answers for the whole domain, whether or not a particular mailbox exists on it. */
  serves(domain: string): boolean;
  /** Every hosted address. For listings (the directory, startup banner, admin pages), never on the message path. */
  list(): AddressConfig[];
}

/** The addresses listed in the config file, all on the node's one domain. */
export class ConfigDomainResolver implements DomainResolver {
  private readonly byAddress: Map<string, AddressConfig>;

  constructor(
    private readonly domain: string,
    addresses: AddressConfig[],
  ) {
    this.byAddress = new Map(addresses.map((a) => [a.address, a]));
  }

  lookup(address: string): AddressConfig | null {
    return this.byAddress.get(address) ?? null;
  }

  serves(domain: string): boolean {
    return domain === this.domain;
  }

  list(): AddressConfig[] {
    return [...this.byAddress.values()];
  }
}

/** True if `address` is on a domain this node answers for. */
export function isLocal(domains: DomainResolver, address: string): boolean {
  return domains.serves(domainOf(address));
}
