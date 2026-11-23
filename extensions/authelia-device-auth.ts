/**
 * Authelia device-authorization login for an SSO-fronted OpenAI-compatible gateway provider
 * (default provider name `Bifrost`, overridable with GATEWAY_PROVIDER_NAME).
 *
 * `/login <provider>` prints a URL and a short code, the operator opens it in any browser
 * (phone is fine), does password + TOTP on https://auth.bloemendal.me, and this flow finishes
 * by itself: no callback URL to paste, no port to forward, nothing to copy back into the
 * terminal. That last part is why the machine can be a headless box reached over ssh.
 *
 * ---------------------------------------------------------------------------
 * What was verified rather than assumed (against a throwaway 4.39.28 instance,
 * 2026-11-23, whose database was created at 4.39.20 and migrated 24 -> 29):
 *
 *  - The bearer credential must be the **id_token**. Authelia's `access_token` for this
 *    client is an *opaque* 99-character string, not a JWT (default
 *    `access_token_signed_response_alg: none`), so oauth2-proxy's `skip_jwt_bearer_tokens`
 *    path cannot validate it; the id_token is RS256-signed and is what gets verified.
 *    Hence `access: id_token` below, which is unusual enough to be worth saying out loud.
 *  - `aud` on a device-flow id_token is `["pi-cli"]` -- the client_id is present even though
 *    upstream issue #12784 (device grant ignoring *requested* audiences) is still open, which
 *    is exactly why the gateway matches on the client_id and never on a custom audience.
 *  - `authorization_policy: two_factor` is enforced on this grant: with a 1FA-only portal
 *    session the consent POST is refused and the token stays `authorization_pending`; after
 *    TOTP the same request is granted, and the resulting `amr` is
 *    `["pwd","kba","otp","mfa"]`. A CLI token therefore cannot be minted without the second
 *    factor. (Enforcement happens at *consent*, not at the device-authorization request --
 *    that request is unauthenticated by design, per RFC 8628 3.1.)
 *  - `refresh_token` is issued for this public client, the refresh grant works with
 *    `token_endpoint_auth_method: none`, and it **rotates**: every refresh returns a new
 *    refresh_token, so `refreshToken` below must return the pair, never reuse the old one.
 *  - Polling before approval returns HTTP 400 with `error: authorization_pending`; `slow_down`
 *    is the signal to widen the interval. Both are expected, not failures.
 *  - The `cli` lifespan profile (1h access/id, 168h refresh) applies: `exp - iat` = 3600.
 *
 * Tokens are never logged. Failures quote Authelia's `error`/`error_description` only.
 */

import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";

/**
 * Deployment-specific values, all overridable so nothing here has to be edited to point the same
 * login flow at a different Authelia realm, gateway, pi provider name, or upstream key header.
 * The defaults are this estate's values; the code that uses them speaks in gateway/provider terms
 * rather than naming any one product, because the header choice below is a convention, not a
 * vendor feature (Anthropic's API uses `x-api-key` natively, and the Bifrost gateway tested here
 * accepts `x-api-key`, `X-API-Key` and `api-key` while rejecting a branded `X-Bifrost-Key`).
 */
const CONFIG = {
	issuer: process.env.AUTHELIA_ISSUER ?? "https://auth.bloemendal.me",
	clientId: process.env.AUTHELIA_CLIENT_ID ?? "pi-cli",
	scope: process.env.AUTHELIA_SCOPE ?? "openid profile email groups offline_access",
	provider: process.env.GATEWAY_PROVIDER_NAME ?? "Bifrost",
	baseUrl: process.env.GATEWAY_BASE_URL ?? "https://llm.bloemendal.me/v1",
	/** Header the upstream gateway reads its own key from. Never "authorization" -- see below. */
	keyHeader: process.env.GATEWAY_KEY_HEADER ?? "x-api-key",
	/** Environment variable that overrides the stored key, for headless or CI runs. */
	keyEnv: process.env.GATEWAY_KEY_ENV ?? "GATEWAY_API_KEY",
};

// offline_access is what makes a refresh_token exist at all; without it this login dies with the
// 1-hour access token and demands a fresh browser approval every hour. `groups` is requested for
// completeness only -- nothing gates on it, because a device-flow id_token carries no `groups` or
// `email` claim on Authelia 4.39.28 (handler_oauth2_consent.go restores the device request with an
// empty oidc.NewSession(), so scope claims are dropped even though consent records them granted).
// The gateway therefore authorises on issuer + aud=client + the TOTP-backed session; putting
// allowed_groups in oauth2-proxy would deny every CLI request against a claim that is never sent.

/**
 * Optional upstream gateway key.
 *
 * The Authelia token and the gateway key answer two different questions -- "may this machine reach
 * the gateway at all" and "which key owns this traffic" -- and they travel in different headers
 * because there is only one Authorization header:
 *
 *   Authorization: Bearer <Authelia id_token>   <- validated by the gateway; the gate
 *   x-api-key:     <upstream key>               <- reaches the gateway untouched; per-machine identity
 *
 * Measured against the deployed gateway (Bifrost v2.6.0 on llm.lan): `x-api-key` (and `api-key`) is
 * accepted for a key, and when both headers are present **x-api-key wins** -- valid key + garbage
 * Authorization returns 200, valid Authorization + bogus x-api-key returns 401. So the key decides
 * which identity owns the traffic while the gate still decides whether the request is allowed at
 * all. No gateway change was needed: haproxy.cfg strips only inbound X-Auth-Request-*.
 *
 * Do NOT put the gateway key in Authorization on the public URL: the gateway validates that header
 * as an Authelia token and will 401 it. That is the whole point of the design.
 *
 * Where the value lives: asked once during `/login` and stored as `gatewayKey` next to
 * access/refresh/expires in pi's own auth.json, so `/logout <provider>` clears it with the
 * credential and there is no second secrets file to remember. Verified against pi rather than
 * assumed -- the login path persists `{ type: "oauth", ...cred }`, the auth.json loader only
 * *validates* oauth credentials and keeps the parsed object, and `read()` hands back
 * `structuredClone(credential)`, so an extra field round-trips. `$GATEWAY_KEY_ENV` still overrides
 * it for headless or CI runs.
 *
 * Caveat worth stating rather than hiding: the key is self-declared, so it is attribution and not a
 * control. Any client that passes Authelia can name any key. With one operator that is a labelling
 * convenience; to make it a control, pin X-Auth-Request-User to a key in HAProxy and delete
 * inbound x-api-key first.
 */
const KEY_FIELD = "key";
/**
 * Where 1.1.0 stored it. Still read, so an existing login keeps working across the upgrade without
 * re-authenticating; every write uses `key`.
 *
 * `key` is also pi's field name for api_key credentials, and the overlap is deliberate: this
 * credential stays `type: "oauth"`, pi still uses `access` as the bearer, and that was re-verified
 * against a stub gateway after the rename rather than assumed safe.
 */
const KEY_FIELD_LEGACY = "gatewayKey";

/** auth.json credentials plus our one optional field. */
type Credentials = OAuthCredentials & { [KEY_FIELD]?: string; [KEY_FIELD_LEGACY]?: string };

/** First non-blank normalized value, so the legacy field name still resolves. */
function firstKey(...values: Array<string | undefined>): string {
	for (const v of values) {
		const k = normalizeKey(v ?? "");
		if (k) return k;
	}
	return "";
}

/** Tolerate a trailing newline from an editor and an accidental "Bearer " prefix from a paste. */
function normalizeKey(value: string): string {
	return value.trim().replace(/^Bearer\s+/i, "");
}

function authJsonPath(): string {
	const dir = process.env.PI_CODING_AGENT_DIR || `${process.env.HOME ?? ""}/.pi/agent`;
	return `${dir}/auth.json`;
}

/**
 * Read the stored key straight from auth.json.
 *
 * Why not through pi: `headers` on registerProvider is resolved once, at registration, so there is
 * no callback to ask -- and the alternative injection point, the `before_provider_headers` hook,
 * fires for *every* provider with an event of exactly `{ type, headers }` and no provider field.
 * Putting the key there would hand your gateway key to Anthropic, OpenAI and anything else
 * configured. Provider-scoped registration is the only safe place, so this one file read is how it
 * gets its value. It reads only the configured provider's own entry and the key is never logged.
 */
function storedGatewayKey(): string {
	try {
		const parsed = JSON.parse(readFileSync(authJsonPath(), "utf8")) as Record<string, Partial<Credentials>>;
		const entry = parsed[CONFIG.provider];
		if (!entry || typeof entry !== "object") return "";
		const rec = entry as Record<string, unknown>;
		const raw = rec[KEY_FIELD] ?? rec[KEY_FIELD_LEGACY];
		return typeof raw === "string" ? normalizeKey(raw) : "";
	} catch {
		return ""; // absent, unreadable or malformed is a normal state: gate-only, shared upstream key
	}
}

/** Precedence: explicit environment, then this credential, then what auth.json holds. */
function resolveGatewayKey(credential?: Partial<Credentials>): string {
	const fromEnv = (process.env[CONFIG.keyEnv] ?? "").trim();
	if (fromEnv) return normalizeKey(fromEnv);
	const fromCredential = firstKey(credential?.[KEY_FIELD], credential?.[KEY_FIELD_LEGACY]);
	if (fromCredential) return fromCredential;
	return storedGatewayKey();
}

/**
 * Ask for the key as part of `/login`. Optional by design: pressing enter keeps the current
 * behaviour (whatever shared key the gateway substitutes), which is also what a machine without a
 * key of its own should do. A headless caller with no prompt capability is not an error.
 */
async function promptForGatewayKey(callbacks: OAuthLoginCallbacks): Promise<string> {
	if (!callbacks.onPrompt) return "";
	let answer: string;
	try {
		answer = await callbacks.onPrompt({
			message: `${CONFIG.provider} API key (optional, for per-machine usage and limits). Press enter to skip.`,
		});
	} catch {
		return ""; // declined/cancelled prompt: log in without a key rather than fail the login
	}
	const key = normalizeKey(answer ?? "");
	if (!key) return "";
	if (!/^[A-Za-z0-9._~-]{12,}$/.test(key)) {
		// Deliberately not a hard failure: pi cannot know this gateway's key format, and rejecting a
		// valid-looking key would block a working login. Warn, and let the first 401 from the gateway
		// be the (accurate) error the operator sees, with /login to fix it.
		callbacks.onProgress?.(`Stored key "${key.slice(0, 6)}...", which does not look like an API key (no spaces, printable, 12+ chars). Run /login ${CONFIG.provider} again to change it.`);
	} else {
		callbacks.onProgress?.(`Gateway key stored in auth.json; run /reload (or restart pi) to start sending it.`);
	}
	return key;
}

// Refresh a little before the real expiry so a long request is not started on a token that
// dies mid-stream.
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

type Discovery = {
	device_authorization_endpoint?: string;
	token_endpoint?: string;
	issuer?: string;
};

async function discover(signal: AbortSignal | undefined): Promise<Discovery> {
	const res = await fetch(`${CONFIG.issuer}/.well-known/openid-configuration`, {
		signal,
		headers: { accept: "application/json" },
	});
	if (!res.ok) throw new Error(`Authelia discovery failed: HTTP ${res.status}`);
	const doc = (await res.json()) as Discovery;
	if (!doc.device_authorization_endpoint || !doc.token_endpoint) {
		throw new Error("Authelia discovery advertises no device_authorization_endpoint / token_endpoint");
	}
	return doc;
}

/** POST an OAuth form body. OAuth endpoints answer JSON on both success and failure. */
async function formPost(
	url: string,
	form: Record<string, string>,
	signal: AbortSignal | undefined,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await fetch(url, {
		method: "POST",
		signal,
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body: new URLSearchParams(form).toString(),
	});
	const text = await res.text();
	let body: Record<string, unknown> = {};
	try {
		body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
	} catch {
		// Non-JSON (an HTML error page from a proxy on the way) is information, not a crash:
		// keep the status and a short prefix so the operator can tell "SSO in the way" from
		// "token rejected".
		body = { non_json: text.slice(0, 160) };
	}
	return { status: res.status, body };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * `expires` is an absolute epoch in **milliseconds** (Pi compares it against Date.now()).
 * Prefer the id_token's own `exp`: for a device grant, `expires_in` describes the access
 * token, and the two can differ when a lifespan profile is in play.
 */
function expiryOf(tokenResponse: Record<string, unknown>): number {
	const idToken = str(tokenResponse.id_token);
	if (idToken) {
		try {
			const payload = idToken.split(".")[1] ?? "";
			const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
			if (typeof claims.exp === "number") return claims.exp * 1000 - EXPIRY_MARGIN_MS;
		} catch {
			/* fall through to expires_in */
		}
	}
	const expiresIn = Number(tokenResponse.expires_in);
	if (Number.isFinite(expiresIn)) return Date.now() + expiresIn * 1000 - EXPIRY_MARGIN_MS;
	// Unknown lifetime: claim a short one so Pi refreshes proactively instead of assuming the
	// credential is good forever.
	return Date.now() + 60 * 60 * 1000 - EXPIRY_MARGIN_MS;
}

function toCredentials(tokenResponse: Record<string, unknown>): Credentials {
	// See the header: id_token, not access_token, is the verifiable bearer here.
	const access = str(tokenResponse.id_token) || str(tokenResponse.access_token);
	if (!access) throw new Error("Authelia returned no id_token; is the `openid` scope granted?");
	const refresh = str(tokenResponse.refresh_token);
	if (!refresh) {
		throw new Error(
			"Authelia returned no refresh_token: the client must offer the refresh_token grant and " +
				"the offline_access scope must be granted, or this login dies with the 1-hour access token.",
		);
	}
	return { access, refresh, expires: expiryOf(tokenResponse) };
}

async function login(callbacks: OAuthLoginCallbacks): Promise<Credentials> {
	const signal = callbacks.signal;
	const doc = await discover(signal);

	const req = await formPost(
		doc.device_authorization_endpoint!,
		{ client_id: CONFIG.clientId, scope: CONFIG.scope },
		signal,
	);
	if (req.status !== 200 || !str(req.body.device_code)) {
		const detail = str(req.body.error_description) || str(req.body.error) || str(req.body.non_json) || "no detail";
		// Authelia answers 400 with an empty body when the client lacks the grant, which is
		// otherwise a genuinely undiagnosable failure from the client side.
		throw new Error(
			`Device authorization request failed (HTTP ${req.status}): ${detail}\n` +
				`  If the detail is empty, ${CONFIG.clientId} probably lacks the device_code grant -- the reason ` +
				`is only in the Authelia container log.`,
		);
	}

	const deviceCode = str(req.body.device_code);
	const verificationUri = str(req.body.verification_uri_complete) || str(req.body.verification_uri);
	const interval = Math.max(1, Number(req.body.interval) || 5);
	const expiresInSeconds = Number(req.body.expires_in) || 600;

	callbacks.onDeviceCode?.({
		userCode: str(req.body.user_code),
		verificationUri,
		intervalSeconds: interval,
		expiresInSeconds,
	});

	const deadline = Date.now() + expiresInSeconds * 1000;
	let waitMs = interval * 1000;

	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("Login cancelled.");
		await new Promise<void>((resolve) => {
			const t = setTimeout(resolve, waitMs);
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(t);
					resolve();
				},
				{ once: true },
			);
		});

		const res = await formPost(
			doc.token_endpoint!,
			{ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: CONFIG.clientId },
			signal,
		);
		if (res.status === 200 && str(res.body.id_token)) {
			const creds = toCredentials(res.body);
			// Asked after the token is real, so an abandoned browser login never leaves a stray key
			// behind, and a key typed into a prompt is stored only alongside a usable credential.
			const key = await promptForGatewayKey(callbacks);
			if (key) creds[KEY_FIELD] = key;
			return creds;
		}

		const err = str(res.body.error);
		if (err === "authorization_pending") continue;
		if (err === "slow_down") {
			// RFC 8628 3.5: the server asks for a wider interval (it says by how much in
			// `interval` when it bothers). Back off either way.
			waitMs = Math.max(waitMs + 5000, (Number(res.body.interval) || 0) * 1000);
			continue;
		}
		// HTTP 429 / temporarily_unavailable: seen in production against Authelia 4.39.28, whose
		// rate limiter fronts /api/oidc/token. Per RFC 8628 3.5 this is retryable, not fatal -- a
		// login that polls the full 10 minutes at the advertised 10s interval makes ~60 requests,
		// so a limiter tuned for a browser session will bite. Exponential backoff keeps the login
		// alive; the deadline still bounds the total wait so a persistently limited client cannot
		// spin forever. server_error is retryable by the same section.
		if (res.status === 429 || err === "temporarily_unavailable" || err === "server_error") {
			const suggested = Number(res.body.interval) || 0;
			waitMs = Math.min(Math.max(waitMs * 2, suggested * 1000, 15_000), 60_000);
			callbacks.onProgress?.(`Authelia is rate limiting this client; polling every ${Math.round(waitMs / 1000)}s`);
			continue;
		}
		if (err === "access_denied") throw new Error("Login declined in the browser.");
		if (err === "expired_token") throw new Error("The device code expired before the login finished. Try again.");
		throw new Error(
			`Token exchange failed (HTTP ${res.status}): ${str(res.body.error_description) || str(res.body.error) || str(res.body.non_json) || "no detail"}`,
		);
	}

	throw new Error(`Timed out after ${Math.round(expiresInSeconds / 60)} minutes waiting for the browser login.`);
}

async function refreshToken(credentials: Credentials, signal: AbortSignal): Promise<Credentials> {
	const doc = await discover(signal);
	const res = await formPost(
		doc.token_endpoint!,
		{
			grant_type: "refresh_token",
			client_id: CONFIG.clientId,
			refresh_token: credentials.refresh,
			scope: CONFIG.scope,
		},
		signal,
	);
	if (res.status !== 200 || !str(res.body.id_token)) {
		// invalid_grant here means the refresh token was revoked, rotated out by a concurrent
		// process, or the session it was minted from was ended in the portal. No client-side
		// retry can fix that, so say what to do instead of looping through /login hints.
		const err = str(res.body.error);
		throw new Error(
			`Could not refresh the Authelia session (HTTP ${res.status}${err ? `, ${err}` : ""}). ` +
			`Run /login ${CONFIG.provider} and complete the browser login with TOTP again.`,
		);
	}
	const next = toCredentials(res.body);
	// Carry the key across explicitly. toCredentials builds a fresh object from the token response,
	// so without this the stored key would silently vanish on the first hourly refresh and traffic
	// would quietly revert to the shared edge key -- a failure with no error and no log.
	const carried = firstKey(credentials[KEY_FIELD], credentials[KEY_FIELD_LEGACY]);
	if (carried) next[KEY_FIELD] = carried;
	return next;
}

export { login, refreshToken, resolveGatewayKey, normalizeKey };

export default function (pi: ExtensionAPI) {
	// Registering the same name the existing models.json entry uses means Pi treats this as that
	// provider with an OAuth capability added: the model catalog still comes from
	// ~/.pi/agent/models.json (Pi layers models.json over a registered native provider), so no
	// `models:` list here.
	//
	// Install on the client machines only (rokan, and anywhere else Pi talks to the public
	// gateway). Installing it on the gateway host itself would route that Pi through the public
	// URL and the SSO it fronts.
	const key = resolveGatewayKey();

	pi.registerProvider(CONFIG.provider, {
		baseUrl: CONFIG.baseUrl,
		api: "openai-completions",
		// Omitted entirely when unset, so a machine with no key keeps working through whatever the
		// gateway substitutes, instead of sending an empty header the upstream would reject.
		...(key ? { headers: { [CONFIG.keyHeader]: key } } : {}),
		oauth: {
			name: "Authelia (browser + TOTP)",
			login,
			refreshToken,
			getApiKey: (cred) => cred.access,
		},
	});
}
