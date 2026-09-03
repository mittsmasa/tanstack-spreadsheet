#!/usr/bin/env sh
# Writes .dev.vars for the Cloudflare Vite plugin from the secrets fnox holds.
# .dev.vars is gitignored and only readable by the owner.
set -eu

cd "$(dirname "$0")/.."

vars=$(fnox exec -- env | grep -E '^(BETTER_AUTH_SECRET|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET)=')

umask 077
{
  printf '%s\n' "$vars"
  printf 'BETTER_AUTH_URL=http://localhost:3210\n'
} > .dev.vars
chmod 600 .dev.vars
