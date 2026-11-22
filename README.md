# ADTP node

A self-hostable node for **ADTP v0**, the Async Data Transport Protocol: an
asynchronous transport layer for agents and people. ADTP carries signed,
structured data from one address to another across domains, whether or not the
other side is online, and tells the sender what became of it.

The node gives people and agents an address (`local@domain`), receives what is
sent to that address, delivers it to the channel its owner chose, and reports
back what happened. The unit it carries is called a message: a signed envelope
that states an intent and holds text, structured data and links to files.

It runs with nothing to set up: one container, with messages kept in a SQLite
file. Postgres is one setting away when a node outgrows that.

**The protocol** is in [SPEC.md](SPEC.md): one HTTPS endpoint that takes a
signed envelope and answers with a signed receipt, a discovery card per
address found through DNS, an optional directory per domain that says which
addresses to write to, Ed25519 signatures over canonical JSON, and delegation
tokens for agents that act on someone's behalf.

**The node** adds what a protocol alone does not give you: store-and-forward
with retries and backoff, deadlines, repeat and replay handling,
delivered/read/replied/failed status updates, threads, key rotation, and a feed
that hands messages to an agent running next to the node.

**Included, and optional:** an email channel (deliver to an inbox, take replies
back in), a requests tray where first messages from unknown senders wait for
approval, with a small admin UI, and Postgres as the database. A node that only
serves agents and trusts its counterparts in config needs none of the three.

- [Run the demo](#run-the-demo): two agents on two domains exchange one signed message
- [Run a node](#run-a-node): `docker compose up`, configuration, a real domain
- [Put a node on your domain](deploy/README.md): one `docker run`, a Render button, or a Fly.io script, or [hand it to your agent](deploy/agent-prompt.md)
- [SPEC.md](SPEC.md): the protocol, normatively
- [ARCHITECTURE.md](ARCHITECTURE.md): components, message lifecycle, schema, seams
- [DECISIONS.md](DECISIONS.md): the choices behind the spec and the node, and why
- [NAMING.md](NAMING.md): what ADTP stands for, and the names that were considered
- [SECURITY.md](SECURITY.md): how to report a vulnerability, and the known limits

```sh
git clone https://github.com/adtprotocol/adtp.git
cd adtp
```

## Run the demo

Two agents on different domains exchange one signed ADTP message end to end:
discovery, signature and delegation checks, a signed receipt, `delivered` and
`read` status updates, and a reply on the same thread.

| | Side A | Side B |
|---|---|---|
| Agent | `agent@stratuslabs.com`, acting for `dylan@stratuslabs.com` | `echo@demo.adtp.dev`, a scripted agent |
| Runs | an ADTP node, and the Stratus agent with the [ADTP tool](#the-adtp-tool-for-the-stratus-agent) | an ADTP node + [`demo/echo-agent.ts`](demo/echo-agent.ts) |

### Locally, in under five minutes

You need Docker with Compose, or Node.js 22.16 or newer. Either one is enough.

```sh
bash demo/run.sh
```

With Docker, the first run builds the image (a few minutes) and starts both
sides on your machine as `stratuslabs.localhost` and `demo.adtp.localhost`.
Later runs take about two seconds. Without Docker, the script says so and runs
the same two nodes as ordinary processes instead (`--no-docker` asks for that
outright); the first run installs the dependencies and compiles, and nothing is
left behind afterwards. If the machine has neither, the script says what to
install. There is no DNS or TLS in local mode: each node is told where the
other's cards live (`demo/local/*.config.yaml`).

```
ADTP v0 demo  agent@stratuslabs.localhost → echo@demo.adtp.localhost

05:03:46.036  +0.014s  stratus  discover   local mode: discovery override for demo.adtp.localhost (no DNS lookup)
05:03:46.036  +0.014s  stratus  card       http://echo-node:7387/.well-known/adtp/echo  →  endpoint http://echo-node:7387/adtp/v0/messages, key ed25519-632c99f88984fece
05:03:46.055  +0.033s  stratus  send       adtp_send → msg_01M7Y7TCW12GXHAAESBX99XNGW on thr_01M7Y7TCW10RJGX3J8EVA60TXW
05:03:46.059  +0.037s  stratus  envelope   signed by the node for agent@stratuslabs.localhost
    │ {
    │   "adtp": "0",
    │   "id": "msg_01M7Y7TCW12GXHAAESBX99XNGW",
    │   "thread": "thr_01M7Y7TCW10RJGX3J8EVA60TXW",
    │   "from": "agent@stratuslabs.localhost",
    │   "on_behalf_of": "dylan@stratuslabs.localhost",
    │   "to": ["echo@demo.adtp.localhost"],
    │   "intent": "request",
    │   "created_at": "2026-11-21T05:03:46Z",
    │   ...
    │   "delegation": "eyJhbGciOiJFZERT…",
    │   "signature": { "alg": "Ed25519", "kid": "ed25519-a4122bafd46d6b97", "value": "wk3F7wSmLgAvVlU6…ApjGjmCQ" }
    │ }
05:03:46.075  +0.056s  side-b   accepted   signature verified (key ed25519-a4122bafd46d6b97); delegation verified: agent@stratuslabs.localhost acts for dylan@stratuslabs.localhost; signed receipt from echo@demo.adtp.localhost checked
05:03:46.076  +0.065s  side-b   delivered  handed to echo@demo.adtp.localhost
05:03:46.084  +0.078s  side-b   read       echo@demo.adtp.localhost marked it read
05:03:46.091  +0.083s  side-b   replied    echo@demo.adtp.localhost answered
05:03:46.108  +0.090s  side-b   reply      inform from echo@demo.adtp.localhost on thr_01M7Y7TCW10RJGX3J8EVA60TXW
    │ "Received your request, signature verified for agent@stratuslabs.localhost acting for dylan@stratuslabs.localhost."
05:03:46.112  +0.090s  stratus  verify     reply signature verified (key ed25519-632c99f88984fece)

✓ accepted, delivered, read, and a reply on the same thread in 0.09s
```

The same transcript is written to [`demo/transcript.md`](demo/transcript.md)
(pasteable) and [`demo/transcript.json`](demo/transcript.json) (complete,
including the full envelope). The script exits non-zero if any step is missing,
so it also works as a CI check.

| Command | What it does |
|---|---|
| `bash demo/run.sh` | Send the demo message and follow it to the reply. |
| `bash demo/run.sh --tamper` | Flip one byte of the signed envelope in transit. Side B must reject it. |
| `bash demo/run.sh --watch` | Do not send; transcribe the next message the real Stratus agent sends. |
| `bash demo/run.sh --public` | Run against the real Side A node (see below). |
| `bash demo/run.sh --build` | Rebuild the image first, after changing code. |
| `bash demo/run.sh --reset` / `--down` | Wipe both local nodes' data first / stop and remove everything. |
| `bash demo/split.sh [flags]` | Split screen in tmux: the run on the left, Side B's agent log on the right. |

While it runs you can look around: Side A's admin UI is at
http://localhost:7388/admin (token `demo-stratus-admin`), Side B's at
http://localhost:7389/admin (token `demo-echo-admin`), and Side B's agent log is
`docker compose -f demo/docker-compose.yml logs -f echo-agent`. The agents
themselves hold a different, narrower token (`demo-stratus-agent`,
`demo-echo-agent`) that cannot open those pages.

If you ran an earlier build of this demo, start once with
`bash demo/run.sh --reset --build`: the stored data has a new shape, and a node
refuses a database from an older build rather than half-working with it.

### The tamper test

```
$ bash demo/run.sh --tamper
...
05:03:47.404  +0.014s  stratus  tamper     one byte changed in transit: "Hello…" → "Iello…" (signature untouched)
05:03:47.411  +0.021s  side-b   rejected   HTTP 401  bad_signature: the envelope signature does not verify against key "ed25519-a4122bafd46d6b97" of agent@stratuslabs.localhost

✓ Side B refused the tampered envelope: the signature no longer matches
```

The script asks Side A's node to sign the demo message without sending it,
changes one byte of the text, and posts the result straight to Side B's
endpoint, as someone in the middle would. Side B stores nothing.

### On two real domains

To put an address of your own on your domain, with no scripted agent and no
email to set up, use [deploy/README.md](deploy/README.md) (Fly.io, one script
per node) or [examples/two-domains](examples/two-domains/README.md) (servers of
your own). What follows here is the scripted demo on two domains.

What you need: two domains you control (they must be different), DNS access for
both, and two small Linux hosts with Docker, each reachable from the internet on
ports 80 and 443. Each side is one Compose project: the node, plus Caddy to
obtain an HTTPS certificate. Other nodes only talk to `https://` endpoints.

The steps below use the defaults from the `.env.example` files. Replace the
names with yours.

| | Side A (sender) | Side B (receiver) |
|---|---|---|
| Address | `agent@stratuslabs.com` | `echo@demo.adtp.dev` |
| `ADTP_DOMAIN` | `stratuslabs.com` | `demo.adtp.dev` |
| `ADTP_HOST` (where the node is served) | `adtp.stratuslabs.com` | `demo.adtp.dev` |

**1. Point each hostname at its host.** Add an A (or AAAA) record for each
`ADTP_HOST`. Caddy cannot get a certificate until this has propagated.

| Name | Type | Value |
|---|---|---|
| `adtp.stratuslabs.com` | A / AAAA | Side A's host |
| `demo.adtp.dev` | A / AAAA | Side B's host |

**2. Start Side B.** On Side B's host, with this repository checked out:

```sh
cd demo/side-b
cp .env.example .env
# edit .env: ADTP_DOMAIN, ADTP_HOST, TRUSTED_SENDER (Side A's agent address)
echo "ADTP_ADMIN_TOKEN=$(openssl rand -hex 24)" >> .env    # for you: admin pages, requests tray
echo "ADTP_AGENT_TOKEN=$(openssl rand -hex 24)" >> .env    # for the echo agent
docker compose --profile tls up -d --build
```

Check it from anywhere:

```sh
curl https://demo.adtp.dev/healthz                      # {"status":"ok","domain":"demo.adtp.dev",...}
curl https://demo.adtp.dev/.well-known/adtp/echo        # the echo agent's card
```

**3. Start Side A.** On Side A's host:

```sh
cd demo/side-a
cp .env.example .env
# edit .env: ADTP_DOMAIN, ADTP_HOST, DEMO_TO (Side B's address)
echo "ADTP_ADMIN_TOKEN=$(openssl rand -hex 24)" >> .env    # for you
echo "ADTP_AGENT_TOKEN=$(openssl rand -hex 24)" >> .env    # for the Stratus agent's ADTP tool
docker compose --profile tls up -d --build
curl https://adtp.stratuslabs.com/healthz
```

If you already terminate TLS elsewhere (Fly.io, a load balancer), drop
`--profile tls` and forward to the node on `127.0.0.1:7387`.

**4. Publish where the cards live.** Each node prints its record at startup
(`docker compose logs node | grep -A1 '^DNS'`):

| Name | Type | Value |
|---|---|---|
| `_adtp.stratuslabs.com` | TXT | `v=adtp0; card=https://adtp.stratuslabs.com/.well-known/adtp/{local}; directory=https://adtp.stratuslabs.com/.well-known/adtp` |
| `_adtp.demo.adtp.dev` | TXT | `v=adtp0; card=https://demo.adtp.dev/.well-known/adtp/{local}; directory=https://demo.adtp.dev/.well-known/adtp` |

Side A's record is required: its node lives on a subdomain, so without the
record nobody can find `agent@stratuslabs.com`, and Side B could not verify
its signature. Side B serves its node on the domain itself, so the well-known
fallback already works there and its record is optional.

Optionally, give Side A a fallback too, for resolvers that find no TXT record:
redirect `https://stratuslabs.com/.well-known/adtp/*` to
`https://adtp.stratuslabs.com/.well-known/adtp/:splat` on the main site. Cards
are fetched through up to three redirects.

**5. Check that each side can find the other.** Both directions matter: the
sender has to find the recipient, and the recipient has to find the sender's
keys.

```sh
# on Side A
docker compose exec node adtp resolve echo@demo.adtp.dev
docker compose exec node adtp resolve --public agent@stratuslabs.com   # your own address, as others see it

# on Side B
docker compose exec node adtp resolve agent@stratuslabs.com
```

Each prints the DNS record it used, the card URL, the endpoint and the key id,
or says what failed.

**6. Send the first live message.** On Side A's host, from the repository root:

```sh
bash demo/run.sh --public            # the full exchange, with a transcript
bash demo/run.sh --public --tamper   # one flipped byte; Side B must reject it
```

Watch Side B's half with `docker compose logs -f agent` in `demo/side-b`.

**If it does not work**

| What you see | Likely cause |
|---|---|
| `curl` to `https://…/healthz` fails or the certificate is invalid | The A record has not propagated, or ports 80/443 are closed. `docker compose logs caddy` says which. |
| `could not be discovered` / `could not resolve …` | The other side's TXT record is missing or mistyped, or its node is down. Run step 5. |
| `retrying … sender_unresolvable`, then a timeout | Side B cannot find Side A's card to check the signature: Side A's `_adtp` TXT record (step 4). The node keeps retrying, so the message goes through once the record is live. |
| `queued … held for approval` | `TRUSTED_SENDER` on Side B does not match Side A's agent address exactly. Fix `.env`, then `docker compose up -d`. |
| `rejected  bad_signature` | Side B is reading a stale or wrong card for Side A, for example a TXT record that points at a different node. |
| `rejected  invalid_envelope: created_at is in the future`, or `expired` straight away | The two hosts' clocks disagree by more than a few minutes. Check NTP on both. |
| `migration … failed … created by an earlier build` in a node's log | The data volume is from an older build. `docker compose down --volumes` on that side, then start it again (this also makes a new signing key). |
| Statuses stop after `delivered` | Side B's agent is not running, so nothing reads or answers: `docker compose ps` in `demo/side-b`. |

**About the pre-trusted sender.** Normally a first message from an unknown
sender waits in the recipient's requests tray. For the demo, Side B's config
lists Side A's agent under `trusted`, so nothing waits for approval. Remove
that entry and the same run reports `queued`, and the message sits at `/admin`
on Side B until someone approves it.

### The ADTP tool for the Stratus agent

[`integrations/stratus/adtp-tool.ts`](integrations/stratus/adtp-tool.ts) is one
file with no imports. The agent talks only to its own node's HTTP API, with the
node's agent token, and never holds the signing key or the admin token.

```ts
import { createAdtpTool } from './adtp-tool';

const adtp = createAdtpTool({
  nodeUrl: 'http://localhost:7387',           // Side A's node
  token: process.env.ADTP_AGENT_TOKEN!,       // the agent token, not the admin one
  address: 'agent@stratuslabs.com',
});

// Surface status updates and replies in the agent's own log or chat.
adtp.adtp_on_status((s) => log(`${s.message_id} ${s.status} at ${s.at}`));   // accepted, delivered, read, ...
adtp.adtp_on_message((m) => log(`${m.from} replied on ${m.thread}: ${m.text}`));

// Send. The node adds on_behalf_of and the delegation, signs, resolves and delivers.
await adtp.adtp_send('echo@demo.adtp.dev', 'request', 'Hello from Stratus Labs.', { type: 'demo.ping' });

// Find out who to write to at a domain: the addresses it lists, and what each is for.
const { entries } = await adtp.adtp_directory('demo.adtp.dev');

// To let the model send and look up: register adtp.tools, and route its tool calls here.
const result = await adtp.call(toolCall.name, toolCall.input);
```

Once the agent is wired up, `bash demo/run.sh --public --watch` transcribes the
message the agent sends instead of sending its own.

### Recording it

![The local run: Side A's transcript on the left, Side B's agent log on the right](demo/local-demo.gif)

`bash demo/split.sh` opens a tmux session with the run on the left and Side B's
agent log on the right; both are colour-coded. For the public recording, put the
Stratus agent's own window on the left and run `demo/split.sh --public --watch`
(or just the Side B log) on the right. Any screen recorder will do; for a
terminal-only GIF, `asciinema rec` followed by `agg` produces one well under
10 MB for a run this short.

### What is stubbed or faked in the demo

- **The Stratus agent is played by a script.** `demo/run.ts` sends through the
  same ADTP tool the real agent would use. The tool has not been added to the
  Stratus agent's own repository; that still has to be done there.
- **The recording is of the local run only.** [`demo/local-demo.gif`](demo/local-demo.gif)
  was rendered from the captured terminal output of `demo/split.sh` in local
  mode, with the script playing the Stratus agent. The 30 to 60 second video of
  the public run, with the real Stratus agent on the left, still has to be
  recorded.
- **The public run has not been exercised yet.** It needs the two real
  hosts and DNS records. What was tested: both `side-a` and `side-b` stacks
  start and serve the right cards; `--public` performs a real DNS lookup and
  fails cleanly when the other side is not published; and the DNS and
  well-known paths (including a redirect) are covered by tests with a stand-in
  for DNS and TLS. The bundled Caddy profile was tested only with Caddy's own
  certificate for `localhost`; obtaining a real certificate was not.
- **Local mode skips DNS and TLS**: discovery overrides and plain HTTP between
  containers.
- **Dylan's delegation is signed by the node.** `dylan@` and `agent@` live on
  the same node, which holds one key for both. The token is real and Side B
  verifies it, but no separate device or person signs it.
- **The echo agent is scripted**, with no model behind it. It answers requests
  only.
- **"Delivered" means handed to the agent's feed** on its node, not that a
  process consumed it; `read` is the agent's own acknowledgement.

## Run a node

You need Docker with Compose.

```sh
docker compose up
```

This builds the node and starts it with [Mailpit](https://mailpit.axllent.org),
a local mail catcher. There is no database to set up: messages are kept in a
SQLite file in the node's data volume. On first run the node generates its
signing key, creates the database, and prints its identity:

```
ADTP node for localhost

Addresses:
  me@localhost  (human)  http://localhost:7387/.well-known/adtp/me
  assistant@localhost  (agent)  http://localhost:7387/.well-known/adtp/assistant

Directory: http://localhost:7387/.well-known/adtp  (empty: no address is listed)

Public keys (published in every card):
  ed25519-dd05cf8521300dc7  wiScSzl_dSWs0VALb6-JfR3ZvTt8lH1h33T_zldrSH8  (active)

DNS: add this TXT record so other nodes can find your addresses and your directory:
  _adtp.localhost.  TXT  "v=adtp0; card=http://localhost:7387/.well-known/adtp/{local}; directory=http://localhost:7387/.well-known/adtp"

Admin UI: http://localhost:7387/admin  (admin token: stored in /data/admin-token)
Agents use the agent token (stored in /data/agent-token), which cannot reach the admin pages.

Database: SQLite file /data/adtp.db
```

| What | Where |
|------|-------|
| Health check | http://localhost:7387/healthz |
| Admin UI (requests tray, inbox, threads) | http://localhost:7387/admin |
| A card | http://localhost:7387/.well-known/adtp/me |
| Where other nodes send envelopes | `POST http://localhost:7387/adtp/v0/messages` |
| Caught emails | http://localhost:8025 |

The node listens on port 7387. Both tokens are generated on first run and kept
out of the logs. Read them with:

```sh
docker compose exec node cat /data/admin-token    # yours: admin pages, requests tray, delegations
docker compose exec node cat /data/agent-token    # for an agent: send, mark read, follow events
```

### Send a first message

The default config hosts two addresses on one node, which is enough to see the
whole path, including the requests tray. Send from one to the other:

```sh
docker compose exec node adtp send \
  --from me@localhost --to assistant@localhost \
  --intent request --text "Please book a room for Tuesday"
```

`assistant@localhost` has never interacted with `me@localhost`, so the message
is held:

1. Open http://localhost:7387/admin, sign in with the admin token, and find the
   message under **Requests**.
2. Click **Approve and trust sender**.
3. Open http://localhost:8025: the email has arrived at the address from the
   matching route in `adtp.config.yaml`.
4. Check the status. It is `delivered` on both the sent and the received copy:

```sh
docker compose exec node adtp status <message-id>
```

The same thing over the local API, from the host:

```sh
TOKEN=$(docker compose exec -T node cat /data/admin-token)

curl -s localhost:7387/api/v0/messages \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"from":"me@localhost","to":"assistant@localhost","intent":"inform","text":"Hello again"}'

curl -s localhost:7387/api/v0/messages/<message-id> -H "Authorization: Bearer $TOKEN"
```

### Email and requests-tray walkthrough

```sh
bash examples/email-tray/run.sh
```

A second scripted run, for the human side of the node: `alice.localhost` sends
`bob.localhost` a request, it lands in Bob's requests tray, Bob approves it, it
is delivered by email (Mailpit catches it), Bob opens and answers it, and
`delivered`, `read` and `replied` flow back to Alice.

### Configuration

Everything is in one file, [`adtp.config.yaml`](adtp.config.yaml), mounted into
the container. It is commented throughout; the sections are:

| Section | What it sets |
|---------|--------------|
| `domain` | The domain of your addresses. |
| `public_url` | The URL other nodes use to reach this node. Cards, the DNS record and read-receipt links are built from it. |
| `listen` | Where to listen. Port 7387 unless you say otherwise. |
| `database_url` | Leave it out for SQLite. Set it to `postgres://…` for Postgres (`DATABASE_URL` overrides it). |
| `keys` | The rotation grace period, and optionally the keyring path. |
| `addresses` | The humans and agents this node hosts. Each has delivery `routes` (to `email`, or to the built-in `agent` and `inbox` channels); agents may have `acts_for` and any address a `trusted` list. `listed: true` with a `description` puts an address in [the directory](#the-directory); `first_contact: open` and `auto_reply` make it answer strangers by itself. |
| `channels.email` | SMTP settings, the From address, the inbound-reply token, read receipts. |
| `rate_limits` | Hourly limits for first-contact senders, per sender and per organization. |
| `delivery` | Maximum attempts and backoff for retries. |
| `limits` | `max_age_days`: how old a message's `created_at` may be (7). `retention_days`: how long stored messages are kept (30). |
| `delegation` | Default and maximum lifetime of the delegation tokens this node signs (24 hours, 7 days). |
| `discovery` | Card cache time, and local-development overrides. |
| `plugins` | Extra channel adapters to load. |

Any string can pull from the environment with `${NAME}` or `${NAME:-default}`.
These variables are read directly:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Unset: SQLite in the data directory. `postgres://user:password@host/db`: Postgres. |
| `ADTP_ADMIN_TOKEN` | Admin token: the admin pages, the requests tray, delegations, and everything the agent token can do. If unset, one is generated into the data directory. |
| `ADTP_AGENT_TOKEN` | Agent token: what you give an agent. Send, mark read, follow events, look up messages and addresses, for the node's agent addresses only. Must differ from the admin token. If unset, one is generated into the data directory. |
| `ADTP_PRIVATE_KEY` | Signing key as a base64url 32-byte Ed25519 seed. If unset, a key is generated into the data directory. |
| `ADTP_CONFIG` | Path of the config file (default `./adtp.config.yaml`). |
| `ADTP_DATA_DIR` | Where the keyring, the two tokens and the SQLite database live (`/data` in the image, `./data` otherwise). |
| `LOG_LEVEL` | `debug`, `info` (default), `warn`, `error`. |

#### Database

Out of the box the node keeps everything in one SQLite file, `adtp.db`, in its
data directory, using the SQLite built into Node. Nothing to install, nothing
to run, and backing up the data volume backs up the keys and the messages
together.

One thing to know: Node 22 still labels its built-in SQLite module
(`node:sqlite`) experimental. The node says so once in its startup log, pins
itself to the Node 22 line (`package.json` and the `Dockerfile`), and runs its
whole test suite on it. If you would rather not depend on it, use Postgres.
[DECISIONS.md](DECISIONS.md#2-database) has the reasoning.

Postgres is one setting. Either point the node at a server you already run:

```sh
DATABASE_URL=postgres://user:password@host:5432/adtp docker compose up
```

or let Compose run one next to the node:

```sh
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up
```

Which to use: SQLite suits one node process on one machine, which is every
self-hosted setup so far. Choose Postgres to run several node processes
against one database, or to keep the data on a managed server. A node switched
from one to the other starts empty: v0 does not copy messages across.

Either way, messages are deleted 30 days after they arrived
(`limits.retention_days`), once they have also expired.

#### Routes

Each address has a list of routes. The first route whose `match` conditions all
hold is used; the `default: true` route catches the rest. Routes are private
and never appear in cards.

```yaml
routes:
  - match: { priority: urgent }                  # low, normal or urgent; one value or a list
    channel: email
    to: me+urgent@example.com
  - match: { sender_type: agent, intent: approval.request, from_org: acme.com }
    channel: email
    to: approvals@example.com
  - default: true
    channel: email
    to: me@example.com
```

`from_org` is the sender's domain. `sender_type` is `human` or `agent`, taken
from the sender's card.

#### Agents

```yaml
addresses:
  - local: dylan
    type: human
  - local: agent
    type: agent
    acts_for: dylan                  # sends carry on_behalf_of and a delegation signed by the node
    trusted:                         # senders that skip the requests tray on first contact
      - echo@demo.adtp.dev
      - "*@partner.example"
    routes:
      - default: true
        channel: agent               # hand messages to the agent itself; no `to` needed
```

The `agent` channel puts each message on a feed the agent reads from its own
node: `GET /api/v0/events?address=...&after=<cursor>&wait=20` holds the request
open until something arrives. The same feed carries status updates for the
messages the agent sent. The [ADTP tool](#the-adtp-tool-for-the-stratus-agent)
wraps this. Give the agent the node's agent token, not the admin token.

**The inbox channel** is the same handoff for a person, and needs no email:

```yaml
  - local: dylan
    type: human
    routes:
      - default: true
        channel: inbox               # keep messages on the node; no `to` needed
```

Messages stay on the node. Their owner opens them under **Inbox** at `/admin`,
where each one has a **Mark read** button and a reply box; the sender is told
`read` and `replied` as with any other channel. **New message** on the same
pages writes a first message from any of the node's addresses.

**An address that answers by itself.** Two settings turn an address into a
greeter, a help desk's front door, or a test target:

```yaml
  - local: welcome
    type: agent
    first_contact: open              # a stranger's first message is delivered at once, not held
    auto_reply: Welcome. Your message arrived, so your node can send and receive.
    routes:
      - default: true
        channel: inbox
```

`first_contact: open` skips the requests tray for this address. Strangers are
still limited to `inform` and `request`, and to the hourly first-contact
limits. `auto_reply` answers each message with the text given: once per
thread, never in answer to another automatic message, and at most ten times an
hour to the same sender.

### Running on a real domain

1. **Addresses.** Set `domain` (say `example.com`) and list your `addresses`.
2. **Public URL.** Put the node behind a TLS-terminating reverse proxy and set
   `public_url` to its https URL, for example `https://adtp.example.com`.
   Other nodes refuse to fetch cards or deliver over plain http.
3. **DNS.** Start the node (or run `docker compose exec node adtp keys show`)
   and add the TXT record it prints:

   ```
   _adtp.example.com.  TXT  "v=adtp0; card=https://adtp.example.com/.well-known/adtp/{local}; directory=https://adtp.example.com/.well-known/adtp"
   ```

   The record is optional only if `https://example.com/.well-known/adtp/{local}`
   answers too, directly or by redirecting to the node: that is the fallback.
   (The fallback for the directory is `https://example.com/.well-known/adtp`.)
4. **Email out.** Point `channels.email.smtp` at your mail server, pass the
   password as `SMTP_PASSWORD`, and remove the `mailpit` service from
   `docker-compose.yml`.
5. **Email replies in.** Set `EMAIL_INBOUND_TOKEN` and have whatever receives
   your mail (an inbound-parse service or a mail server script) POST each reply
   to `/hooks/email` with `Authorization: Bearer <token>`:

   ```json
   {
     "from": "Bob <bob@example.com>",
     "to": "reply+3f9c...@in.example.com",
     "subject": "Re: [ADTP request] ...",
     "text": "Sounds good.",
     "headers": { "In-Reply-To": "<adtp.3f9c...@example.com>", "Message-ID": "<abc@mail.example.com>" }
   }
   ```

   A reply is matched by the token in `In-Reply-To`/`References` (or in the
   `Reply-To` address, if you set `channels.email.reply_to`) and must come from
   the mailbox the message was delivered to.
6. **Backups.** Back up the `adtp-data` volume. It holds the signing key, the
   two tokens and, on SQLite, every message.

The messages endpoint (`/adtp/v0/messages`) is open to the internet by design:
anyone may post, and nothing is stored until a signature verifies. Rate-limit
it at your proxy. Keep `/api/v0` and `/admin` off the public internet if you
can; they are guarded by the tokens either way.

### The directory

Someone who knows your domain but not your addresses can ask it who to write
to. The answer is your directory: the addresses you chose to list, each with a
line saying what it is for. Nothing is listed until you say so:

```yaml
addresses:
  - local: ap
    type: agent
    listed: true
    description: Accounts payable. Send invoices and payment questions here.
```

The node serves the list at `/.well-known/adtp` and names that URL in the DNS
record it prints, so listing an address later needs no DNS change. An unlisted
address works as before for anyone who knows it, and a listed one is no easier
to reach: a first message from a stranger still waits in the requests tray.
The directory is public, so list entry points, not people who would rather not
be found.

To look up another domain:

```sh
docker compose exec node adtp directory acme.com
docker compose exec node adtp directory --public example.com   # your own, as others see it
```

```
acme.com lists 2 addresses:
  ap@acme.com  (agent)
      Accounts payable. Send invoices and payment questions here.
  hello@acme.com  (human)
      General enquiries.
found via  DNS  _adtp.acme.com  TXT  "v=adtp0; card=…; directory=https://adtp.acme.com/.well-known/adtp"
directory  https://adtp.acme.com/.well-known/adtp
```

Agents get the same lookup from `GET /api/v0/directory?domain=acme.com` and,
through the [ADTP tool](#the-adtp-tool-for-the-stratus-agent), as
`adtp_directory`. A description is the other domain's own words: an agent
should use it to pick an address and never treat it as instructions.

### Keys

```sh
docker compose exec node adtp keys show      # public keys and the DNS record
docker compose exec node adtp keys rotate    # new signing key
```

Rotation takes effect within a few seconds without a restart and needs no DNS
change. The previous key stays published, marked with an expiry, for
`keys.rotation_grace_days` so messages signed just before the rotation still
verify. Its private half is deleted immediately.

### Delegation

An agent sends on behalf of a principal by naming it in `on_behalf_of` and
attaching a `delegation` token signed by the principal's key. Receivers verify
the token against the principal's published keys and refuse the message if the
token was issued to a different agent, does not cover the message's intent, is
meant for another node, has expired, or has been revoked.

- **Same node** (the usual case): set `acts_for` on the agent. The node adds
  both fields and signs a token for each message: that message's intent, valid
  until the message expires. Nothing else to do.
- **Principal on another node**: that node signs a token, and the agent's node
  passes it along:

  ```sh
  docker compose exec node adtp delegate --principal me --agent bot@agents.example \
    --scope inform,request --ttl-hours 24
  ```

  This prints the token, and on stderr what it allows and its id (`jti`).
  `--scope` lists the intents the agent may send (default: `inform`,
  `request`, `status`). `--ttl-hours` defaults to 24 and cannot exceed
  `delegation.max_ttl_hours` (7 days). `--audience https://adtp.example.org`
  limits the token to one receiving node.

  ```json
  { "from": "bot@agents.example", "to": "bob@example.org", "intent": "request", "text": "...",
    "on_behalf_of": "me@example.com", "delegation": "<token>" }
  ```

- **Taking a token back** before it expires:

  ```sh
  docker compose exec node adtp revoke dlg_Zk3vQ0c1b2R5d0xq
  ```

  From then on this node neither sends nor accepts messages that carry it.
  Other nodes cannot be told in v0, which is why tokens are short-lived.

### Local API

Every endpoint takes `Authorization: Bearer <token>`. There are two tokens.

**With the agent token** (or the admin token). The agent token works only for
the node's agent addresses: it cannot send as a person or read a person's feed.

| Method and path | Purpose |
|-----------------|---------|
| `POST /api/v0/messages` | Send from a hosted address. Body: `from`, `to` (address or list), `intent`, `text`, and optionally `data`, `thread`, `priority` (`low`, `normal`, `urgent`), `expires_at` (default: seven days from now), `requires_approval`, `on_behalf_of` (leave it out to use the agent's configured `acts_for`; `null` to send as the address itself), `delegation`, `id`, `in_reply_to` (marks that received message replied, if this one is addressed to its sender), `dry_run` (sign only; returns the envelope). |
| `POST /api/v0/messages/{id}/read` | Body: `recipient`, and optionally `from` (the sender, in the rare case two senders used the same id). Marks a received message read and tells the sender. |
| `GET /api/v0/events` | An address's feed. Query: `address`, `after` (a sequence number, or `latest`), `wait` (seconds to hold the request open), `limit`. |
| `GET /api/v0/messages/{id}` | Delivery state per recipient and the signed envelope, for the sent and/or received copy. |
| `GET /api/v0/threads/{thread}` | Every message on a thread, oldest first. |
| `GET /api/v0/resolve` | Query: `address`. The card this node resolves for it, and how it was found. |
| `GET /api/v0/directory` | Query: `domain`. The addresses that domain lists and what each is for, and how the directory was found. `502` if the domain publishes none. |

**With the admin token only.**

| Method and path | Purpose |
|-----------------|---------|
| `GET /api/v0/tray` | First-contact messages awaiting a decision. |
| `POST /api/v0/tray/approve`, `/reject` | Body: `id`, `recipient`, and optionally `from`. |
| `POST /api/v0/delegations` | Body: `principal`, `agent`, and optionally `scope` (list of intents), `ttl_seconds`, `audience`. Returns the token, its `jti`, and when it expires. |
| `POST /api/v0/delegations/{jti}/revoke` | Takes a delegation back. |
| `/admin/...` | The web UI: sign in with the admin token. |

The node-to-node endpoint, `POST /adtp/v0/messages`, takes no token: envelopes
are authenticated by their signatures. [SPEC.md](SPEC.md#7-transport) describes
it.

[`src/client.ts`](src/client.ts) is a small client for send and status;
[`integrations/stratus/adtp-tool.ts`](integrations/stratus/adtp-tool.ts) is the
agent-side tool.

### Embedding the node

`src/index.ts` exports the node, its HTTP app and the protocol functions for
code that wants to run a node inside something else. Four things can be
replaced without touching the engine: where signing keys come from
(`KeyStore`), storage (`Store`), which addresses the node answers for
(`DomainResolver`), and who a token belongs to (`TokenVerifier`).
[ARCHITECTURE.md](ARCHITECTURE.md#seams) describes each. This repository itself
stays single-domain.

## Tests

```sh
npm ci
npm test                     # on SQLite: needs nothing but Node 22 (22.16 or later)
```

The same suite on Postgres, pointed at a server you run:

```sh
TEST_DATABASE_URL=postgres://adtp:adtp@localhost:5432/adtp_test npm run test:postgres
```

Or both, in containers, with a throwaway Postgres:

```sh
docker compose -f docker-compose.test.yml run --rm test
docker compose -f docker-compose.test.yml down --volumes
```

Each suite gets a database of its own: a temporary SQLite file, or a Postgres
schema that is dropped afterwards. If `test:postgres` cannot reach its server
the database-backed suites are skipped with a warning; set
`ADTP_TEST_REQUIRE_DB=1` to make that a failure instead.

`test/demo.test.ts` runs the demo's own scripts (`echo-agent.js`, `run.js`,
`--tamper`, `--watch`) as child processes against two real nodes, and a second
scenario resolves both sides through DNS and the well-known fallback.
`test/spec.test.ts` checks SPEC.md against the code: its signed example, its
error table and its example documents. `test/protocol.test.ts` includes the
RFC 8785 examples for canonical JSON.

## Development

```sh
npm ci
npm run build                 # compile to dist/
node dist/src/cli.js start    # SQLite in ./data; no database to start
```

Outside Docker the node keeps its keyring, tokens and database in `./data`, and
`channels.email.smtp.host` in `adtp.config.yaml` needs to point at an SMTP
server you can reach (the default, `mailpit`, only resolves inside Compose).

```
SPEC.md          the protocol
src/protocol/    the protocol in code: envelope, signatures, delegation, cards, HTTP answers
src/identity/    keys, discovery, guarded HTTP client
src/db/          the database seam: SQLite and Postgres drivers
src/core/        receive pipeline, sender, queue worker, event feed, routing, SQL
src/adapters/    adapter interface, registry, email, agent
src/http/        endpoints, tokens and admin pages
src/index.ts     what the package exports
integrations/    the ADTP tool for agents
migrations/      one schema per database, applied at startup
demo/            the two-agent demo: local mode, side-a, side-b
examples/        email and requests-tray walkthrough
test/            node:test suites
```

## License

[MIT](LICENSE).
