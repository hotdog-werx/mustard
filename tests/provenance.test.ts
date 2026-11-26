import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { after, test } from 'node:test';
import { readConfig } from '../src/config.ts';
import type { Event, GitHub, Run } from '../src/github.ts';
import signed from './fixtures/baseline-attestation.json' with { type: 'json' };

const base = 'a'.repeat(40);
const workflow = '.github/workflows/ci.yml';
const event = {
  repo: { owner: 'hotdog-werx', repo: 'mustard' },
} as Event;
const run = { id: 7, run_attempt: 1, head_sha: base, head_branch: 'main', path: workflow } as Run;
const name = `mustard-report-${base}`;
const digest = createHash('sha256')
  .update(readFileSync(new URL('./fixtures/report.zip', import.meta.url)))
  .digest('hex');

// Replace the TUF download with a fixture trust root. Sigstore still verifies
// the certificate chain, RFC 3161 timestamp, envelope signature, and policy.
const rootModule = `
  const authority = (...certificates) => ({
    certChain: { certificates: certificates.map(cert => ({ rawBytes: Buffer.from(cert, 'base64') })) },
  });
  export async function getTrustedRoot() {
    return {
      certificateAuthorities: [authority(${JSON.stringify(signed.ca)})],
      timestampAuthorities: [authority(${JSON.stringify(signed.tsa)}, ${JSON.stringify(signed.ca)})],
      tlogs: [],
      ctlogs: [],
    };
  }
`;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@sigstore/tuf' && context.parentURL?.endsWith('/src/baseline.ts')) {
      return {
        url: `data:text/javascript;base64,${Buffer.from(rootModule).toString('base64')}`,
        shortCircuit: true,
      };
    }
    return next(specifier, context);
  },
});
const { Provenance } = await import('../src/baseline.ts');
hooks.deregister();

const previousServer = process.env.GITHUB_SERVER_URL;
process.env.GITHUB_SERVER_URL = 'https://github.com';
after(() => {
  if (previousServer === undefined) delete process.env.GITHUB_SERVER_URL;
  else process.env.GITHUB_SERVER_URL = previousServer;
});

function provenance(bundles: unknown[] = [signed.bundle]) {
  const api = {
    rest: {
      repos: {
        get: async () => ({ data: { private: true } }),
        listAttestations: async () => ({ data: { attestations: bundles.map((bundle) => ({ bundle })) } }),
      },
    },
  } as unknown as GitHub;
  return new Provenance(api, event, readConfig('baseline: {attestations: required}'));
}

test('accepts a valid signed baseline from the expected workflow run', async () => {
  await provenance().verify(name, digest, run);
});

test('requires a certificate-backed in-toto attestation and can skip unrelated bundles', async () => {
  const { dsseEnvelope, verificationMaterial, ...metadata } = signed.bundle;
  const unrelated = [
    { ...signed.bundle, dsseEnvelope: { ...dsseEnvelope, payloadType: 'application/json' } },
    {
      ...metadata,
      dsseEnvelope,
      verificationMaterial: {
        publicKey: { hint: 'release-key' },
        timestampVerificationData: verificationMaterial.timestampVerificationData,
      },
    },
  ];
  await assert.rejects(provenance(unrelated).verify(name, digest, run), /No attestation matched/);
  await provenance([...unrelated, signed.bundle]).verify(name, digest, run);
});

test('rejects a genuine attestation from an older attempt of the same run', async () => {
  await assert.rejects(
    provenance().verify(name, digest, { ...run, run_attempt: 2 }),
    /No attestation matched the trusted workflow/,
  );
});

test('rejects a genuine attestation for the same commit from another workflow', async () => {
  await assert.rejects(
    provenance().verify(name, digest, { ...run, path: '.github/workflows/other.yml' }),
    /No attestation matched the trusted workflow/,
  );
});

test('rejects a genuine attestation for a different commit', async () => {
  await assert.rejects(
    provenance().verify(name, digest, { ...run, head_sha: 'b'.repeat(40) }),
    /No attestation matched the trusted workflow/,
  );
});

test('rejects a signed report whose digest differs from the downloaded artifact', async () => {
  const changedDigest = createHash('sha256').update('replacement artifact').digest('hex');
  await assert.rejects(
    provenance().verify(name, changedDigest, run),
    /No attestation matched the trusted workflow/,
  );
});
