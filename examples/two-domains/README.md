# Two addresses on two real domains

A first live exchange between two nodes on the public internet:

| | Server 1 | Server 2 |
|---|---|---|
| Address | `agent@example.com` (an agent) | `dana@example.org` (a person) |
| Domain (`ADTP_DOMAIN`) | `example.com` | `example.org` |
| Node served at (`ADTP_HOST`) | `adtp.example.com` | `adtp.example.org` |
| Settings to start from | `first.env.example` | `second.env.example` |
| Admin pages | `https://adtp.example.com/admin` | `https://adtp.example.org/admin` |

Both addresses keep their messages on the node (`channel: inbox`), so there is
no email to set up: you write, read and answer in the browser, on each node's
admin pages. The names above are placeholders: put your own two domains in the
`.env` presets. Each node takes all of its settings from that
`.env` (the image's default config, [`deploy/env.config.yaml`](../../deploy/env.config.yaml),
reads nothing else).

This page is for two servers of your own. To run the same two nodes on Fly.io
instead, with no servers to look after, see [deploy/README.md](../../deploy/README.md).

## Before you start

- You control DNS for both domains.
- Two Linux servers with Docker and Compose, each reachable from the internet
  on ports 80 and 443.
- This repository checked out on both servers.

## 1. DNS

Point each node's hostname at its server:

| Name | Type | Value |
|---|---|---|
| `adtp.example.com` | A / AAAA | Server 1's address |
| `adtp.example.org` | A / AAAA | Server 2's address |

Tell other nodes where each domain's cards and directory are:

| Name | Type | Value |
|---|---|---|
| `_adtp.example.com` | TXT | `v=adtp0; card=https://adtp.example.com/.well-known/adtp/{local}; directory=https://adtp.example.com/.well-known/adtp` |
| `_adtp.example.org` | TXT | `v=adtp0; card=https://adtp.example.org/.well-known/adtp/{local}; directory=https://adtp.example.org/.well-known/adtp` |

Both TXT records are required: each node lives on a subdomain, so without the
record nobody can find the address or check its signatures. A running node
prints its own record (`docker compose exec node adtp keys show`), which should
match the table.

## 2. Start each node

On server 1:

```sh
cd examples/two-domains
cp first.env.example .env
echo "ADTP_ADMIN_TOKEN=$(openssl rand -hex 24)" >> .env
echo "ADTP_AGENT_TOKEN=$(openssl rand -hex 24)" >> .env
docker compose --profile tls up -d --build
```

On server 2, the same with `second.env.example`.

The first start builds the image, which takes a few minutes. Caddy then
obtains an HTTPS certificate for `ADTP_HOST`; that only works once the A record
from step 1 has propagated. Check each node from anywhere:

```sh
curl https://adtp.example.com/healthz                    # {"status":"ok","domain":"example.com",...}
curl https://adtp.example.com/.well-known/adtp/agent     # agent@example.com's card
curl https://adtp.example.org/healthz
curl https://adtp.example.org/.well-known/adtp/dana      # dana@example.org's card
```

The admin token is the line `ADTP_ADMIN_TOKEN=…` in each server's `.env`. It
signs you in to that node's admin pages. Keep it private.

## 3. Check that each side can find the other

Both directions matter: a sender has to find the recipient, and the recipient
has to find the sender's keys.

```sh
# on server 1
docker compose exec node adtp resolve dana@example.org
docker compose exec node adtp resolve --public agent@example.com     # your own address, as others see it

# on server 2
docker compose exec node adtp resolve agent@example.com
docker compose exec node adtp directory example.com                   # lists agent@example.com and what it is for
```

Each prints the DNS record it used, the card URL, the endpoint and the key id,
or says what failed.

## 4. Send the first message

**From `agent@example.com`**, in a browser: open `https://adtp.example.com/admin`,
sign in with server 1's admin token, choose **New message**, write to
`dana@example.org` and send. The thread page that follows shows the
message's state; reload it to see the state change.

Or from the command line on server 1:

```sh
docker compose exec node adtp send --from agent@example.com --to dana@example.org \
  --intent request --text "Hello from example.com. Can you read this?"
docker compose exec node adtp status <id>      # the id that send printed
```

The state is `sent` at first: server 2 took the message and is holding it,
because `dana@example.org` has never heard from this sender.

**As Dana**, in a browser:

1. Open `https://adtp.example.org/admin` and sign in with server 2's admin
   token.
2. Under **Requests**, find the message and choose **Approve and trust
   sender**. The state on server 1 becomes `delivered`.
3. Under **Inbox**, open the message. **Mark read** turns the state on
   server 1 to `read`.
4. Type an answer in the box and choose **Send reply**. The state on server 1
   becomes `replied`.

**Back on server 1**, the answer is under **Inbox** at
`https://adtp.example.com/admin` (sign in with server 1's admin token), on the
same thread. It arrived without waiting for approval: `agent@example.com` wrote
to Dana first, so it already knows the sender.

**The other direction**, on server 2. Nothing waits this time, since each side
now knows the other:

```sh
docker compose exec node adtp send --from dana@example.org --to agent@example.com \
  --text "Writing to you first this time."
```

To answer a received message from the command line instead of the browser, add
`--in-reply-to <id>` with the id of the message being answered.

## If it does not work

| What you see | Likely cause |
|---|---|
| `curl` to `https://…/healthz` fails or the certificate is invalid | The A record has not propagated, or ports 80/443 are closed. `docker compose logs caddy` says which. |
| `could not resolve …` from `adtp resolve` | The other side's TXT record is missing or mistyped, or its node is down. |
| The state stays `pending`, and `adtp status` shows `sender_unresolvable` | The receiving node cannot find the sender's card to check the signature: the sender's own TXT record. The node keeps retrying, so the message goes through once the record is live. |
| The state stays `sent` | The message is waiting under **Requests** on the other node. |
| `rejected` with `created_at is in the future`, or `expired` straight away | The two servers' clocks disagree by more than a few minutes. Check NTP on both. |
| The admin page refuses the token | Use `ADTP_ADMIN_TOKEN` from that server's `.env`, not the agent token. |

`docker compose logs node` on either server shows what that node did with each
message. The demo's [README](../../demo/README.md#on-two-real-domains) has a longer
list.

## Afterwards

- **Back up the `node-data` volume.** It holds the signing key, and every
  message.
- **To start over** with an empty node and a new key:
  `docker compose --profile tls down --volumes`, then start it again.
- **To deliver to a real mailbox** instead of the inbox page, give the address
  an `email` route and a `channels.email` section, as in the main
  [README](../../README.md#running-on-a-real-domain).
