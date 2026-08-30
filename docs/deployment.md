# Deployment contract

Azure Static Web Apps remains the static origin, but production release is
blocked until an edge provider is selected and a checked-in adapter deploys the
complete exact redirect manifest. Do not deploy `out/` manually or add an
operator bypass.

## Prebuilt artifact contract

The build owns the contents of `out/`:

- `staticwebapp.config.json` is the bounded SWA origin configuration. It
  contains trailing-slash behavior and baseline response headers, not the
  historical redirect catalog.
- `redirect-manifest.json` is deployment metadata with this versioned,
  provider-neutral shape:

  ```json
  {
    "schemaVersion": 1,
    "redirects": [
      {
        "source": "/historical-path/",
        "destination": "/recipes/canonical-path/",
        "status": 301
      }
    ]
  }
  ```

Every entry is an exact permanent redirect. The generator preserves validated
source spelling and encoding, emits canonical static-export destinations with
trailing slashes, sorts deterministically, and rejects duplicate sources,
canonical-route conflicts, and cycles. The manifest is not public site
content.

`npm run build:ci` and `npm run build:local` create useful prebuilt artifacts
for validation, but they are nondeployable because managed media remains
root-relative and the contact form is unavailable. `npm run build:release`
also fails intentionally before building while the redirect adapter is absent.

## Required deployment sequence

The eventual deployment workflow must perform these steps in order and stop on
any failure:

1. Run the guarded release build with the provisioned HTTPS media base and
   external contact form endpoint.
2. Parse only the supported redirect manifest schema and reject unknown fields,
   statuses, limits, or path transformations that the selected provider cannot
   preserve.
3. Deploy every manifest entry to the edge provider and verify the provider's
   accepted rule count and configuration version. Partial publication is a
   failed release.
4. Remove `redirect-manifest.json` from the origin upload tree. The deployment
   adapter consumes it; the website must not serve it.
5. Upload the remaining prebuilt `out/` directory to SWA without running a
   second application build. For `Azure/static-web-apps-deploy`, the relevant
   inputs are `app_location: "out"`, `output_location: ""`,
   `skip_app_build: true`, and `skip_api_build: true`.
6. Verify the deployed artifact and live behavior before changing production
   DNS or traffic.

The redirect adapter must be implemented and reviewed in the repository before
the release guard is removed. A variable that merely claims redirects were
deployed is not sufficient.

## External launch gates

Production remains blocked until all of these conditions are met:

- The edge provider and adapter are selected, all exact redirects fit provider
  limits, and automated live checks cover every source plus encoded Unicode and
  trailing-slash cases.
- The SWA resource, custom domains, TLS, deployment credentials, and rollback
  procedure are provisioned and reviewed.
- The configured media origin passes the existing exact object, byte, hash,
  MIME type, redirect, and output-closure validation.
- The contact provider enforces field limits and return URL allow-listing, and
  the owner approves an accurate privacy notice for its real data flow.
- `staticwebapp.config.json` remains at or below 20,000 UTF-8 bytes and the
  deployed responses contain the reviewed headers.
- Representative English, French, and Russian pages pass navigation, search,
  image, print, structured-data, contact, canonical, and `hreflang` checks.
- The provider manifest is absent from the public origin after the adapter has
  consumed it.

## Content Security Policy staging

No CSP is enforced yet. A static hand-authored policy cannot safely name the
unprovisioned media and contact origins, and the exported pages contain inline
Next bootstrap data and inline JSON-LD. Guessing broad `https:` sources or
adding `unsafe-inline` would create a misleading security boundary and could
still break hydration or structured data.

After the production origins and redirect adapter exist:

1. Build the exact release artifact and inventory same-origin scripts, styles,
   search fetches, the media origin, the contact form action, and every inline
   Next/JSON-LD block.
2. Generate build-specific hashes or another static-export-compatible inline
   script strategy. Do not add a nonce that the static host cannot issue per
   response.
3. Deploy an origin-specific `Content-Security-Policy-Report-Only` header to a
   staging environment and exercise hydration, search, media, print, contact,
   and structured data.
4. Resolve all expected violations, verify that unexpected external
   connections remain blocked, and only then promote the exact policy to
   `Content-Security-Policy`.

Any policy change must keep same-origin search data in `connect-src`, the exact
HTTPS media origin in `img-src`, and the exact external contact origin in
`form-action`.
