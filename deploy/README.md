# Deploying a node on a hosting platform

A node is one container with one small disk. On a platform that builds from a
Dockerfile there is nothing else to run: no database, no proxy of your own.

- [Docker](#docker): one command, anywhere Docker runs.
- [Render](#render): one button.
- [Fly.io](#flyio): one script per node.
- [Any other platform](#any-other-platform): what the container needs.
- [Let your agent do it](agent-prompt.md): a prompt to hand to a coding agent.
- For servers of your own with Docker Compose, see
  [examples/two-domains](../examples/two-domains/README.md).

Whichever way you start it, a node needs the same two DNS records afterwards,
and can then [say hello](#3-say-hello) to check that it works.

## Docker

The image is published from this repository's `main` branch. One command starts
a node for one address:

```sh
docker run -d --name adtp --restart unless-stopped \
  -p 7387:7387 -v adtp-data:/data \
  -e ADTP_DOMAIN=example.com \
  -e ADTP_LOCAL=you \
  -e ADTP_PUBLIC_URL=https://adtp.example.com \
  ghcr.io/adtprotocol/adtp:latest
```

That is `you@example.com`, with its signing key and messages in the
`adtp-data` volume. Then:

1. **Put HTTPS in front of port 7387** at the hostname in `ADTP_PUBLIC_URL`,
   with your own proxy or with Caddy as in
   [examples/two-domains](../examples/two-domains/docker-compose.yml). Other
   nodes only talk to `https://` endpoints.
2. **Add the TXT record** from [step 2 below](#2-add-two-dns-records), and
   point the hostname at your server.
3. **Sign in** at `https://adtp.example.com/admin` with the admin token the
   node generated: `docker exec adtp cat /data/admin-token`.

To build the image yourself instead of pulling it: `docker build -t adtp .` in
a checkout, and use `adtp` as the image name.

## Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/adtprotocol/adtp)

The button creates one web service with a 1 GB disk from
[`render.yaml`](../render.yaml). Render asks for three values:

| Value | Meaning | Example |
|---|---|---|
| `ADTP_DOMAIN` | The domain in your address. | `example.com` |
| `ADTP_LOCAL` | The part of your address before the `@`. | `you` |
| `ADTP_PUBLIC_URL` | Where other nodes will reach the node: a hostname on your domain that is not in use yet. | `https://adtp.example.com` |

Then:

1. **Add that hostname to the service** under Settings, Custom Domains, and
   add the DNS record Render shows for it.
2. **Add the TXT record** from [step 2 below](#2-add-two-dns-records).
3. **Sign in** at `https://adtp.example.com/admin` with the value of
   `ADTP_ADMIN_TOKEN`, which Render generated: it is under the service's
   Environment tab.

The service needs a paid instance type, since Render's free one has no disk.
It does not redeploy when this repository changes; choose Manual Deploy in
Render to update it.

## Fly.io

What you need: a Fly.io account, [flyctl](https://fly.io/docs/flyctl/install/)
signed in (`fly auth login`), this repository checked out, and DNS access for
your domain. Fly builds the image from your checkout.

### 1. Start the node

One node serves one address on one domain. From the repository root:

```sh
bash deploy/fly/launch.sh <app-name> <address> <host> [human|agent] [description]
```

For example:

```sh
bash deploy/fly/launch.sh adtp-example you@example.com adtp.example.com
```

| Argument | Meaning | Example |
|---|---|---|
| `app-name` | The Fly app to create. Any name nobody else on Fly has taken. | `adtp-example` |
| `address` | The address this node serves. | `you@example.com` |
| `host` | The hostname the node is reached at. You point it at Fly in DNS. A subdomain keeps the domain itself free for a website. | `adtp.example.com` |
| `human` or `agent` | What kind of address it is. Default `human`. | `human` |
| `description` | One line saying what the address is for. Giving one lists the address in the domain's public directory. | |

The script creates the app and a 1 GB volume, generates the node's two API
tokens, builds and deploys, and asks Fly for an HTTPS certificate. Run it again
with the same arguments to deploy a newer version of the code; nothing is
created twice.

The tokens are kept in `.env.fly.<app-name>` at the repository root, which git
ignores. The admin token in that file signs you in at `https://<host>/admin`.

### 2. Add two DNS records

The script prints both.

1. **Point the host at Fly**, with the record(s) printed under "HTTPS
   certificate" (`fly certs show <host> --app <app-name>` prints them again).
   If your DNS provider offers to proxy the record, turn that off.
2. **Tell other nodes where your cards and directory are**, with a TXT record
   at `_adtp.<domain>`:

   | Name | Type | Value |
   |---|---|---|
   | `_adtp.example.com` | TXT | `v=adtp0; card=https://adtp.example.com/.well-known/adtp/{local}; directory=https://adtp.example.com/.well-known/adtp` |

Once DNS has propagated and the certificate is issued:

```sh
curl https://adtp.example.com/healthz                  # {"status":"ok","domain":"example.com",...}
curl https://adtp.example.com/.well-known/adtp/you     # your address's card
```

### 3. Say hello

`welcome@adtprotocol.com` answers every first message by itself, so it is a
quick way to see your node send, be verified, and receive.

1. Open `https://adtp.example.com/admin` and sign in with the admin token from
   `.env.fly.adtp-example`.
2. Choose **New message**, write to `welcome@adtprotocol.com`, and send.
3. Reload the thread page after a few seconds. The state goes from `sent` to
   `replied`, and the welcome is on the thread.

If the state stays `pending`, the other node could not find your address yet:
check the TXT record from step 2. The node keeps retrying, so the message goes
through once the record is live. `fly logs --app <app-name>` shows what your
node did with the message.

To exchange messages between two addresses of your own, start a second node on
another domain the same way. A first message between them waits under
**Requests** on the receiving node until you approve the sender;
[examples/two-domains](../examples/two-domains/README.md#4-send-the-first-message)
walks through it.

### An address that answers by itself

Two optional settings, read from the environment when the script runs, make an
address take first messages from anyone and answer them. This is how
`welcome@adtprotocol.com` is set up:

```sh
ADTP_FIRST_CONTACT=open \
ADTP_AUTO_REPLY="Welcome. Your message arrived, so your node can send and receive." \
bash deploy/fly/launch.sh adtp-welcome welcome@example.com adtp.example.com agent "Says hello. The reply is automatic."
```

Strangers are still limited to `inform` and `request` and to the hourly
first-contact limits, and the address answers each thread once.

### Good to know

- **Cost.** Each node is one small machine (shared CPU, 512 MB) that stays
  running, plus a 1 GB volume. Fly's pricing page has the current figures.
- **The volume holds the signing key and every message.** Deleting the app or
  the volume deletes both. `fly volumes snapshots list <volume-id>` shows the
  daily snapshots Fly keeps.
- **The node runs as root inside its machine** (`RUN_AS=root` in `fly.toml`),
  because a Fly volume is writable only by root. Elsewhere it runs as an
  unprivileged user.
- **To update a node without a checkout,** this repository has a workflow that
  deploys `main` to an app you name: on GitHub, Actions, **Deploy to Fly.io**,
  Run workflow. It needs a Fly.io deploy token saved as the repository secret
  `FLY_API_TOKEN`, runs only when someone starts it, and leaves the node's
  settings and data alone. In a fork, change the repository name at the top of
  [the workflow](../.github/workflows/deploy-fly.yml) first.
- **To remove a node:** `fly apps destroy <app-name>`, and delete its two DNS
  records and its `.env.fly.<app-name>` file.

## Any other platform

The image built from the repository's `Dockerfile` needs:

| What | Value |
|---|---|
| A port to route HTTPS to | `7387`, or whatever the platform sets `PORT` to (plain HTTP inside; the platform terminates TLS) |
| A persistent disk | Mounted at `/data`, writable by the container's user. If the platform only lets root write to it, build with `--build-arg RUN_AS=root`. |
| A health check | `GET /healthz` |
| One instance, always running | The node retries deliveries on its own clock, and its SQLite file belongs to one process. |

and these environment variables (the image's default config,
[`env.config.yaml`](env.config.yaml), reads nothing else):

| Variable | Meaning | Example |
|---|---|---|
| `ADTP_DOMAIN` | The domain in the address. | `example.com` |
| `ADTP_PUBLIC_URL` | Where other nodes reach this node. | `https://adtp.example.com` |
| `ADTP_LOCAL` | The address is `<ADTP_LOCAL>@<ADTP_DOMAIN>`. | `you` |
| `ADTP_TYPE` | `human` (default) or `agent`. | |
| `ADTP_CHANNEL` | `inbox` (default): messages stay on the node and are read at `/admin`. `agent`: they go to the event feed an agent reads. | |
| `ADTP_LISTED`, `ADTP_DESCRIPTION` | `true` and one line of text to list the address in the public directory. | |
| `ADTP_FIRST_CONTACT` | `held` (default): a stranger's first message waits for approval. `open`: it is delivered at once. | |
| `ADTP_AUTO_REPLY` | A text the node answers every message with, once per thread. | |
| `ADTP_ADMIN_TOKEN`, `ADTP_AGENT_TOKEN` | The two API tokens. Generated into `/data` if not set. | |
| `PORT` | The port to listen on, on platforms that choose it for the container. Default `7387`. | |

Then publish the TXT record from step 2 above, with your own host in it.
For more than one address, or delivery by email, mount a config file of your
own at `/app/adtp.config.yaml`; the [`adtp.config.yaml`](../adtp.config.yaml) at
the repository root shows every setting.
