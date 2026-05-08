# Publishing the @fearless/* packages to npm

The framework ships as a workspace with 4 publishable packages. This guide covers the steps to do the first public publish.

## Pre-flight

```bash
# 1. Confirm versions across packages
for pkg in packages/*/; do echo "$pkg" $(node -p "require('./$pkg/package.json').version"); done

# 2. Make sure each package builds + packs cleanly
for pkg in packages/*/; do
  echo "=== $pkg ==="
  (cd $pkg && npm run build && npm pack --dry-run 2>&1 | grep -E "name|version|filename|size")
done

# 3. Ensure no secrets in any tarball
for pkg in packages/*/; do
  (cd $pkg && npm pack --dry-run 2>&1 | grep -i -E "key|secret|env|token" || echo "$pkg clean")
done
```

## One-time setup

### Claim the @fearless org on npm

```bash
npm login                                         # if not already
npm org create fearless                           # claim the scope (free tier OK for public packages)
npm org set fearless <your-username> developer    # confirm membership
```

### Local link for development

While iterating on the packages locally, link them into a test app:

```bash
cd packages/aot-analyzer && npm link
cd ../aot-transpiler && npm link && npm link @fearless/aot-analyzer
cd ../aot-build && npm link && npm link @fearless/aot-analyzer @fearless/aot-transpiler
cd ../bun-runtime && npm link
```

In your test app:

```bash
npm link @fearless/aot-analyzer @fearless/aot-transpiler @fearless/aot-build
```

## Publish order (matters — packages depend on each other)

```bash
# 1. analyzer (no internal deps)
cd packages/aot-analyzer
npm publish --access public

# 2. transpiler (depends on analyzer)
cd ../aot-transpiler
npm publish --access public

# 3. build (depends on analyzer + transpiler)
cd ../aot-build
npm publish --access public

# 4. bun-runtime (no internal deps)
cd ../bun-runtime
npm publish --access public
```

## Post-publish smoke test

```bash
# Fresh dir, fresh install
mkdir /tmp/fearless-smoke && cd /tmp/fearless-smoke
npm init -y
npm install @fearless/aot-analyzer @fearless/aot-build

# Should resolve from npm, not from local
node -e "console.log(require('@fearless/aot-analyzer').analyzeHandler('(ctx) => ctx.json({})'))"
# → { compilable: true }
```

## Versioning policy

- **Patch** (0.1.x): bug fixes, doc updates, no API changes
- **Minor** (0.x.0): new features, backwards-compatible API additions, new analyzer rules that warn (don't error)
- **Major** (x.0.0): breaking API changes, new analyzer rules that promote previous warnings to errors

Bump all 4 packages together — they're versioned in lockstep so users only pick one version.

```bash
# Bump all to next minor
for pkg in packages/*/; do
  (cd $pkg && npm version minor --no-git-tag-version)
done

# Sync internal dep versions (manual: each package.json's `dependencies` block
# referencing @fearless/* must match)
```

## Rolling back a bad publish

```bash
# Within 24h of publishing
npm unpublish @fearless/aot-analyzer@0.1.0

# After 24h
npm deprecate @fearless/aot-analyzer@0.1.0 "Use 0.1.1 instead — bug in X"
```

## CI/CD (future)

For now, publishing is manual. When the project has more contributors, set up a release pipeline that:

1. Triggers on a `release/*` tag
2. Bumps versions across packages
3. Runs `npm test` in each
4. Publishes in the dependency order above

Reference: GitHub Actions + `changesets/changesets` for the version bump UI.
