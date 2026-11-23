# Changelog

Version headings follow Pi's package-changelog convention (`## <version>`), so Pi can show what
changed after `pi update --extensions`.

## 1.2.1 - 2026-11-23
### Packaging: the extension moved to `src/index.ts`

`extensions/authelia-device-auth.ts` is now `src/index.ts`, declared explicitly as
`pi.extensions: ["./src/index.ts"]` instead of the `./extensions/*.ts` glob, and `src` replaces
`extensions` in `files`. Behaviour is untouched -- the module is a byte-for-byte rename with no
relative imports, so nothing had to be rewritten.

The reason is pi's startup list. Pi labels a package extension by the directory of its entry when the
entry file is an index, and falls back to the file name otherwise; the rule was read off the build
(`getCompactExtensionLabel` in the compiled binary), not guessed:

| Entry | Listed as |
| --- | --- |
| `extensions/authelia-device-auth.ts` (was) | `@d-b/pi-authelia:authelia-device-auth.ts` |
| `src/index.ts` (now) | `@d-b/pi-authelia:src` |
| `extensions/index.ts` | `@d-b/pi-authelia` |

The third row is why `src/` was chosen over renaming in place: pi strips a leading `extensions/` from
the relative path, so an index there collapses to a bare package name and loses the directory
qualifier the other loaded packages show (`pi-exa:src`, `pi-smart-fetch:dist`).

`pi list`, `pi config` and any per-package resource filter address this extension by its path, so a
declaration that narrowed it (e.g. `"extensions": ["extensions/*.ts"]`) needs `src/index.ts` instead.
None is needed to load it: a plain `"npm:@d-b/pi-authelia"` entry picks the new path up on its own.

## 1.2.0 - 2026-11-23
### The default provider is `authelia`

`GATEWAY_PROVIDER_NAME` now defaults to `authelia` instead of `Bifrost` -- the last product-specific
default in a user-facing path. The id is lowercase because that is pi's own convention: every built-in
provider id is lowercase-hyphenated (`openai`, `anthropic`, `github-copilot`, `google-vertex`,
`amazon-bedrock`), and so is every name in pi's `registerProvider` examples. The capitalised spelling
moved to where pi puts display names, `ProviderConfig.name`, defaulting to `Authelia` and overridable
with the new `GATEWAY_PROVIDER_LABEL`. Checked against the build rather than assumed: the composer
resolves the label as `extension?.name ?? config?.name ?? base?.name ?? …`, so the legacy
registration form does honour it.

**Breaking** on any machine that used the previous default name, because pi matches provider ids
exactly -- `pi-ai` looks a provider up with `providers.get(id)` and both `models.json` and
`auth.json` are keyed by the literal id; only typed `provider/model` references go through the
case-insensitive resolver:

- The `models.json` provider entry must be renamed to `authelia`, or the provider registers with an
  empty catalog and no model is selectable. This is the one step with no workaround.
- The `auth.json` entry is not read under the new name, so `/login authelia` is needed once, and a
  stored gateway key goes with the old entry.
- `settings.json`'s `defaultProvider` keeps the old value until a model is picked again.

Nothing is migrated in code: the old spelling would have to be resolved in three separate files, and
`GATEWAY_PROVIDER_NAME=Bifrost` already reproduces the previous behaviour exactly.

Also in this release, the notes that explained the `x-api-key` choice no longer name the gateway
product they were measured on; the measurements themselves, and the version they were taken against,
are unchanged. The `/login` prompt stopped interpolating the provider name into that question too --
the value it asks for is the key *behind* the gateway, which is neither the SSO nor the provider, so
it is now simply "Upstream gateway API key". `bifrost` left the npm keywords for the same reason it
left the prose; put it back if discovering this package by gateway product still matters.

### Types and lint

`extensions/authelia-device-auth.ts` is now clean under `tsc --strict` and `biome lint`; it had one
type error and three lint warnings before:

- `refreshToken(credentials, signal)` was not assignable to the `oauth.refreshToken` declaration in
  older pi-ai releases, which take only the credentials. The parameter is optional now, which
  satisfies both declarations and still receives the signal when pi supplies one -- pi 1.6.0's own
  `registerProvider` example shows the two-argument form. Without a caller-supplied signal the refresh
  request runs uncancellable, which is what it did under the older declaration anyway.
- `discover()` now returns the two endpoints it already checks for, so their presence is established
  in one place and the three non-null assertions at its call sites are gone.
- `signal ?? null` at the two `fetch` calls. `RequestInit.signal` is `AbortSignal | null`, so an
  absent signal has to be null rather than an omitted property once `exactOptionalPropertyTypes` is
  on -- the setting that would otherwise be unable to type a dropped cancellation token.

Behaviour re-checked against a local stub instead of reasoned about: the device login still surfaces
the user code and stores the id_token as `access`, refresh still rotates and still carries the stored
key (including promoting a legacy `gatewayKey`), an aborted signal still stops both flows, and a
discovery document without endpoints still fails with the same message. Checked with
`@earendil-works/*` 0.82.1 and 1.6.0's docs, TypeScript 6 + biome 2.5.6 via the neighbouring
`agent-smart-fetch` checkout; this package carries no tsconfig or biome config of its own yet, so
that command line is not reproducible from the repo. The same stub run is what the README means by
"a test covers it" for refresh carrying the key -- the behaviour is verified, but no test file ships
in this package.

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
