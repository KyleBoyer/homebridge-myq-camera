import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildRefreshTokenBody,
  TokenManager,
  type TokenFetcher,
} from '../auth';

test('Android refresh preserves the existing client and redirect URI', () => {
  const body = buildRefreshTokenBody('android-refresh', 'ANDROID_CGI_MYQ');
  assert.equal(body.get('client_id'), 'ANDROID_CGI_MYQ');
  assert.equal(body.get('redirect_uri'), 'com.myqops://android');
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'android-refresh');
});

test('iOS refresh uses the iOS client without an Android redirect URI', () => {
  const body = buildRefreshTokenBody('ios-refresh', 'IOS_CGI_MYQ');
  assert.equal(body.get('client_id'), 'IOS_CGI_MYQ');
  assert.equal(body.has('redirect_uri'), false);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'ios-refresh');
});

test('TokenManager preserves iOS client provenance while rotating the token', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'homebridge-myq-auth-'));
  const tokenFile = join(directory, 'token.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(tokenFile, JSON.stringify({
    access_token: '',
    refresh_token: 'ios-refresh',
    client_id: 'IOS_CGI_MYQ',
  }));

  const fetcher: TokenFetcher = async (url, init) => {
    assert.equal(url, 'https://partner-identity.myq-cloud.com/connect/token');
    assert.equal(init.method, 'POST');
    const body = init.body as URLSearchParams;
    assert.equal(body.get('client_id'), 'IOS_CGI_MYQ');
    assert.equal(body.has('redirect_uri'), false);
    return new Response(JSON.stringify({
      access_token: 'rotated-access',
      refresh_token: 'rotated-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  assert.equal(await new TokenManager(tokenFile, fetcher).accessToken(), 'rotated-access');
  assert.deepEqual(JSON.parse(await readFile(tokenFile, 'utf8')), {
    access_token: 'rotated-access',
    refresh_token: 'rotated-refresh',
    expires_in: 3600,
    token_type: 'Bearer',
    client_id: 'IOS_CGI_MYQ',
  });
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
});

test('legacy token files continue to default to the Android client', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'homebridge-myq-auth-'));
  const tokenFile = join(directory, 'token.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(tokenFile, JSON.stringify({
    access_token: '',
    refresh_token: 'legacy-refresh',
  }));

  const fetcher: TokenFetcher = async (_url, init) => {
    const body = init.body as URLSearchParams;
    assert.equal(body.get('client_id'), 'ANDROID_CGI_MYQ');
    assert.equal(body.get('redirect_uri'), 'com.myqops://android');
    return new Response(JSON.stringify({
      access_token: 'android-access',
      refresh_token: 'android-refresh',
    }), { status: 200 });
  };

  assert.equal(await new TokenManager(tokenFile, fetcher).accessToken(), 'android-access');
  const saved = JSON.parse(await readFile(tokenFile, 'utf8')) as Record<string, unknown>;
  assert.equal(saved.client_id, 'ANDROID_CGI_MYQ');
});

test('unsupported OAuth clients fail before any network request', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'homebridge-myq-auth-'));
  const tokenFile = join(directory, 'token.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(tokenFile, JSON.stringify({
    access_token: '',
    refresh_token: 'refresh',
    client_id: 'UNKNOWN_CLIENT',
  }));
  const fetcher: TokenFetcher = async () => {
    throw new Error('network request should not occur');
  };

  await assert.rejects(
    new TokenManager(tokenFile, fetcher).accessToken(),
    /unsupported client_id: UNKNOWN_CLIENT/,
  );
});
