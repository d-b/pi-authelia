# pi-authelia

`/login authelia` on a headless box: prints a URL + short code, you approve in any browser with
password + TOTP, the CLI finishes by itself. No paste, no port-forward, no callback listener —
which is what makes it work over ssh. RFC 8628 device grant against Authelia
(`https://auth.bloemendal.me`), client `pi-cli`; the resulting id_token is presented as the
bearer to `https://llm.bloemendal.me`, where HAProxy's oauth2-proxy validates it.

## Install

```bash
pi-bolt install npm:@d-b/pi-authelia               # public npm
pi-bolt install git:github.com/d-b/pi-authelia     # needs git read access to the repo on that box
pi-bolt install ./pi-authelia                      # local path, no copying
```

Pin with a version on the npm source (`npm:@d-b/pi-authelia@1.2.0`) when you want a client that pi
will not silently move: pi treats an exact-version spec as pinned and skips the update check. The git
source behaves the same way only if you name a ref — `git:github.com/d-b/pi-authelia@v1.2.0` — because
untagged it is reset to whatever `master` holds on every reconcile. Tags start at `v1.0.0`; `v1.0.0`
and `v1.1.0` name the commits whose four shipped files match the corresponding npm tarballs byte for
byte, and `v1.2.0` names the release state of this version.

Then `pi-bolt auth check --provider authelia` should report `ready` after a `/login authelia`, and
`pi-bolt list` shows the declaration that went into `~/.pi/agent/settings.json`.

**If a hand-copied copy exists, delete it first** — `~/.pi/agent/extensions/authelia-device-auth.ts`
is a loose extension and Pi will register the provider twice (the package identity rules do not
cover manually copied files):

```bash
rm -f ~/.pi/agent/extensions/authelia-device-auth.ts
```

Do **not** install on `llm.lan`: it would route that pi through the public URL and the SSO in
front of it. The gateway-side half lives in the gateway repo (`AUTH.md`, `oauth2-proxy/config.cfg`).

## Renamed from `Bifrost`

The default provider id is now **`authelia`** — lowercase like pi's own built-in ids (`openai`,
`github-copilot`, `google-vertex`), with `Authelia` passed separately as the display name. A provider
id is an exact, case-sensitive key, so a machine that used the previous default needs two one-time
steps:

1. **Rename the `models.json` entry** — `providers."Bifrost"` → `providers."authelia"` in
   `~/.pi/agent/models.json`. This one is not optional: the model catalog comes from that entry, so
   without it the provider registers with no models and nothing is selectable.
2. **`/login authelia` again** — the `auth.json` entry is keyed `Bifrost` and is not read, so neither
   the credential nor a stored gateway key carries over. `settings.json`'s `defaultProvider` also
   still says `Bifrost`; pick a model once and it is rewritten.

Nothing is migrated in code, because the old name would have to be resolved separately in
`models.json`, `auth.json` and `settings.json`. To keep the old name instead, set
`GATEWAY_PROVIDER_NAME=Bifrost` — everything else in this README then reads `Bifrost` where it says
`authelia`.

## Optional: an upstream gateway key

After Authelia validates a request the gateway substitutes its own shared key, so every public `pi`
session is billed and logged under one identity (`edge@llm.bloemendal.me` here). Answer the prompt at
the end of `/login` to attribute your traffic to a key of its own:

    Upstream gateway API key (optional, for per-machine usage and limits). Press enter to skip.

The value is stored as **`key`** in that provider's `auth.json` entry, so `/logout authelia`
clears it along with the credential and there is no separate secrets file to keep track of. Press
enter and nothing changes from the previous behaviour — the header is omitted rather than sent empty.

Resolution order, first match wins:

1. `$GATEWAY_KEY_ENV` (default `GATEWAY_API_KEY`) — headless and CI runs
2. `key` on the credential in use
3. `key` in `auth.json` for the configured provider

(`gatewayKey`, the name development builds briefly wrote, is still read in both places, so such a
machine keeps working without re-logging-in; if both names exist, `key` wins.)

Nothing here is tied to one product, so all of it is overridable:

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTHELIA_ISSUER` | `https://auth.bloemendal.me` | OIDC issuer to discover |
| `AUTHELIA_CLIENT_ID` | `pi-cli` | public client id |
| `AUTHELIA_SCOPE` | `openid profile email groups offline_access` | requested scopes |
| `GATEWAY_PROVIDER_NAME` | `authelia` | pi provider id this extension registers (exact key in `models.json`/`auth.json`) |
| `GATEWAY_PROVIDER_LABEL` | `Authelia` | display name for that provider in pi's UI |
| `GATEWAY_BASE_URL` | `https://llm.bloemendal.me/v1` | gateway endpoint |
| `GATEWAY_KEY_HEADER` | `x-api-key` | header the upstream reads its own key from |
| `GATEWAY_KEY_ENV` | `GATEWAY_API_KEY` | variable that overrides the stored key |

The key travels in **`x-api-key`**, never `Authorization`: there is only one `Authorization` header
and on the public path it belongs to Authelia, which 401s anything else presented in it. `x-api-key`
is a convention rather than a vendor feature — Anthropic's API uses it natively, and the gateway
tested here accepts `x-api-key`, `X-API-Key` and `api-key` while rejecting a branded key header.
Measured on the deployed gateway (v2.6.0): when both headers are present **`x-api-key` wins**, so
the key decides which identity owns the traffic while the gate decides whether the request is
allowed at all.

One timing note: a provider's `headers` are resolved once, when the extension registers at startup,
so a key answered during `/login` starts being sent on the next start or `/reload` — the progress
line says exactly that.

Self-declared, so it is attribution and not a control: any client that passes Authelia can name any
key. With one operator that is a labelling convenience; to make it a control, pin
`X-Auth-Request-User` to a key in HAProxy and delete inbound `x-api-key` first.

## Prerequisites (server side, in rollout order)

1. Authelia ≥ 4.39.20 (verified on 4.39.28) with the `pi-cli` client: public client,
   `token_endpoint_auth_method: none`, grants `device_code` + `refresh_token`,
   `authorization_policy: two_factor`, lifespan profile `cli`.
2. The gateway serving `llm.bloemendal.me` with the bearer path (`/v1` → JSON 401 rather than a
   redirect to the portal).

## Notes on the three non-obvious parts

- **`access` holds the `id_token`, not the `access_token`.** Authelia's device-flow
  access_token is opaque (default `access_token_signed_response_alg: none`), so only the
  RS256 id_token is verifiable by the gateway. Verified on a real 4.39.28 instance.
- **Refresh rotates.** Every refresh returns a new refresh_token; returning only the access
  token would silently kill the session after the first hour. Handled in `refreshToken`.
- **Refresh also has to re-attach the gateway key.** `toCredentials` builds a fresh object from the
  token response, so a stored `key` would vanish on the first refresh and traffic would
  quietly revert to the shared key — no error, no log. It is carried over explicitly (promoting the
  legacy `gatewayKey` name to `key`), and a test covers it.

Tokens go only to `~/.pi/agent/auth.json` (pi's own store) — never to logs, including on the
error paths, which quote Authelia's `error`/`error_description` only.
