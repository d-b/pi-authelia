# Changelog

Version headings follow Pi's package-changelog convention (`## <version>`), so Pi can show what
changed after `pi update --extensions`.

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
