# pi-authelia

`/login Bifrost` on a headless box: prints a URL + short code, you approve in any browser with
password + TOTP, the CLI finishes by itself. No paste, no port-forward, no callback listener —
which is what makes it work over ssh. RFC 8628 device grant against Authelia
(`https://auth.bloemendal.me`), client `pi-cli`; the resulting id_token is presented as the
bearer to `https://llm.bloemendal.me`, where HAProxy's oauth2-proxy validates it.

## Install

```bash
pi-bolt install npm:@d-b/pi-authelia        # once published (public npm)
pi-bolt install git:github.com/d-b/pi-authelia@v1.0.0   # needs git read access to the repo on that box
pi-bolt install ./pi-authelia               # local path, no copying
```

Then `pi-bolt auth check --provider Bifrost` should report `ready` after a `/login Bifrost`, and
`pi-bolt list` shows the declaration that went into `~/.pi/agent/settings.json`.

**If a hand-copied copy exists, delete it first** — `~/.pi/agent/extensions/authelia-device-auth.ts`
is a loose extension and Pi will register the provider twice (the package identity rules do not
cover manually copied files):

```bash
rm -f ~/.pi/agent/extensions/authelia-device-auth.ts
```

Do **not** install on `llm.lan`: it would route that pi through the public URL and the SSO in
front of it. The gateway-side half lives in the gateway repo (`AUTH.md`, `oauth2-proxy/config.cfg`).

## Optional: a per-machine Bifrost virtual key

The gateway substitutes its own shared Bifrost key after Authelia validates a request, which means
every public `pi` session is billed and logged as `edge@llm.bloemendal.me`. To get per-machine
attribution while keeping the SSO gate, give the extension a virtual key:

```bash
printf '%s\n' sk-bf-... > ~/.pi/agent/bifrost_key && chmod 600 ~/.pi/agent/bifrost_key
# or
export BIFROST_API_KEY=sk-bf-...
```

`BIFROST_API_KEY` wins over the file, and when neither is set no header is sent at all (rather than
an empty one, which Bifrost correctly rejects).

It travels in **`x-api-key`**, never `Authorization`: there is only one `Authorization` header and
on the public path it belongs to Authelia, which will 401 a Bifrost key presented in it. Measured
against Bifrost v2.6.0 — `x-api-key` takes precedence when both are present, so the VK decides
which key owns the traffic while the gate still decides whether the request is allowed at all.

Self-declared, so it is attribution and not a control: any client that passes Authelia can name any
key. With one operator that is a labelling convenience; to make it a control, pin
`X-Auth-Request-User` to a key in HAProxy and delete inbound `x-api-key` first.

## Prerequisites (server side, in rollout order)

1. Authelia ≥ 4.39.20 (verified on 4.39.28) with the `pi-cli` client: public client,
   `token_endpoint_auth_method: none`, grants `device_code` + `refresh_token`,
   `authorization_policy: two_factor`, lifespan profile `cli`.
2. The gateway serving `llm.bloemendal.me` with the bearer path (`/v1` → JSON 401 rather than a
   redirect to the portal).

## Notes on the two non-obvious parts

- **`access` holds the `id_token`, not the `access_token`.** Authelia's device-flow
  access_token is opaque (default `access_token_signed_response_alg: none`), so only the
  RS256 id_token is verifiable by the gateway. Verified on a real 4.39.28 instance.
- **Refresh rotates.** Every refresh returns a new refresh_token; returning only the access
  token would silently kill the session after the first hour. Handled in `refreshToken`.

Tokens go only to `~/.pi/agent/auth.json` (pi's own store) — never to logs, including on the
error paths, which quote Authelia's `error`/`error_description` only.
