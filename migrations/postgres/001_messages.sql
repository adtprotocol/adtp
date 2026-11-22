-- ADTP node schema, v0, for Postgres.
-- Keep this file in step with migrations/sqlite.

-- One row per envelope, in each direction it passed through this node.
--   direction = 'in'  : received from another node (or from a local sender) for a local recipient
--   direction = 'out' : submitted by a local address for delivery elsewhere
-- A message is named by its sender and its id together: two senders may use the same id.
CREATE TABLE messages (
  direction         text        NOT NULL CHECK (direction IN ('in', 'out')),
  from_addr         text        NOT NULL,
  id                text        NOT NULL,
  thread_id         text        NOT NULL,
  principal         text,                                   -- on_behalf_of, once verified
  to_addrs          json        NOT NULL,                   -- array of addresses
  intent            text        NOT NULL,
  priority          text        NOT NULL,
  expires_at        timestamptz NOT NULL,                   -- the envelope's expires_at, or its created_at + 7 days
  requires_approval boolean     NOT NULL DEFAULT false,
  sender_type       text        CHECK (sender_type IN ('human', 'agent')),
  receipt_for       text,                                   -- set when this is a status receipt: the id of the message it reports on
  envelope          json        NOT NULL,                   -- the signed envelope, verbatim (json, not jsonb: key order is kept)
  content_hash      text        NOT NULL,                   -- SHA-256 of the signed bytes: tells a repeat from a conflicting reuse of the id
  ack               json,                                   -- inbound only: the signed receipt this node returned (returned again for repeats)
  created_at        timestamptz NOT NULL,                   -- when this node stored the message
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
  seq             bigserial   NOT NULL UNIQUE,              -- creation order; breaks ties between deliveries due at the same instant
  direction       text        NOT NULL,
  from_addr       text        NOT NULL,                     -- the message's sender (part of its name)
  message_id      text        NOT NULL,
  recipient       text        NOT NULL,
  state           text        NOT NULL CHECK (state IN
                    ('held', 'pending', 'sent', 'delivered', 'read', 'replied', 'rejected', 'expired', 'failed')),
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  last_error      text,
  channel         text,                                     -- inbound: adapter that delivered it
  target          text,                                     -- inbound: channel destination used (private)
  native_id       text,                                     -- inbound: the channel's own id for the delivered item
  token           text        UNIQUE,                       -- inbound: unguessable handle for read tracking and reply matching
  remote_ack      json,                                     -- outbound: the receipt returned by the recipient's node
  delivered_at    timestamptz,
  read_at         timestamptz,
  replied_at      timestamptz,
  updated_at      timestamptz NOT NULL,
  PRIMARY KEY (direction, from_addr, message_id, recipient),
  FOREIGN KEY (direction, from_addr, message_id) REFERENCES messages (direction, from_addr, id) ON DELETE CASCADE
);

CREATE INDEX deliveries_due_idx ON deliveries (next_attempt_at) WHERE state = 'pending';
CREATE INDEX deliveries_held_idx ON deliveries (recipient) WHERE state = 'held';
CREATE INDEX deliveries_message_idx ON deliveries (message_id);

-- Who each local address has interacted with. A sender with no row here (and
-- not on the address's configured trusted list) is "unknown" to that recipient.
CREATE TABLE contacts (
  owner      text        NOT NULL,                          -- local address
  peer       text        NOT NULL,                          -- the other party
  source     text        NOT NULL CHECK (source IN ('outbound', 'approved')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (owner, peer)
);

-- Fixed-window counters for rate limiting unknown senders.
CREATE TABLE rate_counters (
  key          text        NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer     NOT NULL,
  PRIMARY KEY (key, window_start)
);

-- The event feed local agents read through the node's API (GET /api/v0/events).
--   type = 'message': a message was handed to the address by the agent channel
--   type = 'status' : a message the address sent reached a new state
-- seq orders events per address; the feed is read with "everything after seq N".
CREATE TABLE events (
  seq        bigserial   PRIMARY KEY,
  address    text        NOT NULL,                          -- the local address the event is for
  type       text        NOT NULL CHECK (type IN ('message', 'status')),
  message_id text        NOT NULL,
  thread_id  text        NOT NULL,
  data       json        NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX events_address_seq_idx ON events (address, seq);

-- Delegation tokens issued by this node's addresses that were taken back before they expired.
CREATE TABLE revoked_delegations (
  jti        text        PRIMARY KEY,
  revoked_at timestamptz NOT NULL
);
