# Security

ADTP is at version 0. The specification and this node are young, and neither
has had an independent security review.

## Reporting a problem

Please report a vulnerability privately, not in a public issue: on this
repository's **Security** tab, choose **Report a vulnerability**. That opens a
report only the maintainers can see.

A useful report says what an attacker can do, and how to reproduce it: the
request or envelope, the node's configuration, and what happened.

## What is in scope

- The protocol as written in [SPEC.md](SPEC.md): signatures, delegation,
  discovery, replay and duplicate handling.
- The node in this repository: the public endpoints (`/adtp/v0/messages`,
  `/.well-known/adtp`), the local API and the admin pages.

## Known limits

These are stated in [SPEC.md](SPEC.md) (sections 12 and 13) and are not news:

- Message contents are not encrypted beyond HTTPS. The two nodes can read them.
- Trust in a sender's keys rests on DNS and HTTPS for the sender's domain.
- Revoking a delegation reaches only the node that issued it.
