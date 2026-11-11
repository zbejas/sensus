import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateIdentity,
  fingerprintFromPublicKey,
  loadOrCreateIdentity,
  normalizeIdentity,
  readIdentity,
  signChallenge,
  verifyChallenge,
} from "../../../src/auth/identity";
import { defaultPolicy, isCwdAllowed, normalizePolicy, readPolicy, writePolicy, type AuthPolicy } from "../../../src/auth/policy";
import { SCOPES } from "../../../src/auth/scopes";

const dirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "sensus-auth-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("host identity", () => {
  test("fingerprint is the 4x4 form of the SPKI digest", () => {
    const identity = generateIdentity();
    expect(identity.fingerprint).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect(identity.fingerprint).toBe(fingerprintFromPublicKey(identity.publicKey));
    expect(normalizeIdentity(identity)).not.toBeNull();
  });

  test("challenge signatures verify and tampering fails", () => {
    const identity = generateIdentity();
    const signature = signChallenge(identity, "nonce-1", "inst_abc");
    expect(verifyChallenge(identity.publicKey, "nonce-1", "inst_abc", signature)).toBe(true);
    expect(verifyChallenge(identity.publicKey, "nonce-2", "inst_abc", signature)).toBe(false);
    expect(verifyChallenge(identity.publicKey, "nonce-1", "inst_other", signature)).toBe(false);
  });

  test("create writes a 0600 identity and never silently replaces a corrupt one", () => {
    const home = tempHome();
    const created = loadOrCreateIdentity(home, { uid: 1000, now: () => 1234 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.created).toBe(true);
    expect(created.identity.createdAt).toBe(1234);
    const path = join(home, "auth", "identity.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const again = loadOrCreateIdentity(home, { uid: 1000 });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.created).toBe(false);

    Bun.write(path, "{not json");
    const corrupt = loadOrCreateIdentity(home, { uid: 1000 });
    expect(corrupt.ok).toBe(false);
    expect(readIdentity(home).error).toContain("invalid identity JSON");
  });

  test("root cannot create the identity", () => {
    const result = loadOrCreateIdentity(tempHome(), { uid: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("root");
  });
});

describe("host policy", () => {
  test("default is view only and unknown scopes are rejected", () => {
    expect(defaultPolicy().scopes).toEqual(["view"]);
    expect(normalizePolicy({ version: 1, scopes: ["chat"] })?.scopes).toEqual(["view", "chat"]);
    expect(normalizePolicy({ version: 1, scopes: ["nope"] })).toBeNull();
  });

  test("write/read round-trip is 0600 and preserves the allowlist", () => {
    const home = tempHome();
    const policy: AuthPolicy = { ...defaultPolicy(), scopes: ["view", "control"], allowedCwd: [home] };
    const written = writePolicy(home, policy, { uid: 1000 });
    expect(written.ok).toBe(true);
    const path = join(home, "auth", "policy.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const read = readPolicy(home);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.policy.scopes).toEqual(["view", "control"]);
    expect(isCwdAllowed(read.policy, join(home, "sub"))).toBe(true);
    expect(isCwdAllowed(read.policy, "/etc")).toBe(false);
    expect(isCwdAllowed(read.policy, "relative")).toBe(false);
  });

  test("root cannot write the policy", () => {
    const written = writePolicy(tempHome(), defaultPolicy(), { uid: 0 });
    expect(written.ok).toBe(false);
  });
});

describe("host auth primitives", () => {
  test("the scope alphabet matches the cloud protocol", () => {
    expect(SCOPES).toEqual(["view", "chat", "control", "orchestrator"]);
  });

  test("root is refused by default and allowed with an explicit approval", () => {
    const home = tempHome();
    expect(loadOrCreateIdentity(home, { uid: 0 }).ok).toBe(false);
    expect(writePolicy(home, defaultPolicy(), { uid: 0 }).ok).toBe(false);
    const identity = loadOrCreateIdentity(home, { uid: 0, allowRoot: true });
    expect(identity.ok).toBe(true);
    expect(writePolicy(home, defaultPolicy(), { uid: 0, allowRoot: true }).ok).toBe(true);
  });
});
