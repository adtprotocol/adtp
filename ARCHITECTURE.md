# Architecture

An ADTP node is one Node.js process and one database. The process serves HTTP,
runs a queue worker, and talks SMTP. By default the database is a SQLite file
next to the signing key, so a node is a single container with one data volume.
Postgres can take its place with one setting. The signing key and the two API
tokens are files (or environment variables), never database rows.

The protocol the node speaks is specified in [SPEC.md](SPEC.md). This document
is about how the node is built.

## Components

```
        other ADTP nodes                             a local agent
     │ POST /adtp/v0/messages  ▲ POST {their endpoint}   │ ▲  /api/v0 (send, events, read)
     ▼                         │                         ▼ │
 ┌──────────────────────────────────────────────────────────────────┐
 │ http/app.ts          messages endpoint, cards, hooks, API,       │
 │                      admin UI                                    │
 │ http/tokens.ts       who a bearer token belongs to (seam)        │
 ├──────────────────────────────────────────────────────────────────┤
 │ core/receiver.ts     inbound pipeline: validate, verify, trust,  │
 │                      store, signed receipt                       │
 │ core/sender.ts       build + sign envelopes, queue them          │
 │ core/worker.ts       the queue: retries, backoff, expiry, purge  │
 │ core/events.ts       the feed local agents read                  │
 │ core/routing.ts      pick a route for a message                  │
 │ core/domains.ts      which addresses this node answers for (seam)│
 │ core/store.ts        every SQL statement, one dialect (seam)     │
 │ core/node.ts         wiring, tray, read/reply events, views      │
 ├───────────────────────┬──────────────────────────────────────────┤
 │ identity/keyring.ts   │ adapters/registry.ts   channel plugins   │
 │   signing keys (seam) │ adapters/email.ts      SMTP out, replies │
 │ identity/discovery.ts │                        in via webhook    │
 │ identity/safe-http.ts │ adapters/agent.ts      the event feed    │
 ├───────────────────────┴──────────────────────────────────────────┤
 │ protocol/            the wire format: envelope, canonical JSON,  │
 │                      signatures, delegation, cards, HTTP answers │
 ├──────────────────────────────────────────────────────────────────┤
 │ db/                  one interface, two drivers                  │
 └──────────────────────────────────────────────────────────────────┘
        │                          │                      │
  adtp.db (SQLite)         keyring.json (0600)         SMTP server
  or Postgres
```

| Path | Responsibility |
|------|----------------|
| `src/protocol/` | Pure functions that implement [SPEC.md](SPEC.md). No I/O. If the spec changes, this is where the change goes. |
| `src/identity/keyring.ts` | The `KeyStore` seam and its default: generates, stores and rotates one Ed25519 key. Hands out a signer; the private key never leaves the module. |
| `src/identity/discovery.ts` | Resolves `local@domain` to a card: local addresses, override, DNS TXT, well-known fallback. Follows redirects, caches results, records how each card was found. Finds a domain's directory the same way. |
| `src/identity/safe-http.ts` | The only HTTP client used for URLs chosen by other parties. Blocks private addresses. |
| `src/core/receiver.ts` | Everything between "an envelope arrived" and "an answer went back". |
| `src/core/sender.ts` | Turns a draft from a local address into a signed, stored, queued envelope. Signs delegations for agents with `acts_for`. Builds status receipts. |
| `src/core/worker.ts` | Claims due deliveries, attempts them, checks the other node's receipt, reschedules or finishes them. Runs the expiry sweep and the purge. |
| `src/core/events.ts` | The per-address event feed: messages handed to agents, status updates for what they sent. Long polling. |
| `src/core/domains.ts` | The `DomainResolver` seam and its default: the addresses in the config file. |
| `src/core/store.ts` | The `Store` seam and its default: all SQL, written once for both databases. Every state change is a guarded `UPDATE ... WHERE state IN (...)`. |
| `src/db/` | The database seam under the default store: a `Db` interface (query, transaction, migrate) with a SQLite driver and a Postgres driver that return rows in the same shape. |
| `src/core/node.ts` | Composition root (`AdtpNode`): tray approve/reject, read and reply events, delegations, thread views. |
| `src/adapters/` | The adapter interface, the registry, and the two built-in channels: email and agent. |
| `src/http/` | Router, endpoints, the `TokenVerifier` seam, server-rendered admin pages. |
| `src/index.ts` | What the package exports to code that embeds the node. |
| `src/cli.ts` | `adtp start`, `keys`, `delegate`, `revoke`, `send`, `status`, `resolve`. |
| `integrations/stratus/adtp-tool.ts` | The agent-side tool: `adtp_send`, `adtp_on_status`, `adtp_on_message`. One file, no imports. |

## Message lifecycle

A message crosses two nodes. Each keeps its own copy and its own state.

```
 sender's node                                 recipient's node
 ─────────────                                 ────────────────
 submit (API / reply ingest)
   build envelope, sign, INSERT (out)
   delivery: pending
        │
   worker: resolve recipient's card
           POST the envelope ───────────────▶  1 receive
                                               2 verify
                                               3 store
   check the receipt's signature
   delivery: sent  ◀────── signed receipt ───  4 answer (202 accepted | queued, or an error)
                                               5 route   (held deliveries wait in the tray)
                                               6 deliver (channel adapter)
   delivery: delivered ◀── status message ───  7 status: delivered
   delivery: read      ◀── status message ───            read
   delivery: replied   ◀── status message ───            replied
```

### 1. Receive

`POST /adtp/v0/messages` takes one envelope as its body, with
`Content-Type: application/adtp+json`. Anything else is `415`; a body over
262144 bytes is `413`. The handler parses the JSON and passes it to
`Receiver.handle`, which returns the answer and whether the envelope was a
repeat. `protocol/wire.ts` turns that into an HTTP status and body.

### 2. Verify

In the order [SPEC.md section 8](SPEC.md#8-what-a-receiving-node-does) gives:

1. **Shape.** Required fields, a known intent and priority, RFC 3339 times, at
   least one non-empty text part, valid addresses, a signature object.
   Failure: `invalid_envelope`.
2. **Clock.** `created_at` more than five minutes ahead: `invalid_envelope`.
3. **Recipient.** At least one `to` address must be hosted here
   (`DomainResolver.lookup`). Failure: `unknown_recipient`.
4. **Signature.** Resolve the sender's card and verify the Ed25519 signature
   over the canonical envelope against the key its `kid` names. If the cached
   card does not list that key, fetch the card afresh once (the sender may
   have rotated). Card fetches for one address are limited to one a minute; if
   that limit, or a failed fetch, means no fresh look can be taken, the answer
   is the retryable `sender_unresolvable` with `Retry-After`, because the key
   might simply be new. Only a fresh card that still lacks the key is a
   `bad_signature`. Failures: `sender_unresolvable` (retryable),
   `bad_signature`. The same goes for the principal's key in step 5.
5. **Delegation.** If `on_behalf_of` is present there must be a `delegation`
   token. Resolve the principal's card and verify the token: signed by the
   principal, issued to this `from`, meant for this node (`aud`), covering this
   intent (`scope`), not expired. If the principal is hosted here, the token's
   `jti` must not be on the revocation list. Failures:
   `principal_unresolvable` (retryable), `delegation_invalid`.
6. **Seen before.** If this sender already has a stored message with this id:
   the same signed bytes are a repeat and get the stored receipt back; other
   bytes are an `id_conflict`. Another sender using the same id is simply
   another message.
   One exception to "the stored receipt": a recipient that was turned away for
   a retryable reason (`rate_limited`) while another recipient took the
   message is decided again on each repeat, as in step 8. If it can be taken
   now, the stored message gains a delivery for it and the receipt is updated
   and re-signed, in one transaction. Recipients that already took the message
   are never touched.
7. **Time.** `expires_at` in the past, or `created_at` older than
   `limits.max_age_days`: `expired`.
8. **Trust**, per local recipient. A sender is known if it is on the
   recipient's `trusted` list or has interacted with it before, and is then
   accepted. An unknown sender may only use `inform` or `request`
   (`not_trusted` otherwise), is counted against the hourly limits
   (`rate_limited`, retryable, with `Retry-After`), and is held for the
   requests tray.

### 3. Store

One transaction inserts the message row (with its content hash and the signed
receipt it is about to return) and one delivery row per accepted or held
recipient. The primary key is `(direction, from_addr, id)`, and `ON CONFLICT DO
NOTHING` on it makes concurrent repeats safe: the loser reads the winner's
receipt and returns that. Refused messages are not stored.

### 4. Answer

Only after the commit does the answer go back: `202` with a receipt that says
`accepted` (being delivered) or `queued` (held for approval), signed with the
key of one of the recipients (`by`). The receipt also says what was verified:
the id of the key the envelope's signature checked out against, and the
principal whose delegation was valid. A repeat gets `200` and the same receipt.
A refusal is an HTTP error with `{ error, message, retryable }`.

If anything throws before the commit the caller gets `500` with
`retryable: true` and nothing was stored, so the sending node retries.

On the sending side, the worker accepts a `202` or `200` only if the receipt
names this message, is signed by one of its recipients on that node, and the
signature verifies against that recipient's card. A receipt it cannot trust
counts as no answer: the delivery stays pending and is retried.

### 5. Route

The worker picks up `pending` inbound deliveries. For each it evaluates the
recipient's `routes` against `priority`, `intent`, `from_org` (sender's
domain) and `sender_type` (from the sender's card): first matching route in
config order, else the default route, else the delivery fails with "no route".

Held deliveries wait. `approve` records the sender as a contact and moves
every held delivery from that sender to `pending`; `reject` moves one to
`rejected`.

### 6. Deliver

The route names a channel; the registry returns its adapter:

```
render(message, context) -> native payload
deliver(payload)         -> receipt { native_id }
ingest(native event)     -> ADTP message (or null)
capabilities()
```

- **`email`** renders text first, then a summary of structured parts, then the
  message facts, and sends over SMTP. Replies come back through
  `POST /hooks/email`.
- **`agent`** puts the message, together with what the node verified, on the
  recipient's event feed. The agent reads it from there (next section).

A failure is retried with exponential backoff; after `delivery.max_attempts`
the delivery is `failed`, and the sender is told with a `failed` receipt (which
does not say why: that is this node's business). The deadline is checked before
every attempt and again just before handing over, and a sweep marks overdue
held or pending deliveries `expired`.

### 7. Status

Each forward step on the recipient's side queues a `status` message back to
the sender through the normal outbound path. The step and its receipt are
stored in one transaction (`Store.transitionWith`), so a delivery is never
recorded as delivered, read, replied or failed without the receipt that says
so. If that write fails, the delivery stays where it was and the step is
repeated: by the worker once the attempt's lease runs out, or by whoever
reported the read or the reply. A reply goes one step further: the reply
itself, the `replied` state and the `replied` receipt are one transaction
(`Store.saveReply`), with the receipt queued ahead of the reply, so a sender is
never told a message was answered when no answer is on its way.

- `delivered`: the adapter accepted the message.
- `read`: the email's image was loaded (`GET /r/{token}.gif`), or the agent
  called `POST /api/v0/messages/{id}/read`.
- `replied`: a reply was ingested from email, or the agent sent a message with
  `in_reply_to`. The reply itself travels as a new `inform` on the same thread.
  Only a message addressed to the sender of the one it names counts, and only
  if it was stored: one that reuses an id already submitted is thrown away and
  marks nothing.
- `failed`: delivery was given up (see step 6).

An address with `auto_reply` set is answered by the node itself. At the end of
each worker pass the node takes what was delivered to such an address and
either stores a reply (which makes the message `replied`, as above) or marks
it `read` when no reply is due: the message is itself automatic, the address
already wrote on the thread, or the sender has had its share for the hour.

On the sender's node these arrive as ordinary signed messages. The receiver
recognizes the receipt part, checks that it comes from the recipient of the
message it names, advances that outbound delivery, stores the receipt in the
thread, and stops: receipts are not routed to a channel. Storing the receipt,
advancing the delivery and writing the sender's status events happen in one
transaction. The stored receipt is what makes a retry of it a duplicate, so if
any part fails nothing is kept and the other node's retry is processed in
full.

Two details keep the sequence sensible under real timing:

- Deliveries to the same recipient are attempted one after another in creation
  order, so a peer hears `read` before `replied`, and `replied` before the
  reply. A receipt that still arrives late (after a retry) is recorded and
  reported without moving the state backwards.
- An agent can react faster than the worker finishes its own bookkeeping. A
  read or reply for a delivery that is mid-attempt proves the handoff happened,
  so it is settled as `delivered` first, then the read or reply is applied.

### Delivery states

```
inbound   held ──approve──▶ pending ──▶ delivered ──▶ read ──▶ replied
            │                  │
            └▶ rejected        └▶ expired | failed
            └▶ expired

outbound  pending ──▶ sent ──▶ delivered ──▶ read ──▶ replied
             │          │
             │          └▶ failed   (the other node reported it could not deliver)
             └▶ rejected | expired | failed
```

### The queue

There is no separate queue system. `deliveries` rows with `state = 'pending'`
and `next_attempt_at <= now` are the queue, for both directions.

- **Claim.** The worker reads the due rows, then takes each with an `UPDATE`
  that bumps `attempts` and pushes `next_attempt_at` two minutes out, but only
  if `attempts` still has the value it read. That compare-and-swap means two
  workers never take the same row, on either database, and the lease means a
  crashed attempt is retried.
- **Order.** Oldest first by due time, then by a creation sequence, so
  deliveries created in the same millisecond still have a defined order.
- **Finish.** Every outcome is `UPDATE ... WHERE state = 'pending'`, so a
  result that arrives after the row moved on (a receipt overtaking the ack,
  an expiry sweep) is a no-op. An outcome is stored together with what tells
  someone about it: the status event for the local sender, or the receipt for
  the other node.
- **Before every outbound attempt** the worker checks the deadline, and, if
  the message carries a delegation from a principal hosted here, that the
  delegation has not been revoked since the message was queued. A revoked one
  ends the delivery as `rejected` without anything going on the wire.
- **Backoff.** Attempt *n* waits between half of and all of
  `min(backoff_max, backoff_base * 2^(n-1))` seconds.
- **Backoff, with a floor.** When the other node answers `429` with
  `Retry-After`, the next attempt is never sooner than that.
- **Wake-ups.** The loop polls every `delivery.poll_interval_ms` and is nudged
  immediately when new work is stored.
- **Housekeeping.** Every ten minutes the same loop prunes old rate-limit
  windows and events, and purges messages that arrived more than
  `limits.retention_days` ago and have been expired for at least a day. A
  stored message is also the record that stops its id from being accepted
  twice, so it is never purged while it could still be accepted.

## Agents and the event feed

An agent running next to a node does not hold keys and does not need to listen
on a port. It uses three calls on the node's local API, all with the agent
token:

| Call | Purpose |
|---|---|
| `POST /api/v0/messages` | Send. The node fills in `on_behalf_of` and signs a delegation if the agent has `acts_for`, then signs and queues the envelope. |
| `GET /api/v0/events?address=…&after=N&wait=20` | Everything for that address after sequence `N`. With `wait`, the request is held open until an event arrives. |
| `POST /api/v0/messages/{id}/read` | Tell the sender the agent has read a message. |

The feed carries two kinds of event:

```json
{ "seq": 41, "type": "message", "address": "echo@demo.adtp.dev", "at": "2026-11-21T01:00:17.010Z",
  "message": { "id": "msg_01M7…", "thread": "thr_01M7…", "from": "agent@stratuslabs.com",
               "on_behalf_of": "dylan@stratuslabs.com", "intent": "request", "created_at": "2026-11-21T01:00:16Z",
               "text": "Hello…", "parts": [ … ] },
  "verified": { "signature": "ed25519-7aea005a1639ab5a", "delegation": "dylan@stratuslabs.com" } }

{ "seq": 17, "type": "status", "address": "agent@stratuslabs.com", "at": "2026-11-21T01:00:17.011Z",
  "message_id": "msg_01M7…", "thread": "thr_01M7…", "recipient": "echo@demo.adtp.dev", "status": "read" }
```

`message` events come from the agent channel, and from the inbox channel,
which is the same adapter under a second name for addresses whose owner reads
on the node's inbox page (`/admin/inbox`). `status` events are written when
an outbound delivery is acknowledged (`accepted` or `queued`, with what the
other node verified and whose signed receipt this node checked), when a status
receipt arrives (`delivered`, `read`, `replied`, `failed`), and when a delivery
ends badly on this side (`rejected`, `failed`, `expired`).

**Two tokens.** The agent token can do what this section describes, plus read
message status, threads and how an address resolves. It is held to the node's
agent addresses: it cannot send as a person, read a person's feed or a person's
messages and threads, or have the node sign a delegation from a principal the
agent is not configured to act for. The requests tray, delegations and the admin pages need the admin token.
One agent token serves every agent on the node; per-agent tokens would come in
through the `TokenVerifier` seam.

Events are rows in the database, ordered per address by a sequence number.
Sequence order has to equal commit order, or a reader paging with "after N"
could skip an event. SQLite's single writer gives that for free; on Postgres a
per-address advisory lock does. Long polls are woken in-process and re-check
once a second, which also covers a second node process on the same Postgres.
Events are kept for seven days.

## Database

### Two databases, one store

| | SQLite (default) | Postgres |
|---|---|---|
| Selected by | no `database_url` | `database_url: postgres://…` or `DATABASE_URL` |
| Lives in | `adtp.db` in the data directory | a server you run |
| Driver | `node:sqlite`, built into Node | `pg` |
| Fits | one node process on one machine | several processes, or a managed database |

`src/core/store.ts` holds every statement and is written once: plain SQL with
`$1` parameters, upserts, guarded updates. It uses nothing only one of the two
has, with one exception, the advisory lock that orders events on Postgres.
Results that would need database-specific SQL (a message with its per-recipient
delivery summaries) are assembled in code instead.

The drivers make rows look the same from both: timestamps come back as `Date`,
JSON columns parsed, booleans as booleans. Postgres does that natively. SQLite
stores text and numbers, so `migrations/sqlite` declares columns as `JSON`,
`TIMESTAMP` and `BOOLEAN`, and the driver decodes by those declared types.
Timestamps are stored as ISO 8601 UTC strings, which compare and sort
correctly as text.

SQLite runs in write-ahead-log mode with one connection. Statements execute
synchronously, but the code issuing them is async, so the driver queues them:
a statement from another request can never land inside an open transaction.
The database file is created owner-only, like the keyring.

The same test suite runs against both (`npm test`, `npm run test:postgres`).

### Schema

One file per database under `migrations/`, kept in step. Migrations run at
startup and are recorded in `schema_migrations`; on Postgres under an advisory
lock so two starting nodes do not race.

**`messages`**: one row per envelope per direction. Primary key
`(direction, from_addr, id)`: a message is named by its sender and its id
together.

| Column | Notes |
|--------|-------|
| `direction` | `in` (received for a local recipient) or `out` (submitted by a local address) |
| `id`, `thread_id` | Message id; thread id (the message id if the envelope has no thread) |
| `from_addr`, `to_addrs`, `principal` | Normalized addresses (`to_addrs` is a JSON array); `principal` is the verified `on_behalf_of` |
| `intent`, `priority`, `expires_at`, `requires_approval` | Copied out of the envelope for querying. `expires_at` is never null: without one in the envelope it is `created_at` plus seven days |
| `sender_type` | `human` or `agent`, from the sender's card |
| `receipt_for` | Set on status receipts: the id of the message reported on |
| `envelope` | The signed envelope, verbatim (stored as JSON text, so key order survives) |
| `content_hash` | SHA-256 of the signed bytes. Tells a repeat from a different message under the same id |
| `ack` | Inbound only: the signed receipt returned, and returned again for repeats |
| `created_at` | When this node stored the message (the envelope has its own `created_at`) |

Indexes: `(thread_id, created_at)` for thread history, `(created_at DESC)` for
the inbox and the purge, `(id)` for lookups by id alone.

**`deliveries`**: one row per message per recipient. Unique on
`(direction, from_addr, message_id, recipient)`, with a cascading foreign key to
`messages`, so purging a message removes its deliveries.

| Column | Notes |
|--------|-------|
| `seq` | Creation order; breaks ties between deliveries due at the same instant |
| `state` | `held`, `pending`, `sent`, `delivered`, `read`, `replied`, `rejected`, `expired`, `failed` |
| `attempts`, `next_attempt_at`, `last_error` | Retry bookkeeping |
| `channel`, `target`, `native_id` | Inbound: adapter used, private channel destination, the channel's own id |
| `token` | Inbound: unguessable handle used by the read image and reply matching (unique) |
| `remote_ack` | Outbound: the signed receipt from the recipient's node, kept as proof |
| `delivered_at`, `read_at`, `replied_at`, `updated_at` | |

Partial indexes: `(next_attempt_at) WHERE state = 'pending'` for the worker,
`(recipient) WHERE state = 'held'` for the tray.

**`contacts`**: `(owner, peer)` with `source` (`outbound` or `approved`). A
sender with no row for a recipient, and not on its `trusted` list, is unknown
to that recipient.

**`rate_counters`**: `(key, window_start) -> count`. Keys are `sender:{address}`
and `org:{domain}`; windows are whole hours. Old windows are pruned by the worker.

**`events`**: the agent feed. `seq` (primary key), `address`, `type`
(`message` or `status`), `message_id`, `thread_id`, `data` (json),
`created_at`. Index `(address, seq)`.

**`revoked_delegations`**: `jti`, `revoked_at`. Delegation tokens issued by this
node's addresses that were taken back before they expired.

## On the wire

[SPEC.md](SPEC.md) is the reference. In brief, as this node does it:

- **One endpoint.** `POST /adtp/v0/messages` takes a signed envelope and
  answers with a signed receipt or an error body. Status receipts are envelopes
  too and arrive the same way.
- **One card per address**, at `/.well-known/adtp/{local}`: the endpoint, the
  public keys, the accepted intents, the size limit.
- **One directory per domain**, at `/.well-known/adtp`: the addresses marked
  `listed` in the config, each with its type and description. It is built from
  the same address list as the cards (`DomainResolver.list()`), carries no keys
  and no endpoint, and is empty until an address is listed.
- **Everything signed is canonical JSON.** `protocol/canonical.ts` implements
  RFC 8785 and `protocol/signing.ts` signs "the object without its `signature`
  member", for envelopes and receipts alike. The signature names its key, and
  only that key is tried.
- **`protocol/wire.ts`** is the one place that knows HTTP status codes: it maps
  the receiver's verdict to a response, and a response back to a verdict on
  the sending side.

**Discovery.** To find the card for `local@domain`:

1. If the node hosts the address, answer locally.
2. If `discovery.overrides` has the domain, use that URL template.
3. Look up TXT at `_adtp.{domain}`. A record `v=adtp0; card=<url template>`
   gives the card URL after `{local}` is filled in.
4. Otherwise, or if that URL fails, use `https://{domain}/.well-known/adtp/{local}`.

Up to three redirects are followed, so the domain's main site can simply
redirect the well-known path to the node. The fetched card must be for the
address that was asked for. `GET /api/v0/resolve` shows which step produced a
card and from which URL.

A domain's directory is found the same way: answered locally for a domain the
node serves; worked out from the override, if there is one; otherwise the
`directory=<url>` field of the same TXT record, then
`https://{domain}/.well-known/adtp`. The fetched directory must be for the
domain that was asked for, and entries that are not on that domain are dropped.
Descriptions are reduced to one line of plain text before anything else sees
them. `GET /api/v0/directory` is the lookup for agents and the CLI.

## Seams

This node serves one domain, configured in one file. Four things it depends on
sit behind small interfaces, each with the single-domain implementation as its
default, so that a wrapper (one that serves many domains, say) can replace them
without forking. All four are exported from `src/index.ts` and exercised in
`test/seams.test.ts`.

| Seam | What the node asks it | Default | Pass it as |
|---|---|---|---|
| `KeyStore` | "Sign this for address X." "Which keys does X publish?" "Rotate X's key." | `Keyring`: one key for every address, in a file | `AdtpNode.create({ keys })` |
| `Store` | Everything that is persisted: messages, deliveries, contacts, rate counters, events, revocations. | `SqlStore` over SQLite or Postgres | `AdtpNode.create({ store })`, or `{ db }` for the default |
| `DomainResolver` | "Is this address mine, and what are its settings?" "Do I answer for this domain?" | `ConfigDomainResolver`: the addresses in the config file | `AdtpNode.create({ domains })` |
| `TokenVerifier` | "Whose token is this: an admin's, an agent's, or nobody's?" | `StaticTokens`: the two configured tokens | `createApp({ tokens })` |

What the seams guarantee, and what they do not:

- Nothing in `src/core` or `src/http` reaches around them. The node never reads
  the address list from the config, never touches the database except through
  the store, and signs only through the key store, always saying for which
  address. A receipt is signed with the key of the recipient it names.
- `Store` is a type derived from the default implementation's public methods,
  so the two cannot drift apart.
- `DomainResolver` is synchronous: it is asked on every message, so an
  implementation keeps what it serves in memory.
- There is no tenancy in this repository. The seams let one process answer for
  several domains with different keys; isolation between tenants, per-tenant
  limits and per-tenant storage are the wrapper's to build. Two things here
  still assume a single domain and would need attention there: the card route
  builds the address from the configured `domain`, and the config file itself.

## Adding a channel

A channel is a module that exports `register(registry)` and calls
`registry.register('slack', factory)`. The factory receives the
`channels.slack` section of the config and returns an object with `render`,
`deliver`, `ingest`, `capabilities`, and optionally `authenticate` (for
`POST /hooks/slack`). List the module under `plugins:` and routes can use
`channel: slack`. The engine needs no changes. `test/adapters.test.ts` loads
such a plugin from a file.
