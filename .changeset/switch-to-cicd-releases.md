---
"@borrowbetter/arpcsdk": patch
---

Move releases to CI/CD: Changesets + GitHub Actions (`ci.yml`, `release.yml`) replace the manual `publish.sh` script. Publishing to npm now happens automatically on merge to `main` via OIDC trusted publishing.
