# Publishing `@agency/*` to npm (Option E)

Monorepo release order (dependency graph):

```text
@agency/providers
  -> @agency/core
    -> @agency/skills-bridge
    -> @agency/tui
      -> @agency/cli   (bins: agency, acg)
```

## Prerequisites

1. npm account with access to scope `@agency` (create org on npmjs.com if needed).
2. `npm login` (or `NPM_TOKEN` in CI).
3. `pnpm dogfood` and `pnpm smoke` pass on your machine.
4. Git working tree clean (recommended for release tags; scripts pass `--no-git-checks` so local dry-run works with uncommitted changes).

## Dry-run (no upload)

```powershell
pnpm publish:dry
```

Runs build, tests, then `pnpm publish --dry-run` for each package in order.

## Local tarballs (offline / QA)

```powershell
pnpm pack:local
# tarballs in dist-packs/
```

Install globally from clone (dev):

```powershell
.\scripts\install.ps1
```

## Version bump (keep all packages in sync)

```powershell
.\scripts\version-bump.ps1 -Version 0.1.1
pnpm -r build
pnpm smoke
```

## Publish to npm

```powershell
# optional: set repo URL for package.json repository field
$env:AGENCY_REPO_URL = "https://github.com/your-org/agency-cli"

.\scripts\publish.ps1 -Publish
```

Or:

```powershell
pnpm publish:release
```

### After publish

Users install:

```bash
npm install -g @agency/cli
acg
agency doctor
```

Requires **CodexAI skills pack** separately:

```bash
export AGENCY_SKILLS_ROOT=~/.cursor/skills-cursor   # or your install path
agency config init
```

## CI sketch (GitHub Actions)

```yaml
- run: pnpm install
- run: pnpm -r build
- run: pnpm -r test
- run: pnpm publish:dry
# on tag v*:
- run: pnpm publish:release
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `402 Payment Required` / scope | Create `@agency` org or use unscoped rename (breaking) |
| `workspace:*` in tarball | Use `pnpm publish` from package dir, not manual `npm pack` at root |
| `prepack` fails | `pnpm -r build` first |
| CLI works but no skills | User must set `AGENCY_SKILLS_ROOT` |
