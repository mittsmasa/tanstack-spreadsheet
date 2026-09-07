#!/usr/bin/env sh
# Writes .dev.vars for the Cloudflare Vite plugin.
# .dev.vars is gitignored and only readable by the owner.
#
# By default Google sign-in goes through the local OAuth emulator that the dev
# server hosts at /emulate/google (scripts/google-oauth-emulator.ts), so the only
# secret fnox has to hold is BETTER_AUTH_SECRET; the Google client values are
# placeholders the emulator does not check. Run with GOOGLE_OAUTH_EMULATOR=0 to
# use the real Google credentials from fnox instead.
set -eu

cd "$(dirname "$0")/.."

if [ "${GOOGLE_OAUTH_EMULATOR:-1}" = "0" ]; then
  vars=$(fnox exec -- env | grep -E '^(BETTER_AUTH_SECRET|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET)=')
else
  vars=$(fnox exec -- env | grep -E '^BETTER_AUTH_SECRET=')
  vars="$vars
GOOGLE_CLIENT_ID=emulate-client
GOOGLE_CLIENT_SECRET=emulate-secret
GOOGLE_OAUTH_EMULATOR_URL=http://localhost:3210/emulate/google"
fi

umask 077
{
  printf '%s\n' "$vars"
  printf 'BETTER_AUTH_URL=http://localhost:3210\n'
} > .dev.vars
chmod 600 .dev.vars
