# ADTP v0 demo: a tampered message is rejected

`agent@stratuslabs.localhost` → `echo@demo.adtp.localhost`

**Result:** ✅ Side B refused the tampered envelope: the signature no longer matches

## Timeline

| Time (UTC) | Elapsed | Side | Step | What happened |
|---|---|---|---|---|
| 17:22:34.564 | +0.014s | stratus | discover | local mode: discovery override for demo.adtp.localhost (no DNS lookup) |
| 17:22:34.564 | +0.014s | stratus | card | http://127.0.0.1:7389/.well-known/adtp/echo  →  endpoint http://127.0.0.1:7389/adtp/v0/messages, key ed25519-ec0125b1d9565194 |
| 17:22:34.571 | +0.021s | stratus | envelope | signed by the node for agent@stratuslabs.localhost (not sent) |
| 17:22:34.572 | +0.022s | stratus | tamper | one byte changed in transit: "Hello…" → "Iello…" (signature untouched) |
| 17:22:34.583 | +0.033s | side-b | rejected | HTTP 401  bad_signature: the envelope signature does not verify against key "ed25519-a10fab831aa5a2d3" of agent@stratuslabs.localhost |

## The tampered envelope

Signature and delegation token shortened for display.

```json
{
  "adtp": "0",
  "id": "msg_01M824FXE80NJEZH4JH7SK7466",
  "thread": "thr_01M824FXE8AHSVW2BHXJARBN5S",
  "from": "agent@stratuslabs.localhost",
  "on_behalf_of": "dylan@stratuslabs.localhost",
  "to": [
    "echo@demo.adtp.localhost"
  ],
  "intent": "request",
  "priority": "normal",
  "created_at": "2026-11-22T17:22:34Z",
  "expires_at": "2026-11-22T18:22:34Z",
  "requires_approval": false,
  "content": {
    "parts": [
      {
        "type": "text",
        "text": "Iello from Stratus Labs. This is the first ADTP message. Please confirm receipt."
      },
      {
        "type": "data",
        "data": {
          "type": "demo.ping",
          "sent_at": "2026-11-22T17:22:34.564Z"
        }
      }
    ]
  },
  "delegation": "eyJhbGciOiJFZERT…0TD6JmBA",
  "signature": {
    "alg": "Ed25519",
    "kid": "ed25519-a10fab831aa5a2d3",
    "value": "pUXqXMFKqc9l3Ai_…htPYtHAA"
  }
}
```
