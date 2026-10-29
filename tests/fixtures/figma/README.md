# Figma fixtures

**These files are hand-built, not recorded from real Figma.** They were written by hand (via a throwaway generator
script, see the commit message) in the shape of the Figma REST API responses, and every field name used was checked
against the official OpenAPI description (`figma/rest-api-spec`, `openapi/openapi.yaml`, read on 2026-10-24):
`GET /v1/files/:key/nodes` (`nodes[id].document/components/componentSets/styles`), `GET /v1/files/:key/variables/local`
(`meta.variables`, `meta.variableCollections`), `GET /v1/images/:key` (`images` map, null for failed renders).
No public Figma file could be read without a token, so no real response is included.

| File | What it stands in for |
|---|---|
| `account-overview.nodes.json` | The "Account overview" card of a sample app: used for UPDATE mode (it differs from the code in the title colour, the title font-weight and the text-block gap). |
| `pricing-section.nodes.json` | A new "Pricing section" with three plan cards (component instances, variants, icons): used for BUILD mode. |
| `awkward-hero.nodes.json` | Edge cases: no auto layout, constraints, rotation, gradient fill, mixed text styles, hidden layer, instance of an unknown (remote) component, image fill. |
| `variables.local.json` | Local variables of the file (colours, spacing, radius; Light and Dark modes; `codeSyntax.WEB`). |
| `design-system.sample.json` | Output of `verify-task.cjs design-system --format json` on a sample app (the tokens the mapping step compares against). |
| `images.response.json`, `error-*.json` | Image-export response and error bodies served by the stub server in the tests. |
