#!/usr/bin/env bash
# Preflight checks before publishing pi-md-reader to npm.
#
# Verifies everything that can be verified without npm credentials, so the publish
# itself is a single command that cannot fail on a packaging mistake.
#
#   test/preflight.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
fail=0

ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; }
warn() { printf '  \033[33mwarn\033[0m %s\n' "$1"; }

echo "manifest"
name=$(node -p "require('./package.json').name")
version=$(node -p "require('./package.json').version")
echo "  $name@$version"

if node test/check-manifest.mjs; then ok "package.json satisfies the Pi package contract"; else bad "package.json contract"; fi

echo "entry point"
# The runtime import specifiers must be limited to node built-ins plus the two host packages:
# anything else would need a real dependency, which Pi warns about.
if grep -nE '^import .* from "(?!node:|@earendil-works/pi-coding-agent|@earendil-works/pi-tui)[^"]+"' \
    -P extensions/md-reader.ts >/dev/null 2>&1; then
  bad "extension imports a package that is not a host-provided peer"
else
  ok "extension imports only node built-ins and host-provided peers"
fi

echo "tarball"
files=$(npm pack --dry-run --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j[0].files.map(f=>f.path).join("\n"))})')
for required in extensions/md-reader.ts package.json README.md LICENSE; do
  if grep -qx "$required" <<<"$files"; then ok "$required included"
  else bad "$required missing from the tarball"; fi
done
if grep -qE '^(test/|test$)' <<<"$files"; then bad "test files leaked into the tarball"; else ok "test files excluded"; fi

echo "registry"
# A version that is already published is only a problem when the intent is to publish.
# Report it as information, and keep the hard failure for a version mismatch that would
# silently no-op a release.
if curl -sf "https://registry.npmjs.org/$name" >/dev/null; then
  published=$(curl -s "https://registry.npmjs.org/$name" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)["dist-tags"].latest))')
  if [ "$published" = "$version" ]; then
    warn "$name@$version is already published; bump the version before releasing again"
  else
    ok "$name is on npm at $published; $version will be a new release"
  fi
else
  ok "$name is free on npm; $version will be the first release"
fi

echo "npm auth"
# Publishing requires 2FA on the account OR a granular token with bypass-2FA enabled.
# Both facts are discoverable, so report them here instead of letting npm answer with a
# bare 403 after the upload has already been prepared.
who=$(npm whoami 2>/dev/null || true)
if [ -z "$who" ]; then
  bad "not logged in to npm; run: npm login"
else
  ok "authenticated as $who"
  twofa=$(npm profile get 2>/dev/null | sed -nE 's/^two-factor auth:[[:space:]]*//p' | head -1)
  if [ "$twofa" = "disabled" ]; then
    warn "account 2FA is disabled, so npm will refuse an interactive publish"
    echo "       fix, either:"
    echo "         a) enable 2FA at https://www.npmjs.com/settings/$who/profile"
    echo "            then re-run this script and publish interactively"
    echo "         b) create a granular access token with \"bypass 2FA\" enabled at"
    echo "            https://www.npmjs.com/settings/$who/tokens and install it:"
    echo "              npm config set //registry.npmjs.org/:_authToken <token>"
    echo "       see: https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/"
  else
    ok "account 2FA is $twofa"
  fi
fi

echo "trusted publishing"
# `npm trust` silently misbehaves on npm < 11.15.0: it never sends the `permissions` array the
# registry now requires, so it fails with a bare 400 right after the 2FA prompt succeeds.
# Check the version here rather than discovering it a second time.
npm_version=$(npm --version)
if node -e 'const [a,b]=process.argv[1].split(".").map(Number); process.exit(a>11 || (a===11 && b>=15) ? 0 : 1)' "$npm_version"; then
  ok "npm $npm_version can create trust relationships"
else
  bad "npm $npm_version cannot create a trust relationship (needs >= 11.15.0)"
  echo "       npm < 11.15.0 omits the permissions array the registry requires and fails"
  echo "       with a bare 400 right after the 2FA prompt succeeds."
  echo "       use a newer npm, e.g.: npm install -g npm@^11.15.0"
fi

echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32mall preflight checks passed\033[0m\n\n'
  echo "release with:"
  echo "  npm version patch && git push --follow-tags   # CI publishes on the v* tag"
  echo
  echo "or manually, for a first release:"
  echo "  npm publish --access public"
else
  printf '\033[31mpreflight failed\033[0m\n'
fi
exit "$fail"
