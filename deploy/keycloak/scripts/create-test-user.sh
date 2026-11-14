#!/usr/bin/env bash
# Creates a local test user in the ghatana-media realm with a RANDOM password generated at runtime.
#
# The password is never printed and never written to a log: it is written only to the credentials file
# given by --credentials-file (created with mode 0600). Nothing here is committed; keep that file untracked.
#
# Usage:
#   KEYCLOAK_ADMIN_PASSWORD=... create-test-user.sh \
#       --username reviewer1 --tenant tenant-a --roles media-dev-workspace,media-operator \
#       --credentials-file ./.local/reviewer1.credentials
#
# Environment: KEYCLOAK_URL (default http://127.0.0.1:8180), KEYCLOAK_ADMIN_USERNAME (default media-admin),
# KEYCLOAK_ADMIN_PASSWORD (required), KEYCLOAK_REALM (default ghatana-media).
set -euo pipefail

username="" tenant="" roles="" credentials_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --username) username="$2"; shift 2 ;;
    --tenant) tenant="$2"; shift 2 ;;
    --roles) roles="$2"; shift 2 ;;
    --credentials-file) credentials_file="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$username" && -n "$tenant" && -n "$credentials_file" ]] || { echo "--username, --tenant and --credentials-file are required" >&2; exit 2; }
[[ -n "${KEYCLOAK_ADMIN_PASSWORD:-}" ]] || { echo "KEYCLOAK_ADMIN_PASSWORD must be set" >&2; exit 2; }
for tool in curl openssl python3; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }
done

base="${KEYCLOAK_URL:-http://127.0.0.1:8180}"
realm="${KEYCLOAK_REALM:-ghatana-media}"
admin="${KEYCLOAK_ADMIN_USERNAME:-media-admin}"

umask 077
mkdir -p "$(dirname "$credentials_file")"
[[ ! -e "$credentials_file" ]] || { echo "refusing to overwrite $credentials_file" >&2; exit 1; }

# Admin token: the admin password reaches curl through a stdin config so it never appears in argv or logs.
token="$(printf 'data-urlencode = "client_id=admin-cli"\ndata-urlencode = "grant_type=password"\ndata-urlencode = "username=%s"\ndata-urlencode = "password=%s"\n' \
  "$admin" "$KEYCLOAK_ADMIN_PASSWORD" \
  | curl -sS --fail -K - "$base/realms/master/protocol/openid-connect/token" \
  | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')"

password="$(openssl rand -base64 33 | tr -d '\n')"

payload="$(USERNAME="$username" TENANT="$tenant" python3 -I -c '
import json, os
print(json.dumps({"username": os.environ["USERNAME"], "enabled": True, "emailVerified": False,
                  "attributes": {"tenant_id": [os.environ["TENANT"]]}}))')"
curl -sS --fail -o /dev/null -X POST "$base/admin/realms/$realm/users" \
  -H "Authorization: Bearer $token" -H "Content-Type: application/json" --data "$payload"

user_id="$(curl -sS --fail -G "$base/admin/realms/$realm/users" -H "Authorization: Bearer $token" \
  --data-urlencode "username=$username" --data-urlencode "exact=true" \
  | python3 -I -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')"

PW="$password" python3 -I -c 'import json,os; print(json.dumps({"type":"password","value":os.environ["PW"],"temporary":False}))' \
  | curl -sS --fail -o /dev/null -X PUT "$base/admin/realms/$realm/users/$user_id/reset-password" \
      -H "Authorization: Bearer $token" -H "Content-Type: application/json" --data @-

if [[ -n "$roles" ]]; then
  IFS=',' read -r -a role_names <<<"$roles"
  mapping="["
  for name in "${role_names[@]}"; do
    role_json="$(curl -sS --fail "$base/admin/realms/$realm/roles/$name" -H "Authorization: Bearer $token")"
    mapping+="$role_json,"
  done
  mapping="${mapping%,}]"
  printf '%s' "$mapping" | curl -sS --fail -o /dev/null -X POST \
    "$base/admin/realms/$realm/users/$user_id/role-mappings/realm" \
    -H "Authorization: Bearer $token" -H "Content-Type: application/json" --data @-
fi

printf 'username=%s\npassword=%s\ntenant=%s\n' "$username" "$password" "$tenant" > "$credentials_file"
chmod 600 "$credentials_file"
echo "Created user '$username' (tenant '$tenant'). Credentials were written to $credentials_file (mode 0600); they were not printed."
