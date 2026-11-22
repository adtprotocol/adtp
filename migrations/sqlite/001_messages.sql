-- ADTP node schema, v0, for SQLite.
--
-- SQLite stores text, numbers and blobs. The type names JSON, TIMESTAMP and
-- BOOLEAN below are what the driver decodes by: JSON columns hold JSON text,
-- TIMESTAMP columns hold ISO 8601 UTC strings, BOOLEAN columns hold 0 or 1.
-- Keep this file in step with migrations/postgres.

-- One row per envelope, in each direction it passed through this node.
--   direction = 'in'  : received from another node (or from a local sender) for a local recipient
--   direction = 'out' : submitted by a local address for delivery elsewhere
-- A message is named by its sender and its id together: two senders may use the same id.
CREATE TABLE messages (
  direction         TEXT      NOT NULL CHECK (direction IN ('in', 'out')),
  from_addr         TEXT      NOT NULL,
  id                TEXT      NOT NULL,
  thread_id         TEXT      NOT NULL,
  principal         TEXT,                                     -- on_behalf_of, once verified
  to_addrs          JSON      NOT NULL,                       -- array of addresses
  intent            TEXT      NOT NULL,
  priority          TEXT      NOT NULL,
  expires_at        TIMESTAMP NOT NULL,                       -- the envelope's expires_at, or its created_at + 7 days
  requires_approval BOOLEAN   NOT NULL DEFAULT 0,
  sender_type       TEXT      CHECK (sender_type IN ('human', 'agent')),
  receipt_for       TEXT,                                     -- set when this is a status receipt: the id of the message it reports on
  envelope          JSON      NOT NULL,                       -- the signed envelope, verbatim
  content_hash      TEXT      NOT NULL,                       -- SHA-256 of the signed bytes: tells a repeat from a conflicting reuse of the id
  ack               JSON,                                     -- inbound only: the signed receipt this node returned (returned again for repeats)
  created_at        TIMESTAMP NOT NULL,                       -- when this node stored the message
  PRIMARY KEY (direction, from_addr, id)
);

CREATE INDEX messages_thread_idx ON messages (thread_id, created_at);
CREATE INDEX messages_created_idx ON messages (created_at DESC);
CREATE INDEX messages_id_idx ON messages (id);

-- One row per (message, recipient): the unit of work for the queue worker and
-- the place delivery status lives.
--   inbound : held -> pending -> delivered -> read -> replied   (or rejected / expired / failed)
--   outbound: pending -> sent -> delivered -> read -> replied   (or rejected / expired / failed)
CREATE TABLE deliveries (
  seq             INTEGER   PRIMARY KEY AUTOINCREMENT,        -- creation order; breaks ties between deliveries due at the same instant
  direction       TEXT      NOT NULL,
  from_addr       TEXT      NOT NULL,                         -- the message's sender (part of its name)
  message_id      TEXT      NOT NULL,
  recipient       TEXT      NOT NULL,
  state           TEXT      NOT NULL CHECK (state IN
                    ('held', 'pending', 'sent', 'delivered', 'read', 'replied', 'rejected', 'expired', 'failed')),
  attempts        INTEGER   NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMP NOT NULL,
  last_error      TEXT,
  channel         TEXT,                                       -- inbound: adapter that delivered it
  target          TEXT,                                       -- inbound: channel destination used (private)
  native_id       TEXT,                                       -- inbound: the channel's own id for the delivered item
  token           TEXT      UNIQUE,                           -- inbound: unguessable handle for read tracking and reply matching
  remote_ack      JSON,                                       -- outbound: the receipt returned by the recipient's node
  delivered_at    TIMESTAMP,
  read_at         TIMESTAMP,
  replied_at      TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL,
  UNIQUE (direction, from_addr, message_id, recipient),
  FOREIGN KEY (direction, from_addr, message_id) REFERENCES messages (direction, from_addr, id) ON DELETE CASCADE
);

CREATE INDEX deliveries_due_idx ON deliveries (next_attempt_at) WHERE state = 'pending';
CREATE INDEX deliveries_held_idx ON deliveries (recipient) WHERE state = 'held';
CREATE INDEX deliveries_message_idx ON deliveries (message_id);

-- Who each local address has interacted with. A sender with no row here (and
-- not on the address's configured trusted list) is "unknown" to that recipient.
CREATE TABLE contacts (
  owner      TEXT      NOT NULL,                              -- local address
  peer       TEXT      NOT NULL,                              -- the other party
  source     TEXT      NOT NULL CHECK (source IN ('outbound', 'approved')),
  created_at TIMESTAMP NOT NULL,
  PRIMARY KEY (owner, peer)
);

-- Fixed-window counters for rate limiting unknown senders.
CREATE TABLE rate_counters (
  key          TEXT      NOT NULL,
  window_start TIMESTAMP NOT NULL,
  count        INTEGER   NOT NULL,
  PRIMARY KEY (key, window_start)
);

-- The event feed local agents read through the node's API (GET /api/v0/events).
--   type = 'message': a message was handed to the address by the agent channel
--   type = 'status' : a message the address sent reached a new state
-- seq orders events per address; the feed is read with "everything after seq N".
CREATE TABLE events (
  seq        INTEGER   PRIMARY KEY AUTOINCREMENT,
  address    TEXT      NOT NULL,                              -- the local address the event is for
  type       TEXT      NOT NULL CHECK (type IN ('message', 'status')),
  message_id TEXT      NOT NULL,
  thread_id  TEXT      NOT NULL,
  data       JSON      NOT NULL,
  created_at TIMESTAMP NOT NULL
);

CREATE INDEX events_address_seq_idx ON events (address, seq);

-- Delegation tokens issued by this node's addresses that were taken back before they expired.
CREATE TABLE revoked_delegations (
  jti        TEXT      PRIMARY KEY,
  revoked_at TIMESTAMP NOT NULL
);
