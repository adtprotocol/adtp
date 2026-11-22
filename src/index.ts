/**
 * The public surface of the node, for code that embeds it instead of running
 * the `adtp` command: a wrapper that serves many domains, a test harness, a
 * custom channel.
 *
 * The four seams a wrapper replaces are KeyStore, Store, DomainResolver and
 * TokenVerifier. Each has a default implementation here; ARCHITECTURE.md
 * ("Seams") says what each one is asked.
 */

// The node and its HTTP surface.
export { AdtpNode, type DelegationGrant, type NodeOptions } from './core/node.js';
export { createApp, type AppOptions } from './http/app.js';
export { OperationError } from './core/context.js';
export type { Draft, Submitted } from './core/sender.js';

// Seam: signing keys, per hosted address.
export { Keyring, type KeyStore, type Rotation } from './identity/keyring.js';
export type { Signer } from './protocol/signing.js';

// Seam: storage.
export { SqlStore, type Store } from './core/store.js';
export type { DeliveryKey, DeliveryRow, DeliveryState, EventRow, MessageRow, MessageView } from './core/store.js';
export { openDatabase } from './db/index.js';
export type { Db, Queryable } from './db/index.js';

// Seam: which addresses this node answers for.
export { ConfigDomainResolver, type DomainResolver } from './core/domains.js';

// Seam: who a bearer token belongs to.
export { StaticTokens, type Role, type TokenVerifier } from './http/tokens.js';

// Configuration.
export { loadConfig, parseConfig, ConfigError, DEFAULT_PORT } from './config.js';
export type { AddressConfig, NodeConfig, Route } from './config.js';

// Discovery of other nodes' addresses.
export { Discovery, DiscoveryError, type DirectoryResolver, type Resolver } from './identity/discovery.js';

// Channels.
export { AdapterRegistry } from './adapters/registry.js';
export type { AdapterCapabilities, ChannelAdapter, DeliveryReceipt, IngestedMessage, RenderContext } from './adapters/types.js';

// The protocol itself: types, constants and the functions that implement SPEC.md.
export * from './protocol/constants.js';
export type * from './protocol/types.js';
export { canonicalize } from './protocol/canonical.js';
export { validateEnvelope, receiptOf, textOf } from './protocol/envelope.js';
export { contentHash, signEnvelope, signObject, verifySignature } from './protocol/signing.js';
export { mintDelegation, verifyDelegation, type DelegationClaims } from './protocol/delegation.js';
export { buildCard, parseCard } from './protocol/cards.js';
export { buildDirectory, parseDirectory } from './protocol/directory.js';
export { parseResponse, toResponse } from './protocol/wire.js';

// A small client for a node's local API.
export { AdtpClient, AdtpClientError } from './client.js';
