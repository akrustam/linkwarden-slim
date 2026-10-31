# Review: build stability, 2026-10-29

Scope: all working-tree changes relative to `818d635`, reviewed using
`thermo-nuclear-code-quality-review`. Date: 29 October 2026, Europe/Moscow.

## Verdict

**Code review: APPROVE.** No remaining blocking correctness or structural
findings in the reviewed changes. No changed implementation file crosses
1,000 lines. The release resolver is 92 lines, with a separate 36-line lock
validator; the superseded shell resolver, its mode-selection machinery and
the unused version-writing bot have been removed.

**Container/release verification: pending.** This environment cannot connect
to the Docker daemon. `CI_RUN_NETWORK_TESTS=1 bash ci/dockerfile-context.test.sh`
fails explicitly with `Docker is required when CI_RUN_NETWORK_TESTS=1`.
A read-only pull-request workflow now builds and smoke-tests both platforms
without pushing images. Its first remote run is pending. Production promotion still requires the existing source and
amd64/arm64 runtime gates in Actions.

## Findings resolved

| Finding | Resolution and evidence |
|---|---|
| Mutable Node LTS alias changed the build environment and removed Corepack. | Application bases use immutable index digests in `build-lock.json`. Node/Rust pins come from successful run 40687144204. The Dockerfile requires explicit build arguments and reports Node/Corepack versions. |
| Source version, commit and image references were duplicated across several files. | A validated build lock owns upstream URL/tag/SHA, all four application/validation images and Monolith version. Removed `VERSION`, the proposed `VERSION_SHA` and the automatic pin writer. |
| Freshness resolution could combine current packaging with image arguments captured by the initial workflow. | Fresh arguments contain only repository URL and registry executable. Each resolution materializes its selected packaging commit and reads that commit's entire lock. Integration tests change both service and base pins and verify fresh fingerprints and recipe IDs. The previous packaging-SHA comparison already rejected a changed main commit; this change makes configuration resolution coherent rather than repairing a demonstrated stale-promotion bypass. |
| Adding another shell mode increased branching and made cleanup/error behavior harder to assess. | Replaced it with a strict Node CLI, one default locked-version flow, and an explicit manual tag override. Temporary files are removed in `finally`; arguments are passed without shell evaluation. |
| Manual selection of the reviewed tag could bypass its expected source SHA. | Both default and explicit selection of that tag check the locked SHA. Real-git tests cover moved tags, annotated tags, historical versions and exact packaging commit selection. |
| Persisted input references could disagree with their sealed recipe. | Publication rejects mismatching upstream SHA or Node/Rust digests before registry operations. |
| Local verification could return success without performing an opted-in Docker build; working-tree snapshots could omit new files. | Missing Docker now fails. The harness snapshots explicit current files including the lock. An integration test uses real git contexts and a Docker fixture to check complete argument and file plumbing; it also checks the unavailable-Docker path. This fixture does not perform a container build. |
| Pinned action code still allowed floating Buildx, BuildKit and QEMU defaults. | Workflow pins Buildx v0.38.0, BuildKit v0.33.1 by index digest and the QEMU digest seen in the successful run. QEMU installs arm64 only. Local validation and staging use Buildx rather than separate default builder paths. |
| Structural greps alone could miss malformed embedded workflow shell. | The workflow test also parses YAML and syntax-checks every embedded run script with Bash. |

## Verification

- `node --test ci/*.test.mjs ci/lib/*.test.mjs`: **72 passed, 0 failed**.
- All **8 shell test scripts** passed with network builds disabled.
- `git diff --check`: passed.
- The new integration tests use local git repositories, annotated/lightweight
  tags, sealed packaging exports and a registry fixture. They check isolated
  registry configuration, missing/malformed locks, missing architectures,
  failed registry reads, manual version policy and current-main lock refresh.
- Docker registry inspection confirmed amd64/arm64 entries for the selected
  Node/Rust indexes and amd64 entries for service indexes. Service child
  digests match the previously successful run. The selected BuildKit index
  was verified through the registry.

## Operational limits

APT package repositories, Yarn/npm/Cargo downloads, Prisma engine downloads,
registry availability, GitHub APIs and hosted-runner updates remain external
inputs. These changes prevent unreviewed source/base/tool upgrades; they do not
provide a one-year availability guarantee or a byte-for-byte reproducible
build. Review security updates deliberately. Immutable application version
tags remain immutable; validated packaging fixes can advance guarded `latest`.
