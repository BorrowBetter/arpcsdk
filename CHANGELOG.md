# @borrowbetter/arpcsdk

## 0.1.1

### Patch Changes

- [`94c1d4e`](https://github.com/BorrowBetter/arpcsdk/commit/94c1d4e5f8d9d1bdeb45301b90cfb5a9636b8a73) Thanks [@rkingon](https://github.com/rkingon)! - Move releases to CI/CD: Changesets + GitHub Actions (`ci.yml`, `release.yml`) replace the manual `publish.sh` script. Publishing to npm now happens automatically on merge to `main` via OIDC trusted publishing.

## 0.1.0

### Minor Changes

- Initial release. Typed, agnostic client for FDR's ARPC DEX API (Achieve
  Resolution Partner Connect, Digital Enrollment Experience): OAuth token
  lifecycle, two-host routing, bearer injection, and the full endpoint surface
  as typed `sdk.api.*` operations generated from spec v2026.15.0.
