# ADTP v0 demo: one signed message, end to end

`agent@stratuslabs.localhost` → `echo@demo.adtp.localhost`

**Result:** ✅ accepted, delivered, read, and a reply on the same thread in 0.11s

## Timeline

| Time (UTC) | Elapsed | Side | Step | What happened |
|---|---|---|---|---|
| 05:09:51.367 | +0.016s | stratus | discover | local mode: discovery override for demo.adtp.localhost (no DNS lookup) |
| 05:09:51.367 | +0.016s | stratus | card | http://echo-node:7387/.well-known/adtp/echo  →  endpoint http://echo-node:7387/adtp/v0/messages, key ed25519-dc65fc07efdb9693 |
| 05:09:51.390 | +0.039s | stratus | send | adtp_send → msg_01M7Y85HMS41SDMNZBTACM8SQD on thr_01M7Y85HMSTAXEJGMRN7J8F2KZ |
| 05:09:51.395 | +0.044s | stratus | envelope | signed by the node for agent@stratuslabs.localhost |
| 05:09:51.415 | +0.067s | side-b | accepted | signature verified (key ed25519-c897bfac911ca1da); delegation verified: agent@stratuslabs.localhost acts for dylan@stratuslabs.localhost; signed receipt from echo@demo.adtp.localhost checked |
| 05:09:51.415 | +0.079s | side-b | delivered | handed to echo@demo.adtp.localhost |
| 05:09:51.426 | +0.085s | side-b | read | echo@demo.adtp.localhost marked it read |
| 05:09:51.439 | +0.097s | side-b | replied | echo@demo.adtp.localhost answered |
| 05:09:51.452 | +0.105s | side-b | reply | inform from echo@demo.adtp.localhost on thr_01M7Y85HMSTAXEJGMRN7J8F2KZ |
| 05:09:51.457 | +0.106s | stratus | verify | reply signature verified (key ed25519-dc65fc07efdb9693) |

## The envelope

Signature and delegation token shortened for display.

```json
{
  "adtp": "0",
  "id": "msg_01M7Y85HMS41SDMNZBTACM8SQD",
  "thread": "thr_01M7Y85HMSTAXEJGMRN7J8F2KZ",
  "from": "agent@stratuslabs.localhost",
  "on_behalf_of": "dylan@stratuslabs.localhost",
  "to": [
    "echo@demo.adtp.localhost"
  ],
  "intent": "request",
  "priority": "normal",
  "created_at": "2026-11-21T05:09:51Z",
  "expires_at": "2026-11-21T06:09:51Z",
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
          "sent_at": "2026-11-21T05:09:51.373Z"
        }
      }
    ]
  },
  "delegation": "eyJhbGciOiJFZERT…8StxQnDg",
  "signature": {
    "alg": "Ed25519",
    "kid": "ed25519-c897bfac911ca1da",
    "value": "Ao_eIijW3ajOclVR…kmnXoiAA"
  }
}
```

## The reply

From `echo@demo.adtp.localhost` on thread `thr_01M7Y85HMSTAXEJGMRN7J8F2KZ`:

> Received your request, signature verified for agent@stratuslabs.localhost acting for dylan@stratuslabs.localhost.
