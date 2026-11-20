import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import nock from 'nock';
import { base, repo, workflow } from './scenario.ts';

export function mockSigning() {
  const issuer = 'https://token.actions.githubusercontent.com';
  const oidc = 'https://oidc.mustard.invalid';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ref = 'refs/heads/main';
  const workflowRef = `${repo}/${workflow}@${ref}`;
  const claims = {
    iss: issuer,
    sub: `repo:${repo}:ref:${ref}`,
    ref,
    sha: base,
    repository: repo,
    event_name: 'push',
    job_workflow_ref: workflowRef,
    workflow_ref: workflowRef,
    repository_id: '123',
    repository_owner_id: '456',
    runner_environment: 'github-hosted',
    run_id: '6',
    run_attempt: '1',
  };
  const jwtPart = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  function token(audience: string) {
    const data = `${jwtPart({ alg: 'RS256', kid: 'mustard-fixture' })}.${jwtPart({ ...claims, aud: audience })}`;
    return `${data}.${sign('sha256', Buffer.from(data), privateKey).toString('base64url')}`;
  }

  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = `${oidc}/token?fixture=1`;
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'mustard-test-oidc-token';
  nock(oidc)
    .get('/token')
    .query({ fixture: '1', audience: 'nobody' })
    .reply(200, { value: token('nobody') });
  nock(oidc)
    .get('/token')
    .query({ fixture: '1', audience: 'sigstore' })
    .reply(200, { value: token('sigstore') });
  nock(issuer)
    .get('/.well-known/openid-configuration')
    .reply(200, { jwks_uri: `${issuer}/keys` });
  nock(issuer)
    .get('/keys')
    .reply(200, {
      keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'mustard-fixture', alg: 'RS256', use: 'sig' }],
    });
  nock('https://fulcio.githubapp.com')
    .post('/api/v2/signingCert')
    .reply(async (request: Request) => {
      const body = (await request.json()) as { credentials: { oidcIdentityToken: string } };
      assert.equal(body.credentials.oidcIdentityToken, token('sigstore'));
      // A parseable certificate is enough to exercise the signing bundle serialization.
      return [200, { signedCertificateEmbeddedSct: { chain: { certificates: [rootCertificates[0]] } } }];
    });
  nock('https://timestamp.githubapp.com').post('/api/v1/timestamp').reply(200, 'fixture-timestamp');
}
