# pi-authelia-device

`/login Bifrost` on a headless box: prints a URL + short code, you approve in any browser with
password + TOTP, the CLI finishes by itself. No paste, no port-forward, no callback listener —
which is what makes it work over ssh. RFC 8628 device grant against Authelia
(`https://auth.bloemendal.me`), client `pi-cli`; the resulting id_token is presented as the
bearer to `https://llm.bloemendal.me`, where HAProxy's oauth2-proxy validates it.

## Install (client machines only)

    scp index.ts rokan:~/.pi/agent/extensions/authelia-device-auth.ts
    ssh rokan pi            # then /login Bifrost

Do **not** install on `llm.lan`: it would route that pi through the public URL and the SSO in
front of it. The gateway-side half lives in the gateway repo (`AUTH.md`, `oauth2-proxy/config.cfg`).

## Prerequisites (server side, in rollout order)

1. Authelia ≥ 4.39.20 with the `pi-cli` client (device_code + refresh_token, public,
   `authorization_policy: two_factor`, lifespan profile `cli`).
2. The gateway serving `llm.bloemendal.me` with the bearer path (`/v1`, `/jev` → JSON 401).

## Notes on the two non-obvious parts

- **`access` holds the `id_token`, not the `access_token`.** Authelia's device-flow
  access_token is opaque (default `access_token_signed_response_alg: none`), so only the
  RS256 id_token is verifiable by the gateway. Verified on a real 4.39.28 instance.
- **Refresh rotates.** Every refresh returns a new refresh_token; returning only the access
  token would silently kill the session after the first hour. Handled in `refreshToken`.

Tokens go only to `~/.pi/agent/auth.json` (pi's own store) — never to logs, including on the
error paths, which quote Authelia's `error`/`error_description` only.
