import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const TOKEN_URL = 'https://partner-identity.myq-cloud.com/connect/token';
const SCOPE = 'MyQ_Residential offline_access';

const OAUTH_CLIENTS = {
  ANDROID_CGI_MYQ: { redirectUri: 'com.myqops://android' },
  IOS_CGI_MYQ: { redirectUri: undefined },
} as const;

export type MyqOAuthClient = keyof typeof OAUTH_CLIENTS;
export type TokenFetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface MyqToken {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  client_id?: MyqOAuthClient;
}

export function expandHome(path: string): string {
  if (path === '~') {
    return homedir();
  }
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

async function loadToken(path: string): Promise<MyqToken> {
  const token = JSON.parse(await readFile(expandHome(path), 'utf8')) as MyqToken;
  if (!token.refresh_token && !token.access_token) {
    throw new Error('token file contains neither a refresh_token nor an access_token');
  }
  return token;
}

async function saveToken(path: string, token: MyqToken): Promise<void> {
  const destination = expandHome(path);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(token)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
}

function oauthClient(value: unknown): MyqOAuthClient {
  const clientId = value ?? 'ANDROID_CGI_MYQ';
  if (typeof clientId !== 'string' || !(clientId in OAUTH_CLIENTS)) {
    throw new Error(`token file contains unsupported client_id: ${String(clientId)}`);
  }
  return clientId as MyqOAuthClient;
}

export function buildRefreshTokenBody(
  refreshToken: string,
  clientId: MyqOAuthClient,
): URLSearchParams {
  const body = new URLSearchParams({
    client_id: clientId,
    scope: SCOPE,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const redirectUri = OAUTH_CLIENTS[clientId].redirectUri;
  if (redirectUri) {
    body.set('redirect_uri', redirectUri);
  }
  return body;
}

async function refreshToken(
  refreshToken: string,
  clientId: MyqOAuthClient,
  fetcher: TokenFetcher,
): Promise<MyqToken> {
  const response = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: buildRefreshTokenBody(refreshToken, clientId),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== 'string') {
    const detail = payload.error_description ?? payload.error ?? `HTTP ${response.status}`;
    throw new Error(`myQ token refresh failed: ${String(detail)}`);
  }
  return {
    access_token: payload.access_token,
    refresh_token: typeof payload.refresh_token === 'string'
      ? payload.refresh_token
      : refreshToken,
    expires_in: typeof payload.expires_in === 'number' ? payload.expires_in : undefined,
    token_type: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
    scope: typeof payload.scope === 'string' ? payload.scope : undefined,
    client_id: clientId,
  };
}

export class TokenManager {
  private cached?: { token: MyqToken; expiresAt: number };
  private pending?: Promise<string>;

  constructor(
    readonly tokenFile: string,
    private readonly fetcher: TokenFetcher = (url, init) => fetch(url, init),
  ) {}

  async accessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - Date.now() > 60_000) {
      return this.cached.token.access_token;
    }
    if (this.pending) {
      return this.pending;
    }
    this.pending = this.refresh();
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  private async refresh(): Promise<string> {
    const stored = await loadToken(this.tokenFile);
    const clientId = oauthClient(stored.client_id);
    const token = stored.refresh_token
      ? await refreshToken(stored.refresh_token, clientId, this.fetcher)
      : stored;
    if (stored.refresh_token) {
      await saveToken(this.tokenFile, token);
    }
    this.cached = {
      token,
      expiresAt: Date.now() + (token.expires_in ?? 300) * 1000,
    };
    return token.access_token;
  }

  async validate(): Promise<void> {
    await loadToken(this.tokenFile);
  }
}
