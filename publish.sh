#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./publish.sh <otp>          # patch bump (0.1.0 → 0.1.1)
#   ./publish.sh <otp> minor    # minor bump (0.1.0 → 0.2.0)
#   ./publish.sh <otp> major    # major bump (0.1.0 → 1.0.0)

OTP=${1:?Usage: ./publish.sh <npm-otp> [patch|minor|major]}
BUMP=${2:-patch}

# Validate bump type
if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Error: bump must be patch, minor, or major (got: $BUMP)"
  exit 1
fi

# Ensure working tree is clean
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is dirty — commit or stash changes first"
  exit 1
fi

# Ensure on main
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: must be on main branch (currently on: $BRANCH)"
  exit 1
fi

# Ensure logged into npm (pnpm publishes to the npm registry)
if ! pnpm whoami &>/dev/null; then
  echo "Error: not logged into npm — run 'pnpm login' first"
  exit 1
fi

# Pull latest
git pull --ff-only

# Typecheck
echo "→ Typechecking..."
pnpm typecheck

# Build
echo "→ Building..."
pnpm build

# Bump version in package.json (no git tag yet)
echo "→ Bumping $BUMP version..."
pnpm version "$BUMP" --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")

# Commit version bump
git add package.json pnpm-lock.yaml
git commit -m "v$VERSION"

# Tag
git tag "v$VERSION"

# Push commit + tag
git push origin main
git push origin "v$VERSION"

# Publish to npm (own git checks already done above)
pnpm publish --access public --otp="$OTP" --no-git-checks

echo ""
echo "✓ Published @borrowbetter/arpcsdk@$VERSION"
