#!/usr/bin/env bash
# Runs a command with the settings from fnox.toml in its environment.
#
# The values there are age-encrypted; the age private key is the one secret kept
# outside the repo, in the OS keychain. fnox does not resolve FNOX_AGE_KEY from
# its own secrets (that would be circular), so the key is fetched here and put in
# the environment before fnox runs.
set -euo pipefail

if ! FNOX_AGE_KEY=$(security find-generic-password -s fnox -a FNOX_AGE_KEY -w 2>/dev/null); then
  echo "age の秘密鍵が keychain にありません。README の認証セットアップを参照してください。" >&2
  echo "  security add-generic-password -s fnox -a FNOX_AGE_KEY -w '<AGE-SECRET-KEY-...>' -U" >&2
  exit 1
fi
export FNOX_AGE_KEY

exec fnox exec -- "$@"
