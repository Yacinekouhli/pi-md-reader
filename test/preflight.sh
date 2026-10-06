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
if curl -sf "https://registry.npmjs.org/$name" >/dev/null; then
  published=$(curl -s "https://registry.npmjs.org/$name" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)["dist-tags"].latest))')
  if [ "$published" = "$version" ]; then
    bad "$name@$version is already published; bump the version"
  else
    warn "$name exists on npm at $published; publishing $version will add a new version"
  fi
else
  ok "$name is free on npm"
fi

echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32mall preflight checks passed\033[0m\n\n'
  echo "publish with:"
  echo "  npm login          # once, if not already authenticated"
  echo "  npm publish --access public"
  echo
  echo "then verify:"
  echo "  pi install npm:$name"
else
  printf '\033[31mpreflight failed\033[0m\n'
fi
exit "$fail"
