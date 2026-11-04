// Exchanges a consent code using credentials owned by this workspace.
export async function exchangeGoogleCode(config, { clientId, code, redirectUri } = {}) {
    const badRequest = message => Object.assign(new Error(message), { statusCode: 400 });
    if (typeof code !== 'string' || !code || typeof redirectUri !== 'string' || !redirectUri) {
        throw badRequest('Google authorization code and redirect URI are required');
    }
    if (typeof config?.clientSecret !== 'string' || !config.clientSecret) {
        throw badRequest('Stored Google client secret is unavailable. Unlock the workspace or enter the client secret again.');
    }
    if (!clientId || config.clientId !== clientId) {
        throw badRequest('OAuth client id changed. Enter its client secret to reconnect.');
    }
    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId, client_secret: config.clientSecret,
            code, redirect_uri: redirectUri, grant_type: 'authorization_code',
        }),
    });
    const token = await response.json().catch(() => null);
    if (!response.ok || !token?.refresh_token) {
        throw badRequest('Google token exchange failed. Start sign-in again and grant offline access.');
    }
    let account = null;
    try {
        const profile = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(10000),
        });
        if (profile.ok) account = (await profile.json()).email || null;
    } catch { /* Account label is optional. */ }
    return { refreshToken: token.refresh_token, account };
}
