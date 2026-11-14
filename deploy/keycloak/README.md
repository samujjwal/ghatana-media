# Local Keycloak for Media (self-hosted OIDC)

Owner decision, recorded verbatim (user, 2026-11-14): "Self-hosted Keycloak (Recommended): An open-source
(Apache-2.0) login server running in Docker. I wire Media to verify its tokens over the standard OIDC protocol and
test the whole flow locally. Swapping in another OIDC provider later only changes configuration."

This directory runs Keycloak **for local development and tests only** (embedded H2, HTTP on loopback). It is not a
production topology. Media itself contains no Keycloak-specific code: it verifies standard OIDC JWT access tokens (see
`docs/surfaces/launcher/README.md`, "Trusted identity via OIDC").

## Contents

- `docker-compose.yml`: `quay.io/keycloak/keycloak:26.8.2` (exact tag), `start-dev --import-realm`, published on
  `127.0.0.1:8180` only. The admin password is required from your shell and is never defaulted or committed.
- `realm/ghatana-media-realm.json`: realm `ghatana-media`.
  - **No users and no passwords.** Self-registration is off; brute-force protection is on; access tokens live 5 minutes.
  - Realm roles named exactly like the Media permission strings (`media:job:read`, `media:artifact:create`, ...) plus the
    `media:project:dev:*` and `media:delivery:dev:*` DEV_ONLY route permissions. Composite roles: `media-operator` (all
    canonical permissions) and `media-dev-workspace` (DEV_ONLY project/review/delivery routes plus artifact and job
    permissions). Roles reach Media through `realm_access.roles`.
  - Client `ghatana-media-explorer`: public, authorization code with PKCE `S256` required, no direct-access grants, no
    client secret, redirect URIs for the Explorer at `127.0.0.1:4178`/`localhost:4178`. Its protocol mappers add the
    audience `ghatana-media` and the `tenant_id` claim (from the admin-managed `tenant_id` user attribute).
  - A user-profile definition makes `tenant_id` an administrator-only attribute, so users cannot choose their tenant.
- `scripts/create-test-user.sh`: creates a test user with a **random password generated at runtime**. The password is
  written only to the credentials file you name (mode `0600`) and is never printed or logged.

## Run it

```bash
export KEYCLOAK_ADMIN_PASSWORD="$(openssl rand -base64 24)"   # keep in your shell; do not commit
docker compose -f deploy/keycloak/docker-compose.yml up -d
# wait for http://127.0.0.1:8180/realms/ghatana-media/.well-known/openid-configuration

deploy/keycloak/scripts/create-test-user.sh --username reviewer1 --tenant tenant-a \
    --roles media-dev-workspace --credentials-file deploy/keycloak/.local/reviewer1.credentials
```

`deploy/keycloak/.local/` and `*.credentials` are git-ignored.

Run the launcher against it (profile `dev` accepts both the DEV_ONLY token and OIDC; production-like profiles accept
only OIDC):

```bash
export MEDIA_OIDC_ISSUER=http://127.0.0.1:8180/realms/ghatana-media
export MEDIA_OIDC_AUDIENCE=ghatana-media
```

Explorer sign-in (authorization code + PKCE, only shown when configured):

```bash
VITE_MEDIA_OIDC_ISSUER=http://127.0.0.1:8180/realms/ghatana-media \
VITE_MEDIA_OIDC_CLIENT_ID=ghatana-media-explorer pnpm --filter @ghatana/media-experience-explorer dev
```

Then open `/dev-project-timeline.html` and choose "Sign in with identity provider (OIDC)". The explorer adds exactly the
issuer's origin to its `connect-src` CSP when both variables are set. The pasted DEV_ONLY token path keeps working.

Important: the issuer is derived from the host name used to reach Keycloak. Use `127.0.0.1` consistently (browser,
`MEDIA_OIDC_ISSUER`, token requests); `localhost` would be a different issuer string.

## Tests

`MediaOidcKeycloakIT` (launcher test source set, Docker required, skipped without Docker) starts this exact image with
this realm, creates users and a direct-grant test client through the admin API with runtime-random passwords, obtains a
real access token, calls launcher routes, and checks that forged, foreign-realm, tampered and `alg=none` tokens are
refused. Run: `./gradlew :services:media:launcher:test --tests '*MediaOidcKeycloakIT'`.

## Changing provider or version

- Another OIDC provider: only the `MEDIA_OIDC_*` configuration changes (claim paths if its layout differs).
- Keycloak upgrade: change the tag here and in `MediaOidcKeycloakIT`, re-run the IT, and review the release notes; do
  not use `latest`.
- Production: this development-mode compose file is not a deployment recipe. Use an HTTPS issuer, your own realm
  provisioning, real user lifecycle and secrets management.
