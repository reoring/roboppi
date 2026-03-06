# AddressPool + IPRange (Cilium LB IP allocation) Implementation Request

This request is meant to be placed at:

`<appthrust/platform workspace>/.roboppi-loop/request.md`

Source-of-truth design doc (in the workspace):

- `design/cilium-loadbalancer-ip-allocation.md (or docs/design/cilium-loadbalancer-ip-allocation.md)`

## Goal

Implement enterprise-grade, persistent LoadBalancer IP allocation management for Cilium ClusterMesh using:

- `AddressPool` (declarative pool)
- `IPRange` (persistent allocation record per cluster)

and integrate it into existing `Subnet` + `CiliumCNI` reconciliation.

## Non-Goals

- Do not redesign the broader multi-cluster architecture.
- Do not introduce new user-facing CLIs unless necessary for tests.
- Do not print secrets by default.

## Workspace Constraints (must follow)

- Before changing controller logic, read `ARCHITECTURE.md`.
- Keep `pkg/*` reusable: `pkg/*` MUST NOT import `github.com/appthrust/platform/internal/*`.
- Run `gofmt` on touched Go files.
- If you change CRD source types, charts, or RBAC markers, run `make check-codegen` and commit generated changes.

## Deliverables

### 1) CRDs + API types (v1alpha1)

Implement types and generation for:

- `AddressPool` (namespace-scoped)
- `IPRange` (namespace-scoped)

The shared reference/address types MUST reuse existing shared types:

- `LocalRef`, `SubnetRef`, `AddressRangeSpec` from `pkg/apis/cilium/v1alpha1/types_shared.go`

Required fields/behavior are described in `design/cilium-loadbalancer-ip-allocation.md (or docs/design/cilium-loadbalancer-ip-allocation.md)` (Spec/Status tables).

Must include (at minimum):

- Status phases
- Conditions (Bound/Valid/PoolExhausted/DeletionBlocked etc as per design)
- Finalizers:
  - AddressPool: `cilium.appthrust.com/addresspool-protection`
  - IPRange: `cilium.appthrust.com/iprange-protection`

### 2) Allocation lifecycle + algorithms

Implement the controller logic described in the design:

- Capacity calculation:
  - `capacity = floor((2^(32-maskLen) - tailGuard) / blockSize)` (IPv4)
- Deterministic block assignment from CIDR tail (see test examples in the design doc)
- Allocation strategy:
  - virgin-first using `AddressPool.status.nextFreshIndex`
  - then FIFO reuse of `Released` allocations whose `releasedAt + releaseGracePeriod` has elapsed

Lifecycle expectations:

- `CiliumCNI` creation (once it has an assigned cluster ID) triggers creation or binding of an `IPRange` per matching `AddressPool`.
- `CiliumCNI` deletion transitions its `IPRange` to `Released` and records `releasedAt`.
- `releaseGracePeriod` prevents immediate reuse (default 6h; allow `0s` for tests).
- `reclaimPolicy`:
  - `Retain`: preserve `IPRange` records across `AddressPool` deletion/recreate.
  - `Delete`: deletion should be blocked while active allocations exist; after all are Released and grace elapsed, delete allocations.

### 3) Validation rules

Implement validations from the design doc:

- CIDR overlap check within the same namespace and same `subnetRef` among `AddressPool`s.
- `AddressPool` immutability after becoming Active:
  - Changing `spec.addressPool` (cidr/blockSize/tailGuard) after Active sets Valid=False (SpecImmutable) and phase returns to Pending.
- Pre-created `IPRange` static binding:
  - If `spec.addressRange` is set, verify it is within pool CIDR and matches blockSize.
  - If mismatched, refuse binding and set Bound=False with reason=SpecMismatch; keep phase Available.

### 4) CiliumCNI integration + remote resources

Integrate with `internal/controllers/cilium/ciliumcni_controller.go` behavior:

- When `CiliumCNI` is reconciled and its endpoint/remote connection is not yet resolved:
  - return `ctrl.Result{RequeueAfter: 30 * time.Second}` (as per design)
- After allocation is Bound, apply remote resources via SSA:
  - `CiliumLoadBalancerIPPool` + `CiliumL2AnnouncementPolicy`
  - Use fixed L2 policy values (`loadBalancerIPs: true`, interfaces like `^eth[0-9]+`), per design.
- Cleanup:
  - If a `CiliumCNI` exists but its corresponding `AddressPool` no longer exists, delete remote resources.

Platform behavior split:

- On-prem (vxlan): users create AddressPool -> remote L2 resources must be created.
- AWS (aws-eni): users do not create AddressPool -> no L2 resources.

### 5) Tests

Add tests matching the design doc’s intent.

Preferred (per design): Bun e2e tests using `@appthrust/kest`:

- Management cluster API suite under `e2e/cilium-lb-api/`:
  - 01..16 and 18 as listed in `design/cilium-loadbalancer-ip-allocation.md (or docs/design/cilium-loadbalancer-ip-allocation.md)`
- Integration suite:
  - `e2e/integration/17-l2-resources-ssa-apply.wlc.test.ts`

Minimum acceptable for first iteration (if time/CI cost is a concern):

- Implement at least tests 01–05 and 18, plus one of (06/08/14/15/16).

Also acceptable: targeted Go unit tests for core allocation math + selection logic, as long as
the behavior remains aligned with the design and the e2e scaffolding is created.

## Acceptance Criteria (definition of done)

- [ ] `AddressPool` + `IPRange` types exist and are wired into codegen (CRDs updated and `make check-codegen` passes).
- [ ] AddressPool validates CIDR overlaps and reports status/conditions per design.
- [ ] Allocation is persistent (`IPRange` has no ownerRef), supports pre-created records, and is deterministic.
- [ ] `releaseGracePeriod` prevents unsafe reuse; `0s` enables immediate reuse in tests.
- [ ] Bound `IPRange` is protected by finalizer; Released/Available can be deleted.
- [ ] `CiliumCNI` requeues when endpoint unresolved and eventually converges.
- [ ] Remote resources are SSA-applied when needed and cleaned up when AddressPool disappears.
- [ ] `go test ./...` passes.
- [ ] At least one new test suite exists and passes locally (Go or Bun), aligned with the design.

## How to Verify (commands)

Run at least:

```bash
gofmt -w <touched .go files>
go test ./...
make check-codegen
bash tests/check-files-get.sh
```

If you add Bun tests:

```bash
bun install
bun test e2e/cilium-lb-api
```
