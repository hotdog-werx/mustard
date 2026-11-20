# Attestation trust roots

`github.json` is the GitHub private Sigstore TUF bootstrap root from
[GitHub CLI v2.104.0](https://github.com/cli/cli/blob/v2.104.0/pkg/cmd/attestation/verification/embed/tuf-repo.github.com/root.json).
Mustard uses the pinned root to authenticate updates and fetch verification
material from GitHub's TUF mirror. The public Sigstore bootstrap root ships with
the pinned `@sigstore/tuf` package.
