# Naming

ADTP stands for **Async Data Transport Protocol**. This file records how that
name was chosen and which other names were considered, so the question does not
have to be worked through again.

## The name

- **Async**: a node stores what it is given and delivers it later, so the two
  sides do not have to be online at the same time.
- **Data**: an envelope carries structured data, text and links to files, for
  agents and for people.
- **Transport**: in the sense of RTP or MQTT, not of TCP. ADTP is carried over
  HTTPS.
- **The four letters ending in "TP"** are a nod to SMTP, whose delivery model
  ADTP borrows.

The acronym was settled on 20 November 2026 with a different expansion,
"Advanced Data Transfer Protocol". The expansion was changed the next day:
"Advanced" said nothing about the protocol, and "Data Transfer" suggests moving
files in bulk, which ADTP does not do.

Known overlaps, none of them in this field:

- "ADT" is a home-security brand, and the usual abbreviation of "abstract data
  type".
- A personal project has published a small specification under the same
  acronym ("ADTP/2.0").

## What a name had to do

1. Read as a relative of SMTP and IMAP.
2. Cover people as well as agents.
3. Describe a transport layer, not "messaging" in the sense of email.
4. Not already be the name of a protocol or product in the same space.

## Names considered

The existing uses below were found with quick web searches on 20 and 21
November 2026. They were enough to decide against a name. They are not a
trademark search, not every one was double-checked, and "not checked" means
exactly that.

### In the SMTP mold, built on "message"

Dropped as a group once the protocol was described as a transport layer rather
than as messaging.

| Name | Stood for | Why not |
|---|---|---|
| OMTP | Open Message Transfer Protocol | The closest echo of SMTP, and the favourite while "message" was still in the name. The acronym belongs to the Open Mobile Terminal Platform, a mobile-industry forum that closed in 2012. |
| UMTP | Universal Message Transfer Protocol | "Universal" is a claim, where "open" would be a fact. Also the UDP Multicast Tunneling Protocol, an expired IETF draft. |
| AMTP | Agent Message Transfer Protocol | Leaves out people. Existing uses not checked. |
| AMAP | Agent Message Access Protocol | An echo of IMAP. Leaves out people. Existing uses not checked. |
| SMAP | Simple Message Access Protocol | Existing uses not checked. |
| AMP | Agent Message Protocol | Collides with Google's AMP, among others. |

### Built on "exchange"

Two problems run through this group. "Open eXchange" is close to Open-Xchange
("OX"), a company that makes email software. And a name with X, M and P in it
reads like a variant of XMPP, an existing federated messaging protocol.

| Name | Stood for | Why not |
|---|---|---|
| OXMP | Open eXchange Message Protocol | The front-runner for a while, with no existing protocol found. Dropped for both reasons above. |
| AMXP | Agent Message Exchange Protocol | An existing AI-agent service uses the name (amxp.ai), as does a prpl Foundation software library. |
| AXMP | Agent eXchange Message Protocol | An existing Python agent framework is called AXMP. |
| AXTP | Agent eXchange Transfer Protocol | An existing agent protocol is called AXTP (Agent Experience Transfer Protocol). |
| AXP | Agent eXchange Protocol | Liked, but every short domain for it was already registered. |
| OXP | Open eXchange Protocol | OXP is an existing developer-tools protocol (Open eXtension Protocol). |
| MXP | Message eXchange Protocol | Already used under that exact expansion, by a telecom messaging product and by a messaging SDK. |
| MXTP | Message eXchange Transfer Protocol | Already the name of a transport protocol for motion-capture hardware. |
| OMXP | Open Message eXchange Protocol | A fintech company uses the name. |
| AMXT | Agent Message eXchange Transport | Leaves out people. |
| OAXP | Open Agent eXchange Protocol | No existing protocol found. Leaves out people. |
| UMXP | Universal Message eXchange Protocol | No existing protocol found. |
| NXMP | Next eXchange Message Protocol | No existing use found. "Next" dates quickly. |
| UXMP | | An existing music-player project uses the name. |
| OAXT, OMXT, OXTP, OXDP, OXCP, OXNP, OXMS | Open … eXchange … | Variations on "Open eXchange". Existing uses not checked for most. |
| AIXP, AGXP, NXTP | | Set aside early: almost every domain for them was already registered. |

### Built on "data"

| Name | Stood for | Why not |
|---|---|---|
| ODXP | Open Data eXchange Protocol | The runner-up at the end: nothing else was found using the acronym. It gives up the echo of SMTP, and its expansion is one word away from OData, the Open Data Protocol. |
| ODTP | Open Data Transport Protocol | The acronym belongs to the Open Digital Twin Platform, an active open-source project. |
| SDXP | Structured Data eXchange Protocol | Existing uses not checked. No echo of SMTP. |
| UOXP | Universal Object eXchange Protocol | Existing uses not checked. |
| USXP | Universal Structured eXchange Protocol | No existing use found. |
| UDXP | Universal Data eXchange Protocol | Used in research for an Underwater Data eXchange Protocol. |
| SMXP | Structured Message eXchange Protocol | Several existing uses, including another protocol proposed as an alternative to email. |
| UDX | | An existing transport protocol over UDP has the name. |
| UDxT | | No existing use found. Awkward to say. |

### Words instead of letters

A word as a name was considered and set aside in favour of an acronym in the
SMTP mold. Existing uses were not checked for any of these.

- Coined: Oxwire, Oxpost, Oxsend, Letterwire, Postwire, Courio, Missiva,
  Postlayer, Msglayer.
- Real words: Relay, Courier, Envoy, Herald, Missive, Dispatch, Quill, Pigeon,
  Beacon, Kite, Hermes. Every common domain for these was already registered.
