# ADTP v0

ADTP, the Async Data Transport Protocol, is an asynchronous transport layer for
agents and people. It carries signed, structured data from one address to
another across domains, and tells the sender what became of it. Sender and
recipient do not have to be online at the same time, which is the "async" in
the name: a node stores what it is given, delivers it to whatever its recipient
uses, and reports back what happened.

The unit ADTP carries is a message: a signed envelope that states an intent and
holds text, structured data and links to files. An address looks like an email
address (`agent@example.com`). The domain says which node to hand a message to
and which keys its sender signs with.

ADTP does not say what the data means. It defines a small set of intents
(`request`, `propose`, `accept` and so on) and leaves the content to the two
sides, so that applications and other protocols can be built on top of it.

This document is the specification of version 0. The node in this repository
implements it; where the two disagree, this document is right and the code is
wrong.

The words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

- [1. Terms](#1-terms)
- [2. Addresses](#2-addresses)
- [3. Discovery](#3-discovery)
- [4. The envelope](#4-the-envelope)
- [5. Signatures](#5-signatures)
- [6. Sending for someone else](#6-sending-for-someone-else)
- [7. Transport](#7-transport)
- [8. What a receiving node does](#8-what-a-receiving-node-does)
- [9. Repeats, conflicts and replay](#9-repeats-conflicts-and-replay)
- [10. Status receipts](#10-status-receipts)
- [11. Unknown senders](#11-unknown-senders)
- [12. Security considerations](#12-security-considerations)
- [13. Not in v0](#13-not-in-v0)
- [Appendix A. Error codes](#appendix-a-error-codes)
- [Appendix B. A signed example](#appendix-b-a-signed-example)

## 1. Terms

- **Address**: `local@domain`. Names a person or an agent.
- **Node**: the server that sends and receives for the addresses of a domain.
- **Envelope**: one signed message. The unit that travels between nodes.
- **Card**: a small JSON document, one per address, that says where to send
  envelopes for it and which keys it signs with.
- **Directory**: a JSON document, one per domain, that lists the addresses the
  domain wants found and says what each is for. Optional.
- **Acceptance receipt**: the signed answer a node gives when it has stored an
  envelope.
- **Status receipt**: a later message from the recipient's node that says the
  message was delivered, read, answered, or could not be delivered.
- **Principal**: an address that another address (an agent) sends on behalf of.

## 2. Addresses

An address is `local@domain`.

- `domain` is a DNS name.
- `local` is 1 to 64 characters from `a-z`, `0-9`, `.`, `_`, `+` and `-`, and
  starts and ends with a letter or a digit.
- Addresses are compared without regard to case. Implementations SHOULD write
  them in lowercase.

## 3. Discovery

To send to an address, or to verify something it signed, a node needs its card.
To choose an address at a domain it has not dealt with, it can read the
domain's directory ([3.3](#33-the-directory)).

### 3.1 Finding the card

Given `local@domain`, a node looks in two places, in this order:

1. **DNS.** A TXT record at `_adtp.<domain>`:

   ```
   _adtp.stratuslabs.com.  TXT  "v=adtp0; card=https://adtp.stratuslabs.com/.well-known/adtp/{local}"
   ```

   The record is a list of `name=value` pairs separated by `;`. `v` MUST be
   `adtp0`. `card` is a URL template: `{local}` is replaced by the
   percent-encoded local part, and `{domain}`, if present, by the domain.
   A name a node does not know MUST be ignored, as are other TXT records at
   the same name.

2. **The well-known URL**, if DNS gave no usable card:

   ```
   https://<domain>/.well-known/adtp/<local>
   ```

The card is fetched with `GET`. A node MUST follow up to three redirects and
MUST NOT follow more. Card URLs MUST be `https`. (A node MAY be configured to
allow `http` for local development; it MUST NOT do so by default.)

The card's `address` MUST equal the address that was looked up. A node MUST
reject a card for any other address.

A node SHOULD cache cards for a short time (this implementation: five minutes).

### 3.2 The card

```json
{
  "adtp": "0",
  "address": "agent@stratuslabs.com",
  "endpoint": "https://adtp.stratuslabs.com/adtp/v0/messages",
  "keys": [
    { "kid": "2026-11-a", "alg": "Ed25519", "public_key": "<base64url>", "not_after": "2027-11-20T00:00:00Z" }
  ],
  "accepts": ["inform", "request", "propose", "accept", "decline", "commit", "status", "cancel", "approval.request", "approval.response"],
  "max_bytes": 262144,
  "type": "agent",
  "acts_for": "dylan@stratuslabs.com"
}
```

| Member | Required | Meaning |
|---|---|---|
| `adtp` | yes | Protocol version: `"0"`. |
| `address` | yes | The address this card is for. |
| `endpoint` | yes | The URL envelopes for this address are POSTed to ([section 7](#7-transport)). |
| `keys` | yes | The keys this address signs with. See below. |
| `accepts` | no | The intents this address takes. If absent: every intent in [section 4.3](#43-intents). |
| `max_bytes` | no | The largest envelope, in bytes, the endpoint takes. If absent: 262144. |
| `type` | no | `"human"` or `"agent"`. |
| `acts_for` | no | For an agent: the principal it says it acts for. Informational; the proof is the delegation token ([section 6](#6-sending-for-someone-else)). |

A card says where to send and how to verify. It MUST NOT contain how the
address's owner wants messages delivered (channels, routing, private contact
details).

Each entry of `keys`:

| Member | Required | Meaning |
|---|---|---|
| `kid` | yes | An id for the key, unique within the card. Any non-empty string. |
| `alg` | yes | `"Ed25519"`. Entries with another value MUST be ignored. |
| `public_key` | yes | The raw 32-byte Ed25519 public key, base64url without padding. |
| `not_after` | no | An RFC 3339 time. The key MUST NOT be used to verify anything after it. |

To rotate a key, a node publishes the new key and keeps the old one in the
card, with a `not_after`, for as long as messages signed with it may still be
in flight.

### 3.3 The directory

A card answers "how do I reach this address". A directory answers the question
before it: "which address at this domain do I want". It lists the addresses a
domain wants found, each with a line saying what it is for.

A directory is optional. A domain that publishes none works as before, and an
address that is not listed can still be written to by anyone who knows it.

```json
{
  "adtp": "0",
  "domain": "acme.com",
  "entries": [
    { "address": "ap@acme.com", "type": "agent", "description": "Accounts payable. Send invoices and payment questions here." },
    { "address": "hello@acme.com", "type": "human", "description": "General enquiries." }
  ]
}
```

| Member | Required | Meaning |
|---|---|---|
| `adtp` | yes | Protocol version: `"0"`. |
| `domain` | yes | The domain this directory is for. |
| `entries` | yes | The listed addresses. MAY be empty. |

Each entry:

| Member | Required | Meaning |
|---|---|---|
| `address` | yes | An address on `domain`. |
| `type` | no | `"human"` or `"agent"`. |
| `description` | no | What the address is for: one line of plain text, at most 500 characters. |

Given a domain, a node looks for its directory in two places, in this order:

1. **DNS.** The `directory` name in the TXT record at `_adtp.<domain>`, next to
   `card`. Its value is the URL of the directory:

   ```
   _adtp.acme.com.  TXT  "v=adtp0; card=https://adtp.acme.com/.well-known/adtp/{local}; directory=https://adtp.acme.com/.well-known/adtp"
   ```

2. **The well-known URL**, if DNS gave no usable directory:

   ```
   https://<domain>/.well-known/adtp
   ```

A directory is fetched as a card is: with `GET`, over `https`, following at
most three redirects. A node SHOULD cache it for as long as it caches cards.

A node that reads a directory:

- MUST reject it if its `domain` is not the domain that was looked up.
- MUST ignore an entry that is not an object, whose `address` is not a valid
  address, whose `address` is on another domain, or that repeats an earlier
  address. The other entries stand.
- MAY ignore entries after the first 100, and MAY cut a description after 500
  characters.
- MUST fetch the card of a listed address before sending to it, as for any
  other address. A directory carries no keys and no endpoint.

A node that publishes a directory:

- MUST list an address only if its owner chose to. Nothing is listed by default.
- MUST NOT treat a listed address differently when a message arrives for it.
  Who may deliver is decided as for any other address
  ([section 11](#11-unknown-senders)).

## 4. The envelope

```json
{
  "adtp": "0",
  "id": "msg_01KAGZ4Q8Y5V7W3N9M2T6R0XEB",
  "thread": "thr_01KAGZ4Q8Y5V7W3N9M2T6R0XEC",
  "from": "agent@stratuslabs.com",
  "on_behalf_of": "dylan@stratuslabs.com",
  "to": ["echo@demo.adtp.dev"],
  "intent": "request",
  "priority": "normal",
  "created_at": "2026-11-21T10:00:00Z",
  "expires_at": "2026-11-28T10:00:00Z",
  "requires_approval": false,
  "content": {
    "parts": [
      { "type": "text", "text": "Hello from Stratus Labs. This is the first ADTP message. Please confirm receipt." },
      { "type": "data", "data": { "type": "demo.ping", "sent_at": "2026-11-21T10:00:00Z" } }
    ]
  },
  "delegation": "<delegation token>",
  "signature": { "alg": "Ed25519", "kid": "2026-11-a", "value": "<base64url>" }
}
```

### 4.1 Members

| Member | Required | Meaning |
|---|---|---|
| `adtp` | yes | Protocol version: `"0"`. |
| `id` | yes | The message's id, chosen by the sender. Unique per sender: a message is named by `from` and `id` together. |
| `thread` | no | The conversation this message belongs to. A reply reuses the thread of the message it answers. If absent, the thread is the `id`. |
| `from` | yes | The sender's address. |
| `on_behalf_of` | no | The principal the sender acts for. Requires `delegation`. |
| `to` | yes | 1 to 50 recipient addresses. |
| `intent` | yes | What kind of message this is ([4.3](#43-intents)). |
| `priority` | no | `"low"`, `"normal"` or `"urgent"`. If absent: `"normal"`. Any other value is invalid. |
| `created_at` | yes | When the sender created the message. RFC 3339. |
| `expires_at` | no | The message MUST NOT be delivered after this time. RFC 3339. If absent: `created_at` plus seven days. |
| `requires_approval` | no | `true` if the sender asks the recipient for an explicit yes or no. If absent: `false`. |
| `content` | yes | The message itself ([4.4](#44-content)). |
| `delegation` | no | The token that proves `from` may send for `on_behalf_of` ([section 6](#6-sending-for-someone-else)). Only together with `on_behalf_of`. |
| `signature` | yes | The sender's signature over everything else ([section 5](#5-signatures)). |

An envelope MAY contain members this document does not define. A receiver MUST
ignore members it does not understand. They are covered by the signature like
everything else.

An envelope, as JSON text in UTF-8, MUST NOT be larger than the recipient
card's `max_bytes`.

### 4.2 Ids and times

`id` and `thread` are 1 to 200 characters from `A-Z`, `a-z`, `0-9`, `.`, `_`,
`:`, `~` and `-`, starting with a letter or a digit. This implementation writes
`msg_` or `thr_` followed by a ULID, which makes ids sort by creation time.
Receivers MUST NOT rely on that form.

Times are RFC 3339 timestamps with a time and an offset, for example
`2026-11-21T10:00:00Z`. A date alone is invalid.

### 4.3 Intents

| Intent | Meaning |
|---|---|
| `inform` | Telling the recipient something. No answer expected. |
| `request` | Asking the recipient for something. |
| `propose` | Offering something the recipient may accept or decline. |
| `accept` | Accepting a proposal or a request. |
| `decline` | Declining a proposal or a request. |
| `commit` | Promising to do something. |
| `status` | Reporting progress. Also carries status receipts ([section 10](#10-status-receipts)). |
| `cancel` | Withdrawing an earlier message. |
| `approval.request` | Asking for approval of a specific action. |
| `approval.response` | Answering an approval request. |

Any other value is invalid. The protocol carries the intent; what a recipient
does with it is up to the recipient.

### 4.4 Content

`content` is an object with one member, `parts`: a non-empty array. At least
one part MUST be a text part whose text is not blank, so that every message can
be shown to a person.

| Part | Members |
|---|---|
| Text | `"type": "text"`, `text` (string). |
| Data | `"type": "data"`, `data` (object). A structured payload for the receiving agent. By convention `data.type` names what it is. |
| File | `"type": "file"`, `url` (an `http` or `https` URL), and optionally `name`, `media_type`, `size` (bytes). |

Files travel by reference. An envelope never contains file bytes. A part with
any other `type` is invalid.

A message that is sent automatically, without a person or a model deciding to
send it (an acknowledgement, an out-of-office note), SHOULD carry a data part
whose `data.type` is `adtp.auto_reply`. A node MUST NOT answer such a message
automatically. This keeps two automatic responders from answering each other
without end.

## 5. Signatures

Every envelope and every acceptance receipt is signed with Ed25519 (RFC 8032).

### 5.1 The signature object

```json
{ "alg": "Ed25519", "kid": "2026-11-a", "value": "<base64url>" }
```

- `alg` MUST be `"Ed25519"`.
- `kid` names the key: the `kid` of one entry in the signer's card.
- `value` is the 64-byte signature, base64url without padding.

### 5.2 What is signed

The signed bytes are the JSON Canonicalization Scheme form (RFC 8785) of the
object **without its `signature` member**, encoded as UTF-8.

In short, RFC 8785 means: members sorted by the UTF-16 code units of their
names, no whitespace, strings and numbers written exactly as ECMAScript's
`JSON.stringify` writes them. An implementation MUST refuse to sign or verify
an object that contains a number that is not finite, or a string that is not
valid Unicode. `test/protocol.test.ts` runs the RFC's own examples, including
its number-serialization table.

### 5.3 Verifying

To verify a signature a node:

1. takes the signer's card (from its cache, or by discovery);
2. finds the key whose `kid` equals the signature's `kid`. It MUST NOT try
   other keys;
3. checks that the key's `not_after`, if any, has not passed;
4. verifies `value` over the signed bytes with that key.

If the card as the node has it does not list that `kid` (or the key has
expired), the node SHOULD fetch the card once more, in case the signer rotated
its keys, and try again. It MUST limit how often it does this for the same
address (this implementation: once a minute), so that bogus messages cannot be
used to make it flood another node with requests.

While that limit, or a failed fetch, keeps the node from taking a fresh look,
it cannot tell a new key from a wrong one. It MUST NOT answer `bad_signature`
then. It answers `503 sender_unresolvable` (or `principal_unresolvable` for a
delegation token), which is retryable, with a `Retry-After` header when it
knows how long the limit still runs. Only a card fetched after the message
arrived, and still not listing the key, makes the answer `bad_signature`.

The signer of an envelope is `from`. The signer of an acceptance receipt is the
address in its `by` member.

## 6. Sending for someone else

An agent sends on behalf of a principal by naming the principal in
`on_behalf_of` and attaching a `delegation` token that the principal's key
signed. Without a valid token, a message with `on_behalf_of` MUST be refused.

### 6.1 The token

A delegation token is a JWT (RFC 7519) in compact form, signed with EdDSA
(Ed25519).

Header:

```json
{ "alg": "EdDSA", "typ": "adtp-delegation+jwt", "kid": "<a kid from the principal's card>" }
```

Claims:

```json
{
  "iss": "dylan@stratuslabs.com",
  "sub": "agent@stratuslabs.com",
  "aud": "adtp",
  "scope": ["inform", "request", "status"],
  "jti": "dlg_Zk3vQ0c1b2R5d0xq",
  "iat": 1795255200,
  "exp": 1795341600
}
```

| Claim | Meaning |
|---|---|
| `iss` | The principal's address. |
| `sub` | The agent's address. |
| `aud` | `"adtp"`: the token is good at any node. Or the origin of one node (`https://adtp.example.com`): good only there. A string or an array of strings. |
| `scope` | The intents the agent may send for the principal. A non-empty array. |
| `jti` | A unique id for the token. It is what a revocation names. |
| `iat`, `exp` | Issued at, and expires at, in seconds since the epoch. |

All seven claims are required. Tokens SHOULD be short-lived. This
implementation issues them for 24 hours unless asked otherwise, and never for
longer than its configured maximum.

### 6.2 Verifying

A receiving node MUST refuse the message with `delegation_invalid` unless all
of these hold:

- the header says `alg` `EdDSA` and `typ` `adtp-delegation+jwt`;
- the token is signed by the key, in the card of `on_behalf_of`, that the
  header's `kid` names, and that key is still valid ([5.3](#53-verifying));
- `iss` equals the envelope's `on_behalf_of`;
- `sub` equals the envelope's `from`;
- `aud` contains `"adtp"` or the receiving node's own origin;
- `scope` contains the envelope's `intent`;
- `jti` is present;
- the current time is before `exp`, and `iat` is not more than five minutes in
  the future.

### 6.3 Revocation

A node keeps a list of revoked `jti` values for tokens issued by the addresses
it hosts. It MUST refuse to send, and refuse to accept, a message that carries
a revoked token from one of its own principals. That includes a message it
queued before the revocation and has not yet delivered.

v0 has no way to tell other nodes about a revocation. Until its `exp`, a
revoked token still works at other nodes. That is why tokens are short-lived.

## 7. Transport

### 7.1 Sending an envelope

The sender's node makes one HTTPS request to the `endpoint` in the recipient's
card:

```
POST /adtp/v0/messages HTTP/1.1
Host: adtp.example.com
Content-Type: application/adtp+json

{ ...the envelope... }
```

- The body is exactly one envelope. There is no wrapper around it.
- `Content-Type` MUST be `application/adtp+json`. Parameters such as
  `charset=utf-8` are allowed.
- Endpoints MUST be `https` on the public internet. The path is whatever the
  card says; this implementation serves `/adtp/v0/messages`.

For an envelope with several recipients, the sender's node POSTs the same
envelope to the endpoint of each recipient. A node that receives an envelope
decides for every recipient on its own domain at once, and ignores recipients
on other domains. When the same envelope arrives again, for another of its
recipients, it is a repeat ([section 9](#9-repeats-conflicts-and-replay)).

A node listens wherever its operator likes; other nodes only ever see the URL
in the card. When no port is configured, this implementation listens on 7387.

### 7.2 Answers

| Status | Meaning | Body |
|---|---|---|
| `202` | The message is stored. | The acceptance receipt. |
| `200` | The same message was already stored. | The receipt it got the first time. |
| `400` | The body is not a valid envelope, its `created_at` is in the future, or its `expires_at` is further ahead than the node accepts ([section 8](#8-what-a-receiving-node-does), step 7). | Error body, `invalid_envelope`. |
| `401` | The signature does not verify. | Error body, `bad_signature`. |
| `403` | The delegation is missing or not valid. | Error body, `delegation_invalid`. |
| `403` | The recipient does not know the sender, and the intent is not one a stranger may use. | Error body, `not_trusted`. |
| `404` | No recipient in `to` is hosted by this node. | Error body, `unknown_recipient`. |
| `409` | This sender already used this `id` for a different message. | Error body, `id_conflict`. |
| `410` | The message has expired, or its `created_at` is too old. | Error body, `expired`. |
| `413` | The envelope is larger than `max_bytes`. | Error body, `too_large`. |
| `415` | The `Content-Type` is not `application/adtp+json`. | Error body, `unsupported_media_type`. |
| `429` | Too many messages. Sent with a `Retry-After` header (seconds). | Error body, `rate_limited`. |
| `503` | The node could not fetch the sender's (or the principal's) card just now, or could not yet look again for a key it has not seen ([5.3](#53-verifying)). | Error body, `sender_unresolvable` or `principal_unresolvable`. |
| `500` | Something went wrong in the node. Nothing was stored. | Error body, `internal`. |

A node MUST NOT answer `202` or `200` before the message is durably stored.

### 7.3 The acceptance receipt

```json
{
  "adtp": "0",
  "id": "msg_01KAGZ4Q8Y5V7W3N9M2T6R0XEB",
  "from": "agent@stratuslabs.com",
  "by": "echo@demo.adtp.dev",
  "status": "accepted",
  "recipients": {
    "echo@demo.adtp.dev": { "status": "accepted" }
  },
  "verified": { "signature": "2026-11-a", "delegation": "dylan@stratuslabs.com" },
  "at": "2026-11-21T10:00:00.412Z",
  "signature": { "alg": "Ed25519", "kid": "2026-10-b", "value": "<base64url>" }
}
```

| Member | Meaning |
|---|---|
| `id`, `from` | The message this receipt is for. |
| `by` | The recipient whose key signed the receipt. One of the envelope's `to` addresses, hosted by the answering node. |
| `status` | `accepted`: the message is being delivered to at least one recipient. `queued`: it is stored and waits for a recipient to approve the sender ([section 11](#11-unknown-senders)). |
| `recipients` | The outcome for each recipient on this node: `accepted`, `queued`, or `rejected` with a `reason` of the form `{ "code", "message", "retryable" }` (and, for a retryable reason, optionally `retry_after` in seconds). |
| `verified` | What the node checked: the `kid` the envelope's signature verified against, and, if the message was sent for a principal, that principal. |
| `at` | When the node stored the message. |
| `signature` | The node's signature over the rest ([section 5](#5-signatures)), made with a key in the card of `by`. |

A sender MUST treat a `202` or `200` as an acceptance only if all of these hold:

- `id` and `from` equal those of the envelope it sent;
- `by` is one of the envelope's `to` addresses, on the domain it posted to;
- the signature verifies against the card of `by`.

Otherwise the answer proves nothing, and the sender SHOULD send the envelope
again later.

### 7.4 The error body

Every answer that is not `202` or `200` has this body:

```json
{ "error": "rate_limited", "message": "too many first-contact messages from this sender; try again after 2026-11-21T11:00:00.000Z", "retryable": true }
```

`error` is a code from [Appendix A](#appendix-a-error-codes). `message` is for
people. `retryable` says whether sending the same envelope again later may
succeed.

When a node decided per recipient and turned every one of them away, the body
also has `recipients`, in the same form as in the receipt. The status code is
then that of a retryable refusal if there is one, and otherwise that of the
first recipient's.

### 7.5 Retrying

A sender MUST send an envelope again only when:

- the error body says `"retryable": true`, or
- the status is `429` or `5xx`, or
- the request itself failed (no connection, a timeout), or
- a `202` or `200` came without a receipt it can trust ([7.3](#73-the-acceptance-receipt)).

Any other answer is final for that recipient.

A sender that retries MUST send the same envelope, byte for byte the same
content, under the same `id`. It SHOULD back off exponentially, MUST wait at
least as long as a `Retry-After` header asks, and MUST stop at `expires_at`.

## 8. What a receiving node does

For each POSTed envelope, in this order. The first step that fails decides the
answer.

1. **Shape.** Parse the body and check it against [section 4](#4-the-envelope).
   Otherwise: `invalid_envelope`.
2. **Clock.** `created_at` MUST NOT be more than five minutes in the future.
   Otherwise: `invalid_envelope`.
3. **Recipient.** At least one address in `to` is hosted here. Otherwise:
   `unknown_recipient`.
4. **Signature.** Verify the envelope's signature against the card of `from`
   ([5.3](#53-verifying)). Otherwise: `bad_signature`, or `sender_unresolvable`
   if the card cannot be fetched.
5. **Delegation.** If there is an `on_behalf_of`, verify the token
   ([6.2](#62-verifying)) and check it is not revoked ([6.3](#63-revocation)).
   Otherwise: `delegation_invalid`, or `principal_unresolvable`.
6. **Seen before?** If this sender already sent a message with this `id`:
   answer as [section 9](#9-repeats-conflicts-and-replay) says, and stop.
7. **Time.** The message has not expired, and `created_at` is not older than
   the node's maximum age (seven days unless the operator changed it).
   Otherwise: `expired`. A node MAY also refuse a message whose `expires_at`
   is further from its `created_at` than the node is willing to keep a
   message (this implementation: 30 days), with `invalid_envelope`. It MUST
   NOT set that limit below seven days, the lifetime of a message that names
   no `expires_at`.
8. **Status receipt?** If the message is one, record it
   ([section 10](#10-status-receipts)) and answer `202`.
9. **Per recipient**, decide whether the sender may deliver directly
   ([section 11](#11-unknown-senders)).
10. **Store** the envelope, exactly as received, and the receipt, in one
    transaction. Then answer `202` with the receipt.

A message that is refused is not stored. The sender can fix the problem and
send the same `id` again.

## 9. Repeats, conflicts and replay

A message is named by its sender and its id together: `(from, id)`. Two
different senders MAY use the same `id`. That is not a conflict.

When an envelope arrives whose `(from, id)` the node has already stored, the
node compares their signed bytes ([5.2](#52-what-is-signed)):

- **The same**: it is a repeat. The node answers `200` with the receipt it
  gave the first time, and does not store or deliver the message again.
- **Different**: the node answers `409 id_conflict`. The stored message is not
  changed.

One exception. If the receipt says a recipient was turned away for a
`retryable` reason (a rate limit) while another recipient took the message,
a repeat is the sender asking again for that recipient. The node decides
again for that recipient only. If it can take the message now, it adds the
delivery and answers with the updated, re-signed receipt. It does so only
while it could still accept the message as new: once the message has expired,
or its `created_at` is older than the node's maximum age, the first answer
stands. Recipients that
already took the message are never delivered to twice.

### Replay

A captured envelope can be sent again by anyone. Three rules keep that
harmless:

- While the node holds the message, a replay is a repeat. It gets the old
  receipt and nothing happens.
- A node MUST keep a stored message for at least one day after its
  `expires_at`. Until then the record exists; after `expires_at` the message is
  refused as `expired` anyway.
- A node MUST refuse a message whose `created_at` is older than its maximum
  age, whatever `expires_at` says. So a message cannot be given an unlimited
  life by a far-off `expires_at`.

After that a node MAY delete the message. This implementation deletes messages
30 days after it stored them (configurable), and never before they have been
expired for a day.

## 10. Status receipts

After accepting a message, the recipient's node tells the sender what became
of it. A status receipt is an ordinary envelope:

- `from` is the recipient the receipt is about; `to` is the original sender;
- `thread` is the original message's thread;
- `intent` is `status`;
- its content has a text part, for people, and this data part:

```json
{ "type": "data", "data": { "type": "adtp.receipt", "message_id": "msg_01KAGZ4Q8Y5V7W3N9M2T6R0XEB", "status": "delivered", "at": "2026-11-21T10:00:01.020Z" } }
```

It is signed, discovered and POSTed like any other envelope.

| `status` | Meaning |
|---|---|
| `delivered` | The message was handed to the recipient's channel (an inbox, an agent's feed). |
| `read` | The recipient opened it. |
| `replied` | The recipient answered it. The answer itself is a separate message on the same thread. |
| `failed` | The node accepted the message but could not deliver it, and has given up. |

The sender's node matches a receipt to the message it sent with that
`message_id` to the receipt's `from`. A receipt that matches nothing is
refused with `unknown_receipt_target`.

States only move forward: `delivered`, then `read`, then `replied`. A receipt
that arrives late MUST NOT move a message backwards. `failed` ends a message
that was never delivered; it MUST NOT undo one that was.

A node MUST NOT send a status receipt about a status receipt. (The POST that
carries a receipt still gets its `202`, like any envelope.) A node MUST NOT
deliver a status receipt to the recipient's channel as if it were a message.

Not every channel can report every status. A node sends the receipts it can.
A node is not required to report that a recipient declined to accept a
message.

## 11. Unknown senders

A node decides, per recipient, whether a sender may deliver directly. How it
decides is its own policy. This is what the protocol fixes:

- If the recipient knows the sender, the message is `accepted`.
- If the recipient does not know the sender, and the intent is `inform` or
  `request`, the node MAY store the message and hold it until the recipient
  approves the sender. It answers `202` with `status` `queued`.
- If the recipient does not know the sender, and the intent is anything else,
  the node answers `403 not_trusted`.
- A node MAY limit how many messages an unknown sender, or an unknown sender's
  domain, may send. Past the limit it answers `429 rate_limited` with
  `Retry-After`.

In this implementation a recipient knows a sender if the sender is on the
recipient's configured list, if the recipient approved it before, or if the
recipient wrote to it first. An address can also be set to take first messages
from anyone without holding them; the limits on intent and on rate still apply
to it.

## 12. Security considerations

- **What a signature proves.** That the holder of a key in the sender's card
  wrote exactly these bytes. Trust in the card comes from DNS and HTTPS for the
  sender's domain, as with email and DKIM. A node that controls a domain can
  sign as any address on it.
- **Card fetches go to URLs someone else chose.** A node MUST NOT let a card
  URL, or a redirect from one, reach its own private network. This
  implementation refuses private, loopback and link-local addresses at
  connection time.
- **Refusals are not signed.** Only acceptance is. A forged refusal can at
  worst delay a message; a forged acceptance would be a claim that a message
  was stored, which is why receipts are signed and senders check them.
- **Delegation is bounded, not absolute.** A token limits who may send, for
  whom, which intents, where and until when. Revocation reaches only the
  issuing node ([6.3](#63-revocation)).
- **A directory is public, and its descriptions are someone else's words.**
  Anyone can read which addresses a domain lists, so a directory is for entry
  points, not for people who do not want to be found. A description is written
  by the domain that publishes it. Software that reads one, a language model
  included, should treat it as information about the address and never as
  instructions.
- **Clocks.** Nodes need roughly correct clocks. Five minutes of disagreement
  is tolerated.
- **Message contents are not encrypted** beyond the HTTPS connection. Both
  nodes can read them.
- **The endpoint is public.** Anyone can POST to it. Signature checks come
  before anything is stored, and unknown senders are limited
  ([section 11](#11-unknown-senders)).

## 13. Not in v0

End-to-end encryption. Revocation across nodes. Group membership and mailing
lists. Attachments carried inside the envelope. Payments. Negotiating
capabilities beyond `accepts` and `max_bytes`, including which kinds of data an
address understands. Bridges to other agent protocols.

## Appendix A. Error codes

| Code | Status | Retryable | Meaning |
|---|---|---|---|
| `invalid_envelope` | 400 | no | The body is not a valid envelope. |
| `bad_signature` | 401 | no | The signature does not verify, or names a key the sender does not publish. |
| `delegation_invalid` | 403 | no | The delegation token is missing, not valid for this message, or revoked. |
| `not_trusted` | 403 | no | The recipient does not know the sender and the intent is not `inform` or `request`. |
| `unknown_recipient` | 404 | no | The recipient is not hosted by this node. |
| `unknown_receipt_target` | 404 | no | A status receipt for a message this node did not send to that address. |
| `id_conflict` | 409 | no | The sender already used this id for a different message. |
| `expired` | 410 | no | Past `expires_at`, or `created_at` older than the node accepts. |
| `too_large` | 413 | no | The envelope is larger than `max_bytes`. |
| `unsupported_media_type` | 415 | no | The request is not `application/adtp+json`. |
| `rate_limited` | 429 | yes | Too many messages. `Retry-After` says when to try again. |
| `internal` | 500 | yes | The node failed. Nothing was stored. |
| `sender_unresolvable` | 503 | yes | The sender's card could not be fetched, or could not be fetched again to look for a key it does not list yet. |
| `principal_unresolvable` | 503 | yes | The same, for the card of the principal in `on_behalf_of`. |

A node MAY use other codes. A sender that meets a code it does not know goes
by `retryable` and the status ([7.5](#75-retrying)).

## Appendix B. A signed example

For checking an implementation. The key is test vector 1 of RFC 8032, which is
public: never use it for anything else.

Private key (the 32-byte seed), in hex:

```
9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60
```

The matching key, as it would appear in the sender's card:

```json
{ "kid": "example-2026-11", "alg": "Ed25519", "public_key": "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" }
```

The envelope, before signing:

```json
{
  "adtp": "0",
  "id": "msg_01KAGZ4Q8Y5V7W3N9M2T6R0XEB",
  "thread": "thr_01KAGZ4Q8Y5V7W3N9M2T6R0XEC",
  "from": "agent@stratuslabs.com",
  "to": ["echo@demo.adtp.dev"],
  "intent": "request",
  "priority": "normal",
  "created_at": "2026-11-21T10:00:00Z",
  "expires_at": "2026-11-28T10:00:00Z",
  "requires_approval": false,
  "content": {
    "parts": [
      { "type": "text", "text": "Hello from Stratus Labs. Please confirm receipt." },
      { "type": "data", "data": { "type": "demo.ping", "n": 1 } }
    ]
  }
}
```

The signed bytes (434 bytes, shown here on one line):

```
{"adtp":"0","content":{"parts":[{"text":"Hello from Stratus Labs. Please confirm receipt.","type":"text"},{"data":{"n":1,"type":"demo.ping"},"type":"data"}]},"created_at":"2026-11-21T10:00:00Z","expires_at":"2026-11-28T10:00:00Z","from":"agent@stratuslabs.com","id":"msg_01KAGZ4Q8Y5V7W3N9M2T6R0XEB","intent":"request","priority":"normal","requires_approval":false,"thread":"thr_01KAGZ4Q8Y5V7W3N9M2T6R0XEC","to":["echo@demo.adtp.dev"]}
```

Their SHA-256, in hex:

```
eb22045fb39f7cc4d77cd217b0d81633d59f0da831fa4f1d0ab8c6d7c8d81af9
```

The `signature` member to add to the envelope:

```json
{ "alg": "Ed25519", "kid": "example-2026-11", "value": "egbETbhdbEKhvvSDvYDEy0-gBNLmNZIeGZZ-cIvmrvcTMRCqj6KQdXFpIXByPSlT6MW5cWryLEJoOZneeHqDBw" }
```

`test/spec.test.ts` checks this example against the code.
