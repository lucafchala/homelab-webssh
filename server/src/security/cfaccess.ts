import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

/**
 * Validates the Cloudflare Access JWT (`Cf-Access-Jwt-Assertion` header) that
 * Cloudflare attaches to every request that passed an Access policy. When
 * enabled, requests that did not come through Access are rejected even if the
 * origin is somehow reachable directly.
 */
export class CfAccessVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;

  constructor(
    teamDomain: string,
    private readonly aud: string,
  ) {
    const domain = teamDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.issuer = `https://${domain}`;
    this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/cdn-cgi/access/certs`));
  }

  async verify(token: string | undefined): Promise<JWTPayload | null> {
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.jwks, { issuer: this.issuer, audience: this.aud });
      return payload;
    } catch {
      return null;
    }
  }
}
