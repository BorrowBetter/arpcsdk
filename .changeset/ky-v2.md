---
"@borrowbetter/arpcsdk": minor
---

Upgrade ky to 2.x

**Breaking: requires Node.js >= 22.12** (was >= 18). ky 2 is ESM-only and needs Node 22; the CJS build `require()`s it, which only works unflagged from 22.12. No API changes.
