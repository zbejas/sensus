import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
import { runAuth } from "../../../src/auth/cli";
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

describe("sensus auth CLI", () => {
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
  }

  test("init creates the identity and default policy", () => {
    const home = tempHome();
    const { io, out, err } = capture();
    expect(runAuth(["init"], io, {}, { home, uid: 1000 })).toBe(0);
    expect(err).toEqual([]);
    expect(out.join("\n")).toContain("identity created");
    expect(out.join("\n")).toContain("scopes      view");
    expect(JSON.parse(readFileSync(join(home, "auth", "policy.json"), "utf8")).scopes).toEqual(["view"]);
  });

  test("scopes updates only the policy and status is machine readable", () => {
    const home = tempHome();
    const first = capture();
    expect(runAuth(["init", "--allow", "view,chat"], first.io, {}, { home, uid: 1000 })).toBe(0);
    const second = capture();
    expect(runAuth(["scopes", "--allow", "control"], second.io, {}, { home, uid: 1000 })).toBe(0);
    expect(second.out.join("\n")).toContain("view,control");
    const status = capture();
    expect(runAuth(["status", "--json"], status.io, {}, { home, uid: 1000 })).toBe(0);
    const parsed = JSON.parse(status.out.join("\n"));
    expect(parsed.initialized).toBe(true);
    expect(parsed.policy.scopes).toEqual(["view", "control"]);
    expect(parsed.identity.fingerprint).toMatch(/^[0-9a-f]{4}-/);
  });

  test("unknown scopes and uninitialized identity fail cleanly", () => {
    const home = tempHome();
    const bad = capture();
    expect(runAuth(["scopes", "--allow", "root"], bad.io, {}, { home, uid: 1000 })).toBe(1);
    expect(bad.err.join("\n")).toContain("unknown scope");
    const missing = capture();
    expect(runAuth(["identity"], missing.io, {}, { home, uid: 1000 })).toBe(1);
    expect(missing.err.join("\n")).toContain("not initialized");
  });

  test("the CLI scope alphabet matches the connector contract", () => {
    expect(SCOPES).toEqual(["view", "chat", "control", "orchestrator"]);
  });
});
