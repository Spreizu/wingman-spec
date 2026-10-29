# Developing the Wingman Spec extension

## Build and test

Requires Node 22.18 or later (tests run TypeScript directly) and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build          # bundles to out/extension.js
pnpm run package        # typecheck, test, bundle, and create a .vsix
```

`images/icon.png` is `assets/icon.svg` from the repository root rendered at 128 x 128 px. Edit the SVG, then render it again.

CI (`.github/workflows/extension.yml`) runs the same steps on Node 24 and uploads the `.vsix` as an artifact. A `v*` tag also publishes a GitHub release with the `.vsix`.

Install the `.vsix` with "Extensions: Install from VSIX..." in Cursor or VS Code, then reload the window.

The build bundles `project-template/hooks/spec-guard.cjs` from this repository, so build from a full checkout.
The extension activates only in a workspace that contains `openspec/config.yaml`.

The UI uses inline SVG and VS Code codicons, never emoji. A test fails if an emoji appears in the sources, tests,
`package.json` or README.md. Render tests check that every page escapes injected HTML and keeps the CSP.

## What is tested

Pure models and the editor layer run under `node --test` against a stub of the VS Code API (`test/support/vscodeStub.mjs`), plus real git repositories and real verifier output as fixtures. Pages are rendered to HTML and checked (escaping, CSP, the commands a button may issue) and screenshotted in headless Chromium for layout. Nothing has been run inside a real VS Code or Cursor window, and headless Chromium on the rendered HTML is not a real webview: check the first install by eye.

Browser checks (layout, Timeline tab) are in `test/browser/` and need Playwright: see the header of each script.

## Releasing

A `v*` tag publishes the `.vsix` that CI built to the VS Code Marketplace and to Open VSX, which Cursor uses. One-time setup:

1. VS Code Marketplace: in Azure DevOps (dev.azure.com), create a personal access token with Organization "All accessible organizations" and scope "Marketplace: Manage". Create the publisher `elmoegers` at marketplace.visualstudio.com/manage.
2. Open VSX: sign in at open-vsx.org with GitHub, link an Eclipse account and sign the publisher agreement. Create an access token in the profile settings, then run `npx ovsx create-namespace elmoegers -p <token>`.
3. GitHub: add the repository secrets `VSCE_PAT` and `OVSX_PAT`. Optional: add required reviewers to the `marketplace` environment.

Each release:

1. Set `version` in `package.json` and add a CHANGELOG entry. Commit and push to `main`.
2. Tag and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.

The publish job stops when the tag does not match the `package.json` version. A registry whose secret is not set is skipped with a notice. The GitHub release is created either way.
