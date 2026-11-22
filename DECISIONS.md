# Decisions

Choices that shaped [SPEC.md](SPEC.md), and choices this node makes where the
spec leaves room. Each one is the simplest option that seemed reasonable; none
is meant to be permanent.

## 1. The protocol

- **Standalone, not an extension of another protocol.** ADTP has its own HTTPS
  endpoint, its own envelope and its own discovery card. The reasons: the
  whole wire format fits in one short document; the signature covers exactly
  the bytes that travel, with no outer wrapper whose visible fields could
  disagree with the signed ones; and outcomes are plain HTTP status codes that
  any client, proxy or log already understands. Talking to agent protocols
  such as A2A or MCP is a job for an adapter at the edge of a node, not for the
  wire format, and is not built here.
- **The name.** ADTP stands for Async Data Transport Protocol. "Async" because a
  node stores a message and delivers it later, so the two sides need not be
  online together. "Transport" in the sense of RTP or MQTT, not of TCP: ADTP is
  carried over HTTPS, and what it guarantees comes from the signed envelope,
  not from the connection. The other names that were considered are in
  [NAMING.md](NAMING.md).
- **`adtp` everywhere.** In code, in the DNS record (`_adtp`), in the well-known
  path, in the media type (`application/adtp+json`).
- **A directory per domain, optional and opt-in.** Email's answer to "who do I
  write to at this company" is guessing `info@`. A domain can instead publish
  the addresses it wants found. Nothing is listed unless the address's owner
  sets `listed`, and a listed address is no easier to reach: the rules for
  unknown senders apply to it as to any other.
- **An entry is an address and a sentence.** The reader is usually a language
  model choosing where to write, and a plain description serves it better than
  a schema would. Which kinds of data an address understands is left out until
  there is a real use to shape it. A listed address must have a description,
  since an entry without one tells a stranger nothing.
- **The directory carries no keys and no endpoint.** Those come from the card
  of the address that was picked, so there is one place that says how to reach
  an address, and a wrong directory can at worst point at another address on
  its own domain. It is trusted the way cards are: served over HTTPS from a URL
  the domain's DNS names. It is not signed.
- **Found like a card.** A `directory=` field in the TXT record that already
  exists, then `/.well-known/adtp` on the domain: the collection the cards sit
  under. This node always puts `directory=` in the record it tells an operator
  to publish, so listing an address later needs no DNS change.
- **Descriptions are treated as someone else's text.** They end up on
  terminals and in front of models, so both the publishing and the reading
  side reduce them to one line of plain text, at most 500 characters, and a
  directory is read up to 100 entries. The tool tells a model to use a
  description to choose an address and not to follow instructions in it.
- **Flat `on_behalf_of` and `delegation`.** The principal is one string and the
  proof is one token, side by side at the top of the envelope, rather than a
  nested object. Everything about the grant (who, for what, where, until when)
  is inside the token, signed by the principal, so there is nothing to keep in
  step between the two.
- **`priority` is `low`, `normal` or `urgent`, and nothing else.** Recipients
  route on it. With a free-form value, two nodes never agree on what "high"
  means, and a typo silently becomes its own priority. Three levels are enough
  to say "this can wait", "ordinary" and "interrupt someone".
- **`created_at` is required and signed, and bounds replay.** A node refuses a
  message created more than five minutes in the future or longer ago than its
  `max_age` (seven days by default), whatever `expires_at` says. Without it, a
  far-off `expires_at` would oblige every receiver to remember the message's
  id forever. With it, a node may forget a message once it is both expired and
  past retention, and a replay after that is refused for its age alone.
- **A message is named by `(from, id)`.** Ids are chosen by senders, so one
  sender must not be able to use up, or collide with, another's. The same id
  from the same sender is a repeat if the signed bytes are the same (the node
  keeps a SHA-256 of them) and a conflict (`409`) if they are not.
- **`expires_at` defaults to `created_at` plus seven days.** This node always
  writes it out; a receiver applies the default when it is missing.
- **The signature is an object that names its key.**
  `{ alg, kid, value }`. A verifier looks up that one key and tries no other.
  That makes rotation unambiguous, makes "you used a key you do not publish"
  a different answer from "the signature is wrong", and leaves room for another
  algorithm later. An unknown `kid` is worth one fresh look at the card, at
  most once a minute per address. When that limit means no look can be taken,
  the message is not refused: the node answers "try again" with the time left,
  since a key it has not seen may simply be new. A sender that rotates and
  sends straight away loses nothing but a short delay.
- **Acceptance is signed; refusal is not.** A `202` carries a receipt signed by
  the receiving node, which the sender checks before it believes the message
  was stored. The receipt names the recipient whose key signed it (`by`), so a
  node with a key per address has a defined answer to "which key". Errors are
  plain bodies: a forged refusal can only delay a message.
- **Content is typed parts, defined here.** `text`, `data`, and `file` by URL,
  each marked by `type`. There is no `role` on the content: whether the sender
  is a person or an agent is in its card. Files are never carried inside an
  envelope, which keeps envelopes small enough to sign, store and log.
- **Status receipts are ordinary envelopes** with intent `status`. They need no
  second kind of message, are signed and discovered like everything else, and
  show up in the thread. The data part
  `{ type: "adtp.receipt", message_id, status, at }` links a receipt to its
  message.
- **`replied` and `failed` are both receipt statuses.** `delivered`, `read` and
  `failed` are the minimum; `replied` is kept because "they answered" is the
  status people most want and the node already knows it. A `failed` receipt
  says only that delivery was given up, not why: the reason (an SMTP error, a
  missing route) is the receiving node's business.
- **First contact is `202 queued`, not an error.** The message was stored; it
  is waiting for a person. `403 not_trusted` is only for a first message whose
  intent a stranger may not use.
- **Several recipients on one node: one answer.** `202` if the node took the
  message for at least one of them, with the outcome for each in the receipt.
  If it took it for none, the answer is an error whose body lists the outcome
  per recipient, and whose status is the retryable one if any recipient may be
  tried again.
- **`503` when a card cannot be fetched.** Failing to reach the sender's or the
  principal's card is the receiver's temporary problem, so it is retryable and
  not a `4xx`.
- **Cards say less than they could.** Required: address, endpoint, keys.
  `accepts` and `max_bytes` have defaults when absent, so a hand-written card
  stays short. `type` and `acts_for` are optional and informational.
- **Delegation tokens are JWTs with `aud`, `scope` and `jti`.** `aud` lets a
  principal bind a token to one node; `scope` limits it to some intents; `jti`
  is what a revocation names. Tokens the node signs for its own agents
  (`acts_for`) are per message: scope is that message's intent, lifetime is the
  message's. Tokens issued by hand (`adtp delegate`, the API) last 24 hours
  unless asked otherwise, never longer than `delegation.max_ttl_hours` (seven
  days by default), and cover `inform`, `request` and `status` unless a scope
  is given.
- **Revocation is local.** A node refuses to send or accept a revoked token
  from one of its own principals. That includes messages already waiting in
  its queue: the list is checked before every outbound attempt, because the
  other node has no way to know. It cannot tell other nodes; short lifetimes
  are what limits a leaked token elsewhere. Revocation across nodes is work for
  a later version.
- **Port 7387.** The default a node listens on. It is not assigned to anything
  in the IANA registry, and it stays clear of the ports developers already
  have busy (3000, 5432, 6379, 8080, Mailpit's 1025 and 8025) and of the
  ephemeral range. It is only a default: other nodes see whatever URL the card
  gives, which in production is HTTPS on 443.
- **Times are written to the second**, in UTC. Receivers accept any RFC 3339
  timestamp.
- **`thread` is optional when receiving**; a message without one is its own
  thread. This node always sends one. `adtp` accepts `0` or `0.x`. Unknown
  envelope members are ignored but are covered by the signature.
- **DNS template.** The `card=` URL template supports `{local}` (required) and
  `{domain}`. If the TXT location does not answer, the well-known URL is tried
  as well. Up to three redirects are followed.

## 2. Database

- **SQLite is the default.** With no `database_url` the node opens `adtp.db` in
  its data directory. A node is then one container and one volume, and backing
  up that volume backs up keys and messages together.
- **Postgres is one setting.** `database_url` (or `DATABASE_URL`) set to
  `postgres://…` selects it. `docker-compose.postgres.yml` adds a Postgres
  service for those who want Compose to run it.
- **Node's built-in SQLite, not a native module.** `node:sqlite` needs no
  compiler and no downloaded binary, which keeps the image small and the build
  boring. Node 22 labels the module experimental. Why that is acceptable here:
  the Node version is pinned to the 22 line (section 8), so the module cannot
  change underneath a running node; the node uses a small part of it (open,
  prepare, run, read rows); the whole test suite runs on it; and Postgres is
  one setting away for anyone who would rather not. Node prints its warning on
  every start of every process, including each CLI command, so the node
  filters that one line and instead says the same thing once, in its own
  startup log. Everything SQLite-specific sits behind the `Db` interface in
  `src/db/`, so swapping in another driver is contained to one file.
- **One store for both.** The SQL is the subset both databases share: a
  compare-and-swap claim instead of `SKIP LOCKED`, views assembled in code,
  recipients stored as JSON. The one difference is the advisory lock that
  keeps event numbering in commit order on Postgres.
- **SQLite means one process.** One node process owns the file. To run several
  processes against one database, use Postgres.
- **Messages are kept for 30 days**, then deleted, provided they have also been
  expired for a day (`limits.retention_days`). A stored message is also the
  record that stops its id being accepted twice, which is why expiry comes
  into it. Deleting a message deletes its deliveries. Events on agent feeds
  are kept for seven days.
- **No copying between databases.** A node switched from SQLite to Postgres (or
  back) starts empty. v0 has no export or import.
- **No upgrade path between schema generations.** The schema is one file per
  database. A database created by an earlier build is refused at startup with a
  message saying so, rather than half-working.
- **Not built: the serverless shape.** A function that wakes per message cannot
  keep a local SQLite file or a polling worker. The pieces that would be reused
  are in place (the `Db` seam for a remote SQLite, and a worker whose single
  pass, `tick()`, can be called on demand), but nothing here has been run that
  way.

## 3. Identity, keys and tokens

- **One signing key per node by default**, shared by every address it hosts
  (the model a mail server uses for DKIM). A consequence: when an agent and its
  principal live on the same node, the node signs the delegation with the same
  key that signs the agent's messages. The token is real and is verified by
  the other side against the principal's card, but it proves "this node says
  so", not "this person approved on their own device". Across nodes it means
  more. The node asks for keys per address (the `KeyStore` seam), so a
  different arrangement does not need a fork.
- **`acts_for` makes delegation automatic.** An agent configured with
  `acts_for: dylan` sends with `on_behalf_of` set and a delegation the node
  signs for that one message. An agent whose principal is hosted elsewhere
  must be handed a token (`adtp delegate` on the principal's node).
- **Receipts are sent as the address itself**, without `on_behalf_of`, even
  from an agent that acts for someone.
- **Key storage.** A single JSON file, mode 0600, in a 0700 directory. The
  active key can instead come from `ADTP_PRIVATE_KEY`; it is then never written
  to disk.
- **Rotation.** `adtp keys rotate` creates a new active key. The old key's
  private half is destroyed immediately; its public half stays in cards with a
  `not_after` for `keys.rotation_grace_days` (default 30) so signatures made
  just before rotation still verify.
- **Two tokens, not one.** The admin token opens everything local: the admin
  pages, the requests tray, delegations. The agent token is what an agent is
  given: it can send, mark read, follow its events, and look up messages,
  threads and addresses. An agent that is compromised, or simply wrong, then
  cannot approve its own senders or mint delegations.
- **The agent token is held to agent addresses.** It cannot send as a person,
  read a person's feed, or have the node sign a delegation from a principal the
  sending agent is not configured to act for. It can read the status of any
  message and any thread on the node: v0 has one agent token for all of a
  node's agents. Per-agent tokens would be a `TokenVerifier` that knows which
  agent a token belongs to.
- **Both tokens** come from the environment (`ADTP_ADMIN_TOKEN`,
  `ADTP_AGENT_TOKEN`) or the config, and are otherwise generated on first run
  into 0600 files. They are never printed or logged, and must differ.

## 4. Trust

- **"Known" means one of three things** for a (recipient, sender) pair: the
  sender is on the recipient's `trusted` list in the config (an exact address,
  or `*@domain`); the recipient approved a request from the sender; or the
  recipient has sent the sender a message. Trust is per recipient, not per
  node.
- **Trust attaches to `from`**, not to the principal in `on_behalf_of`.
  Trusting Dylan does not automatically trust every agent that holds a
  delegation from him.
- **Approving releases everything** held from that sender for that recipient,
  not just the one message.
- **Rejecting from the tray is silent.** The message is dropped, the sender
  stays unknown, and no status goes back, so a stranger cannot use rejections
  to probe.
- **Rate limits** are fixed one-hour windows, counted per sender address and
  per sender domain, and apply only to first-contact messages. Known senders
  are not limited. A rate-limited message is not stored and is answered `429`
  with `Retry-After` set to the end of the window, so the sending node waits
  and tries again.
- **Messages that arrive already expired are refused**, not stored. Messages
  that expire while held or while retrying are marked `expired`.

## 5. Delivery and status

- **Refused messages are not stored.** Only accepted and queued messages are
  persisted, so "a repeat gets the original receipt" applies to those. A
  refused id can be sent again after the cause is fixed.
- **Multiple recipients.** Each recipient gets its own delivery row and state.
  The sending node posts once per recipient; the receiving node recognizes the
  repeats.
- **A retry reopens only what was turned away for now.** When one recipient
  takes a message and another is rate-limited, the message is stored, so a
  plain "return the original receipt" would freeze the `rate_limited` answer
  for good. Instead, a repeat decides again for recipients whose stored
  outcome is a retryable refusal, and leaves every other recipient exactly as
  it was. What gets delivered is always the envelope stored the first time.
  Each such retry counts against the first-contact allowance like a new
  message would. After the message's deadline the stored answer stands.
- **A receipt the sender cannot trust is no answer.** A `202` without a valid
  signature from one of the message's recipients leaves the delivery pending,
  and it is retried like a timeout.
- **A refusal ends in `rejected`; running out of attempts ends in `failed`.**
  The first means the other node said no, or this node refused to send (the
  message's delegation was revoked while it waited). The second means the
  other node could not be reached, or kept saying "later".
- **A state and its report are stored together.** "Delivered", "read",
  "replied" and "failed" are each written in the same transaction as the
  receipt that tells the sender, and an outbound delivery's outcome in the same
  transaction as the event on the sending agent's feed. If the write fails,
  nothing changed and the step is done again. The price is at the channel
  edge: a message may be handed to a channel twice rather than have its
  `delivered` receipt lost. A reply, the `replied` state it causes and the
  `replied` receipt are likewise one write.
- **A reply is a message to the sender it answers.** `in_reply_to` marks a
  received message `replied` only when the new message is addressed to that
  message's sender; written to anyone else it goes out as an ordinary message
  and marks nothing. A submission that reuses an id already submitted is
  thrown away, as any repeat is, so it marks nothing either: what is stored
  under that id may be a different message to a different address.
- **Same-node recipients** are handed to the inbound pipeline in-process. They
  still go through verification, trust and the tray.
- **The agent channel delivers to a feed, not to a process.** `delivered` means
  the message is on the agent's event feed on its node, the way email is
  "delivered" when the mailbox server has it. `read` is the agent's own
  acknowledgement. An agent that is not running loses nothing: the events wait
  (for seven days), though the bundled tool starts reading from "now" unless
  told where to resume.
- **The inbox channel is the agent channel for a person.** A person's address
  can keep its messages on the node, with no email to set up: same feed, same
  states. Its reader is the node's inbox page, where an opened message can be
  marked read and answered. Reading is a button, not a side effect of opening
  the page, so "read" means someone said so. The controls appear only on
  messages delivered to this channel: one that went to email or to an agent is
  read and answered there.
- **Open first contact is per address, and keeps the other limits.** An
  address meant to be written to by strangers (a greeter, a front door) can
  take their first message without approval. It does not make strangers known:
  they may still only send `inform` or `request`, and the hourly first-contact
  limits still count every message until the address writes back.
- **Automatic replies cannot talk in circles.** A reply the node sends by
  itself carries a marker (`adtp.auto_reply`, in SPEC.md 4.4), and nothing is
  answered automatically if it carries one. That covers two auto-responders.
  For an agent that politely answers every message, the node also answers a
  thread only once, and stops after ten automatic replies to one sender in an
  hour. A message that gets no answer is marked read, so every delivered
  message is dealt with exactly once.
- **An automatic reply skips "read".** The sender hears `delivered` and then
  `replied`. Nobody read the message, and each step is one transaction: if the
  node stops in between, the message is still `delivered` and is answered on
  the next pass.
- **Agents pull; the node does not push.** Long polling over the local API
  means an agent needs no open port, which keeps the change to an existing
  agent small. A webhook channel would be an ordinary adapter plugin.
- **Order between two parties.** Deliveries to the same recipient go out one at
  a time in creation order, and `replied` is queued before the reply it
  announces. A peer therefore sees delivered, read, replied, then the reply. A
  retry can still reorder things; a late receipt is recorded and reported, and
  never moves the state backwards.
- **A reaction proves delivery.** If a read or reply arrives while the delivery
  is still mid-attempt (an agent can answer within a millisecond), the delivery
  is settled as `delivered` first. A message that was never attempted cannot be
  marked read.
- **Final states.** `rejected`, `expired` and `failed` are terminal. There is
  no dead-letter queue and no manual retry.
- **Delivery is at-least-once at the channel edge.** If the process dies after
  SMTP accepts an email but before the row is updated, the lease expires and
  the email is sent again. Node-to-node delivery is exactly-once thanks to
  the repeat rule.
- **Status flow.** Receivers report `delivered`, `read`, `replied` and
  `failed`. On the sender's side the local agent's feed additionally shows
  `accepted` or `queued` (from the receipt) and `rejected`, `failed` or
  `expired` (from the sender's own node).
- **Receipts are consumed by the node.** They update status and appear in the
  thread history, but are never routed to a channel and never answered with
  further status receipts (which would loop). Other `status` messages, without
  a receipt part, are delivered like any message, but no `status` message of
  any kind triggers a receipt.
- **`requires_approval` is carried and displayed, not enforced.** An approval
  workflow is out of scope.
- **A reply is an `inform`** from the recipient to the original sender on the
  same thread. From email, the node does not try to read accept/decline out of
  free text. From an agent, `in_reply_to` on the send call links the two; it is
  an API hint, not an envelope field.
- **Route schema.** `routes: [{ match: { priority, intent, from_org,
  sender_type }, channel, to }, { default: true, channel, to }]`. Match values
  may be one value or a list. First match in order wins; the default route
  applies when nothing matches. `from_org` is the domain of `from`;
  `sender_type` comes from the sender's card.

## 6. Email

- **Replies arrive by webhook, not IMAP.** `POST /hooks/email` takes a small
  JSON document (`from`, `to`, `subject`, `text`, `html`, `message_id`,
  `in_reply_to`, `references`, `headers`). This needs no extra dependencies,
  no polling loop and no mailbox credentials. An IMAP poller would be a second
  way to feed the same `ingest()` and can be added without touching the engine.
- **Matching a reply.** Each delivered email carries an unguessable token in
  its `Message-ID` (`<adtp.{token}@{domain}>`) and optionally in `Reply-To`.
  A reply is accepted only if it references that token *and* comes from the
  mailbox the message was delivered to.
- **Read receipts depend on the mail client** loading remote images. Clients
  that block them never report `read`; clients that prefetch report it early.
  Set `channels.email.read_receipts: false` to turn the image off.
- **Only replies are ingested.** Email that is not a reply to something this
  node delivered is ignored.
- **File parts become links.** The email lists each file's name and URL; the
  node does not fetch or attach anything.

## 7. Security posture

- **Outbound requests are SSRF-guarded.** Card URLs come from other people's
  DNS and endpoints from other people's cards, so those requests require
  https, refuse private/loopback/link-local addresses (checked at connect
  time, on every redirect hop), and are size- and time-limited.
  `discovery.allow_insecure: true` lifts this for local development.
- **The messages endpoint is open by design.** Anyone can post; nothing is
  stored until the signature verifies. There is no per-IP throttling in v0, so
  put the node behind a reverse proxy that rate-limits if it faces the open
  internet.
- **The local API shares the node's port.** `/api/v0` and `/admin` are guarded
  by the two tokens, not by network position. The demo's Compose files publish
  the port on localhost only by default.
- **Admin UI.** Sign-in with the admin token, then an HttpOnly SameSite=Strict
  cookie that is good for twelve hours and is signed with a key that exists
  only in the running process (so a restart signs everyone out, and the cookie
  is not derived from the token). An origin check on form posts, a strict
  Content Security Policy, and no JavaScript. There is no sign-in throttling; a
  generated token is 192 bits.
- **Logging.** Info-level lines carry ids, addresses, intents and states, never
  message text. Field names that look secret are redacted as a backstop.

## 8. Runtime

- **Node 22, and only 22** (`"engines": ">=22.16 <23"`). `node:sqlite` works
  without a flag from 22.13, but the SQLite driver asks each statement for its
  columns (`statement.columns()`), which arrived in 22.16. The upper bound is there because that
  module is still marked experimental and may change between major versions,
  and because 22 is the line the test suite has been run on. Moving to a newer
  line is a deliberate step: change the bound and the Docker base image, run
  the tests.
- **The Docker base image is pinned** to one Node and Alpine release, by tag
  and by digest, in one place at the top of the `Dockerfile`.
- **Mailpit is pinned too.** It is a mail catcher for development and the
  demos, and never part of a production node.

## 9. Seams, not tenancy

One node serves one domain. Serving many is a different product and lives
elsewhere. What this repository does is make sure such a wrapper would not have
to fork: signing keys, storage, "which addresses are mine" and "whose token is
this" are each behind a small interface with the single-domain implementation
as the default ([ARCHITECTURE.md](ARCHITECTURE.md#seams)). There is no tenant
logic here, and none of the four defaults pretends otherwise.

## 10. The demo

- **`demo/run.ts` stands in for the Stratus agent**, using the same tool
  (`integrations/stratus/adtp-tool.ts`) and the agent token. `--watch`
  transcribes a message sent by the real agent instead.
- **"Signature verified" in the transcript comes from Side B's signed
  receipt**, which names the key that verified and the principal whose
  delegation was valid. Side A's node checks that receipt's signature before
  reporting it, and the transcript says so. The runner needs no access to
  Side B.
- **The tamper test posts directly to Side B.** The runner asks Side A's node
  to sign without sending (`dry_run`), flips the low bit of the first byte of
  the message text, and posts the result itself, as a party in the middle
  would. Going through Side A's node would simply produce a correctly signed
  message with different text.
- **Timings.** Elapsed time is measured on Side A from the start of discovery.
  The first column shows each event's own timestamp, so Side B's entries use
  Side B's clock.
- **Local mode uses separate config files** (`demo/local/`) rather than the
  public ones with switches, so each file can be read on its own.
- **Transcripts are overwritten on every run** and committed as a sample.
- **The echo agent answers requests only**, so two such agents cannot bounce
  messages forever.

## 11. Deliberately not built

Listed so nobody looks for them: dead-lettering, a hosted relay, bridges to
other agent protocols (A2A, MCP), Slack/Discord/SMS/iMessage adapters, quiet
hours, escalation, digests, capability tokens beyond delegation, reputation
scoring, end-to-end encryption, an SDK (there is a small client and the
single-file agent tool), IMAP, per-agent API tokens, revocation across nodes,
multi-domain or multi-tenant nodes, a push (webhook) channel for agents, and
one-click setup that writes DNS records for you.
