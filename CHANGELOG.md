# Changelog

Version headings follow Pi's package-changelog convention (`## <version>`), so Pi can show what
changed after `pi update --extensions`.

## 1.1.0 - 2026-11-23

### The key is now asked for during `/login`

`/login <provider>` now ends with an optional prompt for the upstream key, stored as **`key`** inside
the provider's own `auth.json` entry beside `access`/`refresh`/`expires`. That means
`/logout <provider>` clears it with the credential, there is no second secrets file, and nothing has
to be exported in shell config on a headless box. Precedence is `$GATEWAY_KEY_ENV` -> the credential
-> `auth.json`.

`key` is also pi's field name for `api_key` credentials, so that overlap was tested rather than
assumed: with an `oauth` credential carrying `key`, pi 1.6.0 still authenticates with `access` as the
bearer and sends the key only in the configured header. Confirmed by pointing pi at a local stub
gateway that records the headers it receives, not by reading pi's source -- which would have been
stale anyway, since the build changed mid-development.

The field briefly existed as `gatewayKey` during development. That spelling is still **read**, so a
machine that logged in from an unreleased build keeps working without re-authenticating; `key` wins
if both are present, writes always use `key`, and refresh promotes a legacy value while it rotates
the token.

### The vocabulary is gateway-neutral

Everything deployment-specific moved into env-overridable config, so the same file serves a different
realm, gateway, pi provider name or key header: `AUTHELIA_ISSUER`, `AUTHELIA_CLIENT_ID`,
`AUTHELIA_SCOPE`, `GATEWAY_PROVIDER_NAME`, `GATEWAY_BASE_URL`, `GATEWAY_KEY_HEADER`,
`GATEWAY_KEY_ENV`. Product-specific wording (`Bifrost virtual key`) became provider-driven copy; the
refresh-failure message interpolates the configured provider instead of telling everyone to run
`/login Bifrost`; and internal identifiers dropped the vendor's own vocabulary
(`VK_FIELD`/`storedVirtualKey` -> `KEY_FIELD`/`storedGatewayKey`). The header itself was never
vendor-specific -- `x-api-key` is a convention, used natively by Anthropic's API.

**Breaking vs 1.0.0**, both intentional:

- `BIFROST_API_KEY` is no longer read directly. The equivalent is `GATEWAY_API_KEY`, or keep the old
  variable name by setting `GATEWAY_KEY_ENV=BIFROST_API_KEY`.
- `~/.pi/agent/bifrost_key` is no longer read. Answer the `/login` prompt instead (the value then
  lives in `auth.json`), or export `GATEWAY_API_KEY`.

Also fixed in this release: 1.0.0 could only take the key from the environment at startup, so a key
supplied later had no effect until the process restarted. A key answered at `/login` is now stored
immediately and picked up on the next start or `/reload`, with the progress line saying so.

## 1.0.0 - 2026-11-23

First packaged release. Previously this was a single `.ts` file copied into
`~/.pi/agent/extensions/`; nothing about the login behaviour changed in the move, only the
delivery: it is now a pi package (`pi-package` keyword, `pi.extensions` manifest, host packages
declared as `peerDependencies` rather than bundled).

- `/login Bifrost` performs Authelia **device authorization** (RFC 8628): prints a URL and a short
  code, you approve with password + TOTP in any browser, the CLI finishes by itself. No callback
  URL to paste, no port to forward, so it works on a headless box reached over ssh.
- The **`id_token` is the bearer credential**, not the `access_token`: Authelia issues an opaque
  access token for this client, so only the RS256-signed id token is verifiable downstream.
- Refresh token is stored and **rotated** on every refresh; `expires` is derived from the id
  token's own `exp` with a 5-minute margin.
- HTTP 429 / `temporarily_unavailable` / `server_error` while polling are treated as retryable
  with exponential backoff (capped at 60s) instead of failing the login, because Authelia's
  default `openid_connect_token` rate limiter can bite a slow approval.
- New: optional **Bifrost virtual key**, read from `BIFROST_API_KEY` or `~/.pi/agent/bifrost_key`
  and sent as `x-api-key`, so per-machine traffic is attributed to its own key instead of the
  gateway's shared edge key. Omitted entirely when unset. See README for why it cannot ride in
  `Authorization`.
