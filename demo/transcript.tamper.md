# ADTP v0 demo: a tampered message is rejected

`agent@stratuslabs.localhost` → `echo@demo.adtp.localhost`

**Result:** ✅ Side B refused the tampered envelope: the signature no longer matches

## Timeline

| Time (UTC) | Elapsed | Side | Step | What happened |
|---|---|---|---|---|
| 05:09:52.881 | +0.006s | stratus | discover | local mode: discovery override for demo.adtp.localhost (no DNS lookup) |
| 05:09:52.881 | +0.006s | stratus | card | http://echo-node:7387/.well-known/adtp/echo  →  endpoint http://echo-node:7387/adtp/v0/messages, key ed25519-dc65fc07efdb9693 |
| 05:09:52.889 | +0.014s | stratus | envelope | signed by the node for agent@stratuslabs.localhost (not sent) |
| 05:09:52.890 | +0.015s | stratus | tamper | one byte changed in transit: "Hello…" → "Iello…" (signature untouched) |
| 05:09:52.898 | +0.023s | side-b | rejected | HTTP 401  bad_signature: the envelope signature does not verify against key "ed25519-c897bfac911ca1da" of agent@stratuslabs.localhost |

## The tampered envelope

Signature and delegation token shortened for display.

```json
{
  "adtp": "0",
  "id": "msg_01M7Y85K3PKCGFPDDB4V2VMD5R",
  "thread": "thr_01M7Y85K3PV9QGN82BSWRECNQD",
  "from": "agent@stratuslabs.localhost",
  "on_behalf_of": "dylan@stratuslabs.localhost",
  "to": [
    "echo@demo.adtp.localhost"
  ],
  "intent": "request",
  "priority": "normal",
  "created_at": "2026-11-21T05:09:52Z",
  "expires_at": "2026-11-21T06:09:52Z",
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
          "sent_at": "2026-11-21T05:09:52.882Z"
        }
      }
    ]
  },
  "delegation": "eyJhbGciOiJFZERT…CfMlYsAw",
  "signature": {
    "alg": "Ed25519",
    "kid": "ed25519-c897bfac911ca1da",
    "value": "pHUT6lEqokHrOaXi…kTEGVaBg"
  }
}
```
