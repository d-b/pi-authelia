/**
 * Authelia device-authorization login for the `Bifrost` provider.
 *
 * `/login Bifrost` prints a URL and a short code, the operator opens it in any browser
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

const ISSUER = "https://auth.bloemendal.me";
const CLIENT_ID = "pi-cli";
const BASE_URL = "https://llm.bloemendal.me/v1";

// `groups` is what the gateway's oauth2-proxy checks (allowed_groups = ["admins"]), and
// `offline_access` is what makes a refresh_token exist at all -- without it the login would
// expire every hour and demand a fresh browser approval.
const SCOPE = "openid profile email groups offline_access";

// Refresh a little before the real expiry so a long request is not started on a token that
// dies mid-stream.
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

type Discovery = {
	device_authorization_endpoint?: string;
	token_endpoint?: string;
	issuer?: string;
};

async function discover(signal: AbortSignal | undefined): Promise<Discovery> {
	const res = await fetch(`${ISSUER}/.well-known/openid-configuration`, {
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

function toCredentials(tokenResponse: Record<string, unknown>): OAuthCredentials {
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

async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const signal = callbacks.signal;
	const doc = await discover(signal);

	const req = await formPost(
		doc.device_authorization_endpoint!,
		{ client_id: CLIENT_ID, scope: SCOPE },
		signal,
	);
	if (req.status !== 200 || !str(req.body.device_code)) {
		const detail = str(req.body.error_description) || str(req.body.error) || str(req.body.non_json) || "no detail";
		// Authelia answers 400 with an empty body when the client lacks the grant, which is
		// otherwise a genuinely undiagnosable failure from the client side.
		throw new Error(
			`Device authorization request failed (HTTP ${req.status}): ${detail}\n` +
				`  If the detail is empty, ${CLIENT_ID} probably lacks the device_code grant -- the reason ` +
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
			{ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: CLIENT_ID },
			signal,
		);
		if (res.status === 200 && str(res.body.id_token)) return toCredentials(res.body);

		const err = str(res.body.error);
		if (err === "authorization_pending") continue;
		if (err === "slow_down") {
			// RFC 8628 3.5: the server asks for a wider interval (it says by how much in
			// `interval` when it bothers). Back off either way.
			waitMs = Math.max(waitMs + 5000, (Number(res.body.interval) || 0) * 1000);
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

async function refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
	const doc = await discover(signal);
	const res = await formPost(
		doc.token_endpoint!,
		{
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: credentials.refresh,
			scope: SCOPE,
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
			`Run /login Bifrost and complete the browser login with TOTP again.`,
		);
	}
	return toCredentials(res.body);
}

export default function (pi: ExtensionAPI) {
	// Registering the same name the existing models.json entry uses means Pi treats this as that
	// provider with an OAuth capability added: the model catalog still comes from
	// ~/.pi/agent/models.json (Pi layers models.json over a registered native provider), so no
	// `models:` list here.
	//
	// Install on the client machines only (rokan, and anywhere else Pi talks to the public
	// gateway). Installing it on the gateway host itself would route that Pi through the public
	// URL and the SSO it fronts.
	pi.registerProvider("Bifrost", {
		baseUrl: BASE_URL,
		api: "openai-completions",
		oauth: {
			name: "Authelia (browser + TOTP)",
			login,
			refreshToken,
			getApiKey: (cred) => cred.access,
		},
	});
}
