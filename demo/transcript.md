# ADTP v0 demo: one signed message, end to end

`agent@stratuslabs.localhost` → `echo@demo.adtp.localhost`

**Result:** ✅ accepted, delivered, read, and a reply on the same thread in 0.11s

## Timeline

| Time (UTC) | Elapsed | Side | Step | What happened |
|---|---|---|---|---|
| 17:25:13.032 | +0.016s | stratus | discover | local mode: discovery override for demo.adtp.localhost (no DNS lookup) |
| 17:25:13.033 | +0.017s | stratus | card | http://echo-node:7387/.well-known/adtp/echo  →  endpoint http://echo-node:7387/adtp/v0/messages, key ed25519-055722257d987f34 |
| 17:25:13.055 | +0.039s | stratus | send | adtp_send → msg_01M824MR6QDP6WS9T31F8VYCAM on thr_01M824MR6Q7P9CH22QPJ2YS58M |
| 17:25:13.062 | +0.046s | stratus | envelope | signed by the node for agent@stratuslabs.localhost |
| 17:25:13.076 | +0.066s | side-b | accepted | signature verified (key ed25519-bf52033376fb727e); delegation verified: agent@stratuslabs.localhost acts for dylan@stratuslabs.localhost; signed receipt from echo@demo.adtp.localhost checked |
| 17:25:13.075 | +0.084s | side-b | delivered | handed to echo@demo.adtp.localhost |
| 17:25:13.090 | +0.100s | side-b | read | echo@demo.adtp.localhost marked it read |
| 17:25:13.104 | +0.106s | side-b | replied | echo@demo.adtp.localhost answered |
| 17:25:13.126 | +0.114s | side-b | reply | inform from echo@demo.adtp.localhost on thr_01M824MR6Q7P9CH22QPJ2YS58M |
| 17:25:13.130 | +0.114s | stratus | verify | reply signature verified (key ed25519-055722257d987f34) |

## The envelope

Signature and delegation token shortened for display.

```json
{
  "adtp": "0",
  "id": "msg_01M824MR6QDP6WS9T31F8VYCAM",
  "thread": "thr_01M824MR6Q7P9CH22QPJ2YS58M",
  "from": "agent@stratuslabs.localhost",
  "on_behalf_of": "dylan@stratuslabs.localhost",
  "to": [
    "echo@demo.adtp.localhost"
  ],
  "intent": "request",
  "priority": "normal",
  "created_at": "2026-11-22T17:25:13Z",
  "expires_at": "2026-11-22T18:25:13Z",
  "requires_approval": false,
  "content": {
    "parts": [
      {
        "type": "text",
        "text": "Hello from Stratus Labs. This is the first ADTP message. Please confirm receipt."
      },
      {
        "type": "data",
        "data": {
          "type": "demo.ping",
          "sent_at": "2026-11-22T17:25:13.038Z"
        }
      }
    ]
  },
  "delegation": "eyJhbGciOiJFZERT…60Ex65BQ",
  "signature": {
    "alg": "Ed25519",
    "kid": "ed25519-bf52033376fb727e",
    "value": "9fsHurGGHzWgkaAB…5b7kbuDg"
  }
}
```

## The reply

From `echo@demo.adtp.localhost` on thread `thr_01M824MR6Q7P9CH22QPJ2YS58M`:

> Received your request, signature verified for agent@stratuslabs.localhost acting for dylan@stratuslabs.localhost.
