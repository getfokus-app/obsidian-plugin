import { existsSync, readFileSync, readdirSync } from 'node:fs';

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards on the artifact that actually ships.
 *
 * Every other test runs the source through vitest, where `obsidian` is aliased
 * to a stub — so a module-resolution mistake is invisible to all of them. A
 * dynamic `await import('obsidian')` once survived bundling verbatim and threw
 * on every request, leaving the plugin completely non-functional while the whole
 * suite stayed green. These assertions read `main.js`.
 */
const BUNDLE = 'main.js';

describe.runIf(existsSync(BUNDLE))('the built bundle', () => {
  const source = () => readFileSync(BUNDLE, 'utf8');

  /**
   * Obsidian supplies its module through its own `require` shim, which
   * `import()` does not go through. There is no node_modules beside the plugin.
   */
  it('resolves obsidian through require, never a dynamic import', () => {
    expect(source()).toContain('require("obsidian")');
    expect(source()).not.toMatch(/await import\(/);
  });

  /** `fetch` from the renderer sends an Origin the backend's CORS rejects. */
  it('never calls fetch', () => {
    expect(source()).not.toMatch(/\bfetch\(/);
  });

  /** Bundling a Node builtin would silently make the plugin desktop-only. */
  it('bundles no node builtins', async () => {
    const { builtinModules } = await import('node:module');
    const bundled = builtinModules.filter((m) =>
      new RegExp(`require\\(['"](?:node:)?${m}['"]\\)`).test(source()),
    );

    expect(bundled).toEqual([]);
  });

  /** Store guideline: build the DOM, never inject markup. */
  it.each(['innerHTML', 'outerHTML', 'insertAdjacentHTML'])('never uses %s', (api) => {
    expect(source()).not.toContain(api);
  });
});

/**
 * A source-level guard, not a bundle one — and the third bug of its kind.
 *
 * Twice now the shipped code reached the network by a route the headless
 * harness could not replace: first a dynamic `import('obsidian')`, then
 * `UploadsApi` importing `requestUrl` outright. Both left a whole feature
 * untested while its tests passed, because the harness injected a transport
 * that the production path never consulted. Confining `requestUrl` to the one
 * module whose job is transport makes the next such mistake a failing test
 * rather than a silent hole.
 */
describe('network access', () => {
  // Walked from disk, not `git ls-files`: a module added but not yet staged is
  // exactly when this guard needs to fire, and the tracked-files version
  // happily passed with an untracked file calling `requestUrl` directly.
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    });
  const files = walk('src');

  it('reaches the network only through the injectable transport', () => {
    const callers = files.filter((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .some((line) => /\brequestUrl\b/.test(line) && !/^\s*[*/]/.test(line)),
    );

    expect(callers).toEqual(['src/api/transport.ts']);
  });

  it('found the source files to check at all', () => {
    expect(files.length).toBeGreaterThan(15);
  });
});

/**
 * Release metadata the community store enforces, checked here so a mistake is a
 * failing test rather than a release Obsidian silently refuses to install.
 *
 * The store matches a GitHub release tag against `manifest.json` exactly, and
 * `versions.json` is what tells an older Obsidian which build it may take.
 */
describe('release metadata', () => {
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
  const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

  it('agrees on the version across manifest, versions and package', () => {
    expect(versions[manifest.version]).toBe(manifest.minAppVersion);
    expect(pkg.version).toBe(manifest.version);
  });

  /** Store rules: the id and name may not say "Obsidian", and name may not say "Plugin". */
  it('uses an id and name the store accepts', () => {
    expect(manifest.id).not.toMatch(/obsidian/i);
    expect(manifest.name).not.toMatch(/obsidian|plugin/i);
    expect(manifest.id).toMatch(/^[a-z0-9-]+$/);
  });

  it('describes itself the way the store asks', () => {
    expect(manifest.description.length).toBeLessThanOrEqual(250);
    expect(manifest.description).not.toMatch(/^(this|the) plugin/i);
    expect(manifest.description.endsWith('.')).toBe(true);
  });

  /**
   * 1.11.4 is where `SecretStorage.setSecret`/`getSecret` land. Declaring less
   * than that would let the plugin install on a build with no keychain, where
   * the token has nowhere to go — and `Vault.process` (1.6.0) is comfortably
   * below it.
   */
  it('declares a minimum app version that has secret storage', () => {
    const [major, minor, patch] = String(manifest.minAppVersion).split('.').map(Number);
    const atLeast = (a: number, b: number, c: number) =>
      major! > a || (major === a && (minor! > b || (minor === b && patch! >= c)));
    expect(atLeast(1, 11, 4)).toBe(true);
  });
});

/**
 * The default server, pinned in the artifact that ships.
 *
 * `api.getfokus.app` does not resolve. A build carrying it would fail to
 * connect for every user, with an error that looks like their network rather
 * than our typo — and the wrong form appears in enough fixtures and notes
 * around the workspace to be easy to copy back in by accident.
 */
describe('the default server', () => {
  it('points at the production API and never at the .app host', () => {
    const source = readFileSync(BUNDLE, 'utf8');
    expect(source).toContain('https://api.getfokus.com');
    expect(source).not.toContain('api.getfokus.app');
  });
});

/**
 * Behaviour that lives in `main.ts` and therefore cannot be unit-tested: the
 * file imports Obsidian, so the suite cannot load it at all.
 *
 * This exists because the account-change reset shipped once with its pure
 * helper and its test in place but the CALL SITE missing — an edit that matched
 * nothing. Everything was green and the feature did not exist. Asserting on the
 * built artifact is the only thing that catches a helper nobody calls.
 */
describe('wiring that only the bundle can prove', () => {
  const source = () => readFileSync(BUNDLE, 'utf8');

  it('resets the mirror when the vault is pointed at another account', () => {
    expect(source()).toContain('was synced with a different Fokus account');
  });
});

/**
 * The credential path, asserted on the artifact.
 *
 * `main.ts` and the settings tab both import Obsidian, so no unit test can see
 * whether the keychain is actually wired — only whether the helpers exist. The
 * Obsidian review team rejects plugins that keep credentials in `data.json`, so
 * a helper nobody calls would be both a security regression and a rejection.
 */
describe('the access token never goes in data.json', () => {
  const source = () => readFileSync(BUNDLE, 'utf8');

  /**
   * What the bundle can honestly prove is ABSENCE. Presence it cannot: a grep
   * for `setSecret` still matched after the migration's call site was deleted,
   * so those assertions were dropped and the behaviour moved to `TokenStore`,
   * where a fake keychain drives it for real (tests/secrets.test.ts).
   */
  it('puts neither the token nor a secret id in settings', () => {
    expect(source()).not.toContain('secretId');
  });

  /**
   * Deliberately NOT SecretComponent: it makes the user invent an id so the
   * secret can be shared between plugins, which is meaningless for a token that
   * is ours alone. A password field writing to a fixed id is the same security
   * property with none of the ceremony.
   */
  it('never asks the user to name the secret', () => {
    expect(source()).not.toContain('SecretComponent');
  });

  it('migrates a plaintext token left by an older build', () => {
    expect(source()).toContain('moved out of the vault and into the system keychain');
  });
});

/**
 * Release metadata the community store enforces, checked here so a mistake is a
 * failing test rather than a release Obsidian silently refuses to install.
 *
 * The store matches a GitHub release tag against `manifest.json` exactly, and
 * `versions.json` is what tells an older Obsidian which build it may take.
 */
