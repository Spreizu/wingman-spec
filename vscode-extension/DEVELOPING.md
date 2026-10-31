# Developing the Wingman Spec extension

## Build and test

Requires Node 22.18 or later (tests run TypeScript directly) and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build          # bundles to out/extension.js
pnpm run package        # typecheck, test, bundle, and create a .vsix without a CLI (set WINGMAN_SPEC_BIN to run it)
```

The release builds come from the repository root: `scripts/package-vsix.sh` builds the Go CLI for each platform
(`linux`, `darwin` and `win32`, each `x64` and `arm64`) into `bin/` and packages one vsix per target into `dist/`. It needs Go (see `go.mod`); `scripts/package-vsix.sh linux-x64` builds one target.

`images/icon.png` is `assets/icon.svg` from the repository root rendered at 128 x 128 px. Edit the SVG, then render it again.

CI (`.github/workflows/ci.yml`) runs the typecheck and the tests on every push. A `v*` tag runs `.github/workflows/release.yml`: GoReleaser builds the CLI archives, `scripts/package-vsix.sh` the 6 vsix files, and both are attached to the GitHub release.

Install the `.vsix` for your platform with "Extensions: Install from VSIX..." in Cursor or VS Code, then reload the window.

The extension runs the CLI for everything it does not read from the files (`problems`, `sync --check`, `new`, `drift decide`). It
activates only in a workspace that contains `.wingman-spec/wingman-spec.yaml` or a specs repository's `wingman-spec.yaml`.

The UI uses inline SVG and VS Code codicons, never emoji. A test fails if an emoji appears in the sources, tests,
`package.json` or README.md. Render tests check that every page escapes injected HTML and keeps the CSP.

## What is tested

Pure models and the editor layer run under `node --test` against a stub of the VS Code API (`test/support/vscodeStub.mjs`), plus real git repositories and real CLI output as fixtures. Pages are rendered to HTML and checked (escaping, CSP, the commands a button may issue) and screenshotted in headless Chromium for layout. Nothing has been run inside a real VS Code or Cursor window, and headless Chromium on the rendered HTML is not a real webview: check the first install by eye.

Browser checks (layout, Timeline tab) are in `test/browser/` and need Playwright: see the header of each script.

## Releasing

A `v*` tag publishes the vsix files that the release workflow built (6 platform builds) to the VS Code Marketplace and to Open VSX, which Cursor uses. The publish job runs in the GitHub environment `marketplace`. The Marketplace step uses no stored token. Azure DevOps global PATs are retired on December 1, 2026.

One-time setup:

1. Publisher: sign in at marketplace.visualstudio.com/manage with a Microsoft account and create the publisher `elmo-egers`.
2. Marketplace sign-in, one of two options. Set the variables under Settings → Secrets and variables → Actions → Variables, for the repository or for the `marketplace` environment.
   - Trusted Publishing (simplest). On the `elmo-egers` publisher page, open Trusted Publishing → Create. Enter owner `Spreizu`, repository `wingman-spec`, workflow `release.yml` and environment `marketplace`. Then set the variable `VSCE_TRUSTED_PUBLISHING` to `true`.
   - Microsoft Entra ID. In the Azure portal, create an app registration (Entra ID → App registrations → New registration), or a user-assigned managed identity with the Reader role. Add a federated credential for GitHub Actions: issuer `https://token.actions.githubusercontent.com`, subject `repo:Spreizu/wingman-spec:environment:marketplace`, audience `api://AzureADTokenExchange`. Set the variables `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`, plus `AZURE_SUBSCRIPTION_ID` for a managed identity. Push a tag once: the step "Marketplace profile ID of the Entra identity" prints the identity's ID. On the `elmo-egers` publisher page, open Members → Add, enter that ID and choose the Contributor role. Then run the failed job again.
3. Open VSX: sign in at open-vsx.org with GitHub, link an Eclipse account and sign the publisher agreement. Create an access token in the profile settings, then run `npx ovsx create-namespace elmo-egers -p <token>`. Add it as the repository secret `OVSX_PAT`.
4. Optional: add required reviewers to the `marketplace` environment (Settings → Environments).

Each release:

1. Set `version` in `package.json` (the CLI takes its version from the tag) and add a CHANGELOG entry. Commit and push to `main`.
2. Tag and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.

The publish job stops when the tag does not match the `package.json` version. A registry without its variable or secret is skipped with a notice. The GitHub release is created either way.
