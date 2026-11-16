# Connector readiness

Swept 2026-11-16 by `tests/live/connectors-sweep.test.ts` (read-only: an unauthenticated MCP `initialize`, RFC 9728 protected-resource metadata, RFC 8414/OIDC authorization-server metadata, and a DNS lookup of each icon domain; no client was registered and nothing signed in).

**188 servers checked:** 183 ok, 5 warn, 0 broken, 0 unreachable. 10 catalog entries have no https server to probe (built in, browser, custom, and local servers on this Mac, which run only their allowlisted command or loopback address).

Re-run: `LIVE_SWEEP=1 npx vitest run --config vitest.live.config.mts tests/live/connectors-sweep.test.ts`

| App | Auth | Status | Server answered | Registration | PKCE S256 | Refresh | Problems / notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Gmail (`gmail`) | google | ok | open+oauth-no-dcr · 200 · StatelessServer | - | true | true | - |
| Google Calendar (`gcal`) | google | ok | open+oauth-no-dcr · 200 · StatelessServer | - | true | true | - |
| Google Drive (`gdrive`) | google | ok | open+oauth-no-dcr · 200 · StatelessServer | - | true | true | - |
| Notion (`notion`) | oauth | ok | oauth-dcr · 401 | mcp.notion.com/register | true | true | - |
| Linear (`linear`) | oauth | ok | oauth-dcr · 401 | mcp.linear.app/register | true | true | - |
| Asana (`asana`) | oauth-static | ok | oauth-no-dcr · 401 | - | true | true | initialize error: "invalid_request" |
| Jira & Confluence (`atlassian`) | oauth | ok | oauth-dcr · 401 | auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3/dcr/register | true | true | initialize error: "invalid_token" |
| monday.com (`monday`) | oauth | ok | oauth-dcr · 401 | auth.monday.com/oauth_ms/oauth/register | true | true | - |
| ClickUp (`clickup`) | oauth | ok | oauth-dcr · 401 | mcp.clickup.com/oauth/register | true | false | initialize error: "invalid_token"; no refresh_token grant listed: sign-in may be needed again when the token expires |
| Airtable (`airtable`) | oauth | ok | oauth-dcr · 401 | airtable.com/oauth2/v1/register | true | unlisted | initialize error: "UNAUTHORIZED" |
| Todoist (`todoist`) | oauth | ok | oauth-dcr · 401 | todoist.com/oauth/register | true | true | initialize error: "Unauthorized" |
| Calendly (`calendly`) | oauth | ok | oauth-dcr · 401 | calendly.com/oauth/register | true | unlisted | - |
| Box (`box`) | oauth-static | ok | oauth-no-dcr · 401 | - | true | true | - |
| Dropbox (`dropbox`) | oauth | ok | oauth-dcr · 401 | www.dropbox.com/oauth2/register | true | true | - |
| Zapier (`zapier`) | oauth | ok | oauth-dcr · 401 | mcp.zapier.com/api/v1/oauth/register | true | true | initialize error: Expected Bearer token for MCP authentication |
| Make (`make`) | oauth | ok | oauth-dcr · 401 | www.make.com/oauth/v2/register/mcp | true | true | token endpoint does not list "none" auth (DCR may hand out a client secret; the SDK handles that) |
| Granola (`granola`) | oauth | ok | oauth-dcr · 401 | mcp-auth.granola.ai/oauth2/register | true | true | - |
| Fireflies (`fireflies`) | oauth | ok | oauth-dcr · 401 | mcp.fireflies.ai/register | true | true | initialize error: "invalid_token" |
| Jotform (`jotform`) | oauth | ok | oauth-dcr · 401 | oauth2.jotform.com/register-public-client | true | true | - |
| Docusign (`docusign`) | oauth-static | ok | oauth-no-dcr · 401 | - | true | true | - |
| Trello (`trello`) | oauth | ok | oauth-dcr · 401 | auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3/dcr/register | true | true | initialize error: "invalid_token" |
| Coda (Superhuman Docs) (`coda`) | oauth | ok | oauth-dcr · 401 | id.superhuman.com/tokens/v4/api/oauth2/register | true | false | token endpoint does not list "none" auth (DCR may hand out a client secret; the SDK handles that); no refresh_token grant listed: sign-in may be needed again when the token expires |
| Readwise (`readwise`) | oauth | ok | oauth-dcr · 401 | readwise.io/o/register/ | true | true | - |
| Egnyte (`egnyte`) | oauth | ok | oauth-dcr · 401 | mcp-oauth.egnyte.com/clients | true | true | token endpoint does not list "none" auth (DCR may hand out a client secret; the SDK handles that) |
| Guru (`guru`) | oauth | ok | oauth-dcr · 401 | mcp.api.getguru.com/oauth/mcp/register | true | true | - |
| DocSend (`docsend`) | oauth | ok | oauth-dcr · 401 | docsend.com/oauth/register | true | true | - |
| Google Docs (`gdocs`) | google | ok | open+oauth-no-dcr · 200 · StatelessServer | - | true | true | - |
| Basecamp (`basecamp`) | oauth | ok | oauth-dcr · 401 | app.basecamp.com/oauth/clients | true | true | initialize error: "Authorization required" |
| Slack (`slack`) | oauth-static | ok | oauth-no-dcr · 401 | - | true | true | initialize error: missing_authorization_header |
| Zoom (`zoom`) | oauth-static | ok | oauth-no-dcr · 401 | - | true | true | initialize error: Access token is required |
| Intercom (`intercom`) | oauth | ok | oauth-dcr · 401 | mcp.intercom.com/register | true | true | initialize error: "invalid_token" |
| Livestorm (`livestorm`) | oauth | ok | oauth-dcr · 401 | mcp.livestorm.co/register | true | true | initialize error: "invalid_token" |
| Bird (`bird`) | oauth | ok | oauth-dcr · 401 | platform.bird.com/v1/oauth/register | true | true | - |
| Superhuman Mail (`superhuman-mail`) | oauth | ok | oauth-dcr · 401 | mcp.auth.mail.superhuman.com/oauth2/register | true | true | - |
| Mailchimp Transactional (`mandrill`) | apikey | ok | key · 200 | - | - | - | initialize error: Authorization: Bearer <api_key> required; re-checked 2026-11-16 |
| Chatbase (`chatbase`) | oauth | ok | oauth-dcr · 401 | www.chatbase.co/api/oauth/register | true | true | initialize error: Provide a valid OAuth access token as a bearer token. See the WWW-Authenticate header to discover the authorization server. |
| Help Scout (`helpscout`) | oauth | ok | oauth-dcr · 401 | mcp.helpscout.net/oauth/register | true | true | initialize error: "invalid_token" |
| Front (`front`) | oauth-static | ok | oauth-no-dcr · 401 | - | true | true | initialize error: "Missing authentication token." |
| Figma (`figma`) | oauth | ok | oauth-dcr · 401 | api.figma.com/v1/oauth/mcp/register | true | true | token endpoint does not list "none" auth (DCR may hand out a client secret; the SDK handles that) |
| Canva (`canva`) | oauth | ok | oauth-dcr · 401 | mcp.canva.com/register | true | true | initialize error: "invalid_token" |
| Miro (`miro`) | oauth | ok | oauth-dcr · 401 | mcp.miro.com/register | true | true | initialize error: "Authentication required"; token endpoint does not list "none" auth (DCR may hand out a client secret; the SDK handles that) |
| Gamma (`gamma`) | oauth | ok | oauth-dcr · 401 | auth.gamma.app/oauth/register | true | true | initialize error: "Authentication required" |
| HeyGen (`heygen`) | oauth | ok | oauth-dcr · 401 | api2.heygen.com/v1/oauth/register | true | true | initialize error: "invalid_token" |
| HyperFrames by HeyGen (`hyperframes`) | oauth | warn | oauth-dcr · 401 | api2.heygen.com/v1/oauth/register | true | true | initialize followed a redirect to https://mcp.heygen.com/mcp/hyperframes/; initialize error: "invalid_token" |
| Webflow (`webflow`) | oauth | ok | oauth-dcr · 401 | mcp.webflow.com/oauth/register | true | true | initialize error: "invalid_token" |
| Wix (`wix`) | oauth | ok | oauth-dcr · 401 | mcp.wix.com/register | true | true | initialize error: "invalid_token" |
| Frontify (`frontify`) | oauth | ok | oauth-dcr · 401 | mcp.frontify-integrations.com/oauth/register | true | true | initialize error: Unauthorized: OAuth authentication required |
| Higgsfield (`higgsfield`) | oauth | ok | oauth-dcr · 401 | clerk.higgsfield.ai/oauth/register | true | true | initialize error: "Unauthorized" |
| Descript (`descript`) | oauth | ok | oauth-dcr · 401 | auth.descript.com/v1/oauth2/register | true | true | initialize error: "Unauthorized" |
| Picsart Media Studio (`picsart`) | oauth | ok | oauth-dcr · 401 | auth.picsart.com/api/oauth2/register | true | true | initialize error: Authentication required |
| HubSpot (`hubspot`) | oauth-static | ok | oauth-no-dcr · 401 | - | true | true | - |
| Apollo (`apollo`) | oauth | ok | oauth-dcr · 401 | mcp.apollo.io/api/v1/oauth/applications/register_oauth_client | true | true | initialize error: "Unauthorized: Missing or invalid Authorization header for one of [initialize]" |
| Attio (`attio`) | oauth | ok | oauth-dcr · 401 | app.attio.com/oauth/register | true | true | initialize error: "Unauthorized" |
| Close (`close`) | oauth | ok | oauth-dcr · 401 | api.close.com/oauth2/register/ | true | true | initialize error: "invalid_token" |
| Pipedrive (`pipedrive`) | oauth | ok | oauth-dcr · 401 | oauth.pipedrive.com/oauth/register | true | true | initialize error: Unauthorized: No API token or authorization header provided. |
| Gong (`gong`) | oauth | ok | oauth-dcr · 401 | app.gong.io/oauth2/register | true | true | initialize error: "unauthorized"; token endpoint does not list "none" auth (DCR may hand out a client secret; the SDK handles that) |
| Klaviyo (`klaviyo`) | oauth | ok | oauth-dcr · 401 | mcp.klaviyo.com/register | true | true | - |
| Semrush (`semrush`) | oauth | ok | oauth-dcr · 401 | api.semrush.com/apis/v4-raw/auth/v1/oauth2/register | true | true | - |
| Ahrefs (`ahrefs`) | oauth | ok | oauth-dcr · 401 | api.ahrefs.com/mcp/register | true | false | no refresh_token grant listed: sign-in may be needed again when the token expires |
| Similarweb (`similarweb`) | oauth | ok | oauth-dcr · 401 | mcp-auth.similarweb.com/register | true | true | initialize error: "invalid_request" |
| Crunchbase (`crunchbase`) | oauth-static | ok | oauth-no-dcr · 401 | - | true | true | - |
| Buffer (`buffer`) | oauth | ok | oauth-dcr · 401 | auth.buffer.com/reg | true | true | initialize error: "Authorization header is required" |
| Brevo (`brevo`) | apikey | warn | oauth-dcr · 401 | mcp.brevo.com/oauth/register | true | true | initialize error: "invalid_token"; server now also offers OAuth with DCR + PKCE S256 (public clients): could become one click if the vendor documents it; re-checked 2026-11-16 |
| Supermetrics (`supermetrics`) | oauth | ok | oauth-dcr · 401 | api.supermetrics.com/oauth/register | true | true | initialize error: "invalid_token" |
| Crustdata (`crustdata`) | oauth | ok | oauth-dcr · 401 | mcp.crustdata.com/register | true | true | token endpoint does not list "none" auth (DCR may hand out a client secret; the SDK handles that) |
| Replicate (`replicate`) | oauth | ok | oauth-dcr · 401 | mcp.replicate.com/register | true | true | initialize error: "invalid_token" |
| Runway (`runway`) | oauth | ok | oauth-dcr · 401 | mcp.runwayml.com/register | true | true | initialize error: "missing_bearer" |
| Typefully (`typefully`) | oauth | ok | oauth-dcr · 401 | api.typefully.com/oauth2/register | true | true | initialize error: "Authentication required. This server supports OAuth: authorization details are in the WWW-Authenticate header and at https://mcp.typefully.com/.well-known/oaut |
| Metricool (`metricool`) | oauth | ok | oauth-dcr · 401 | app.metricool.com/oauth/register | true | true | initialize error: "unauthorized" |
| Windsor.ai Social (`windsor-social`) | oauth | ok | oauth-dcr · 401 | mcp.windsor.ai/social_media/register | true | true | - |
| Stripe (`stripe`) | oauth | ok | oauth-dcr · 401 | access.stripe.com/mcp/oauth2/register | true | true | initialize error: "Unauthorized. See https://docs.stripe.com/mcp for usage instructions." |
| PayPal (`paypal`) | oauth | ok | oauth-dcr · 401 | mcp.paypal.com/register | true | true | initialize error: "invalid_token" |
| Square (`square`) | oauth | ok | oauth-dcr · 401 | mcp.squareup.com/register | true | true | initialize error: "invalid_token" |
| Plaid (`plaid`) | oauth | ok | oauth-dcr · 401 | api.dashboard.plaid.com/oauth/register | true | unlisted | - |
| Xero (`xero`) | oauth-static | ok | oauth-no-dcr · 401 | - | true | true | - |
| Mercury (`mercury`) | oauth | ok | oauth-dcr · 401 | mcp.mercury.com/register | true | true | initialize error: "invalid_token" |
| Brex (`brex`) | oauth | ok | oauth-dcr · 401 | api.brex.com/v3/clients | true | true | - |
| Mollie (`mollie`) | oauth | ok | oauth-dcr · 401 | api.mollie.com/oauth2/register | true | true | - |
| Navan (`navan`) | oauth | ok | oauth-dcr · 401 | login.navan.com/oidc/register | true | true | initialize error: Missing Bearer token |
| BigCommerce (`bigcommerce`) | oauth | ok | oauth-dcr · 401 | login.bigcommerce.com/oauth/register | true | true | initialize error: "missing_bearer_token" |
| GitHub (`github`) | oauth-static | ok | oauth-no-dcr · 401 | - | true | true | - |
| Sentry (`sentry`) | oauth | ok | oauth-dcr · 401 | mcp.sentry.dev/oauth/register | true | true | - |
| Vercel (`vercel`) | oauth | ok | oauth-dcr · 401 | api.vercel.com/login/oauth/register | true | true | initialize error: "invalid_token" |
| Netlify (`netlify`) | oauth | ok | oauth-dcr · 401 | mcp.netlify.com/oauth-server/reg | true | true | initialize error: "unauthenticated" |
| Cloudflare (`cloudflare`) | oauth | ok | oauth-dcr · 401 | mcp.cloudflare.com/register | true | true | - |
| Cloudflare Observability (`cloudflare-observability`) | oauth | ok | oauth-dcr · 401 | observability.mcp.cloudflare.com/register | true | true | - |
| Cloudflare Docs (`cloudflare-docs`) | none | ok | open · 200 · docs-ai-search | - | - | - | - |
| Supabase (`supabase`) | oauth | ok | oauth-dcr · 401 | api.supabase.com/platform/oauth/apps/register | true | true | token endpoint does not list "none" auth (DCR may hand out a client secret; the SDK handles that) |
| Neon (`neon`) | oauth | ok | oauth-dcr · 401 | mcp.neon.tech/api/register | true | true | initialize error: "invalid_token" |
| Hugging Face (`huggingface`) | oauth | ok | open+oauth-dcr · 200 · huggingface.co/mcp | huggingface.co/oauth/register | true | true | token endpoint does not list "none" auth (DCR may hand out a client secret; the SDK handles that); re-checked 2026-11-16 |
| DeepWiki (`deepwiki`) | none | ok | open · 200 · DeepWiki | - | - | - | - |
| Context7 (`context7`) | none | ok | open+oauth-dcr · 200 · Context7 | clerk.context7.com/oauth/register | true | true | open, and also offers OAuth with DCR (clerk.context7.com): stays no sign-in; re-checked 2026-11-16 |
| Microsoft Learn (`mslearn`) | none | ok | open · 200 · Microsoft Learn MCP Server | - | - | - | - |
| Railway (`railway`) | oauth | ok | oauth-dcr · 401 | backboard.railway.com/oauth/register | true | true | initialize error: "Authentication required" |
| Postman (`postman`) | oauth | ok | oauth-dcr · 401 | mcp.postman.com/register | true | true | initialize error: Invalid Request: API key required |
| Grafana Cloud (`grafana`) | oauth | ok | oauth-dcr · 401 | mcp.grafana.com/mcp/oauth/register | true | true | initialize error: "invalid_token" |
| Honeycomb (`honeycomb`) | oauth | ok | oauth-dcr · 401 | ui.honeycomb.io/oauth/register | true | true | - |
| CircleCI (`circleci`) | oauth | ok | oauth-dcr · 401 | app.circleci.com/oauth/register | true | false | no refresh_token grant listed: sign-in may be needed again when the token expires |
| PlanetScale (`planetscale`) | oauth | ok | oauth-dcr · 401 | auth.planetscale.com/oauth/registration | true | true | initialize error: A PlanetScale OAuth access token is required.; token endpoint does not list "none" auth (DCR may hand out a client secret; the SDK handles that) |
| Better Stack (`betterstack`) | oauth | ok | oauth-dcr · 401 | betterstack.com/oauth/register | true | true | initialize error: "unauthorized" |
| Mapbox (`mapbox`) | oauth | ok | oauth-dcr · 401 | api.mapbox.com/oauth/register | true | true | initialize error: Unauthorized |
| GitLab (`gitlab`) | oauth | ok | oauth-dcr · 401 | gitlab.com/oauth/register | true | true | token endpoint does not list "none" auth (DCR may hand out a client secret; the SDK handles that) |
| Buildkite (`buildkite`) | oauth | ok | oauth-dcr · 401 | mcp.buildkite.com/oauth/register | true | true | initialize error: "access_denied" |
| Prisma Postgres (`prisma`) | oauth | ok | oauth-dcr · 401 | auth.prisma.io/register | true | unlisted | initialize error: "invalid_token" |
| Datadog (`datadog`) | oauth | ok | oauth-dcr · 401 | app.datadoghq.com/api/v2/oauth2/register | true | true | - |
| Render (`render`) | apikey | ok | oauth-no-dcr · 401 | - | true | true | OAuth metadata but no self-registration (stays an API key unless SahilBot registers its own app); re-checked 2026-11-16 |
| PagerDuty (`pagerduty`) | apikey | ok | oauth-no-dcr · 401 | - | true | true | initialize error: "invalid_token"; OAuth metadata but no self-registration (stays an API key unless SahilBot registers its own app); re-checked 2026-11-16 |
| PostHog (`posthog`) | oauth | ok | oauth-dcr · 401 | oauth.posthog.com/oauth/register/ | true | true | - |
| Amplitude (`amplitude`) | oauth | ok | oauth-dcr · 401 | mcp.amplitude.com/register | true | true | initialize error: "invalid_request" |
| Mixpanel (`mixpanel`) | oauth | ok | oauth-dcr · 401 | mixpanel.com/oauth/mcp/register/ | true | true | - |
| Cloudflare Radar (`cloudflare-radar`) | oauth | ok | oauth-dcr · 401 | radar.mcp.cloudflare.com/register | true | true | - |
| Vanta (`vanta`) | oauth | ok | oauth-dcr · 401 | api.vanta.com/oauth/register | true | true | initialize error: "invalid_token" |
| BigQuery (`bigquery`) | google | ok | open+oauth-no-dcr · 200 · StatelessServer | - | true | true | - |
| Alpha Vantage (`alphavantage`) | oauth | ok | oauth-dcr · 401 | mcp.alphavantage.co/register | true | true | initialize error: "invalid_request" |
| Hex (`hex`) | oauth | ok | oauth-dcr · 401 | auth.app.hex.tech/oauth2/register | true | true | - |
| Pendo (`pendo`) | oauth | ok | oauth-dcr · 401 | app.pendo.io/oauth/v1/register | true | true | - |
| Exa search (`exa`) | none | ok | open+oauth-dcr · 200 · exa-search-server | auth.exa.ai/api/oauth/register | true | true | open, and also offers OAuth with DCR (auth.exa.ai): stays no sign-in; re-checked 2026-11-16 |
| Perplexity (`perplexity`) | oauth | ok | oauth-dcr · 401 | api.perplexity.ai/oauth/register | true | true | initialize error: Invalid API key provided. Ensure your API key is correct and active. |
| Tavily (`tavily`) | oauth | ok | oauth-dcr · 401 | mcp.tavily.com/register | true | true | - |
| Firecrawl (`firecrawl`) | oauth | ok | oauth-dcr · 401 | www.firecrawl.dev/api/oauth/register | true | true | initialize error: "invalid_token" |
| Parallel Search (`parallel`) | none | ok | open · 200 · Parallel MCP | - | - | - | - |
| Craft (`craft`) | oauth | ok | oauth-dcr · 401 | mcp.craft.do/my/auth/register | true | true | initialize error: "invalid_token" |
| Evernote (`evernote`) | oauth | ok | oauth-dcr · 401 | accounts.evernote.com/auth/register | true | true | initialize error: "missing_token" |
| Otter.ai (`otter`) | oauth | ok | oauth-dcr · 401 | otter.ai/oauth/register | true | true | initialize error: "invalid_token" |
| Fathom (`fathom`) | oauth | ok | oauth-dcr · 401 | api.fathom.ai/mcp/oauth/register | true | true | initialize error: "unauthorized" |
| tl;dv (`tldv`) | oauth | ok | oauth-dcr · 401 | keycloak.tldv.io/realms/mcp.tldv.io/clients-registrations/openid-connect | true | true | initialize error: "invalid_token" |
| Typeform (`typeform`) | oauth | ok | oauth-dcr · 401 | api.typeform.com/oauth/register | true | true | initialize error: "not authorized" |
| Google Sheets (`gsheets`) | google | ok | open+oauth-no-dcr · 200 · StatelessServer | - | true | true | - |
| Google Slides (`gslides`) | google | ok | open+oauth-no-dcr · 200 · StatelessServer | - | true | true | - |
| RingCentral Team Chat (`ringcentral`) | oauth | ok | oauth-dcr · 401 | mcp.labs.ringcentral.com/ringex/team-chat/oauth/register | true | true | initialize error: "invalid_token" |
| Pylon (`pylon`) | oauth | ok | oauth-dcr · 401 | o.auth.usepylon.com/oauth2/register | true | true | - |
| Lucid (`lucid`) | oauth | ok | oauth-dcr · 401 | mcp.lucid.app/oauth/register | true | true | initialize error: "unauthorized" |
| Mural (`mural`) | oauth | ok | oauth-dcr · 401 | mcp-canvas.mural.co/register | true | true | - |
| Excalidraw (`excalidraw`) | none | ok | open · 200 · Excalidraw | - | - | - | - |
| Cloudinary (`cloudinary`) | oauth | ok | oauth-dcr · 401 | asset-management.mcp.cloudinary.com/register | true | true | initialize error: "unauthorized" |
| LottieFiles (`lottiefiles`) | oauth | ok | oauth-dcr · 401 | creator.mcp.lottiefiles.com/register | true | true | - |
| Jam (`jam`) | oauth | ok | oauth-dcr · 401 | api.jam.dev/oauth/register | true | true | initialize error: "invalid_token" |
| New Relic (`newrelic`) | oauth | ok | oauth-dcr · 401 | dcr.service.newrelic.com/register | true | true | initialize error: "unauthorized" |
| Axiom (`axiom`) | oauth | ok | oauth-dcr · 401 | authorization.axiom.co/oauth2/register | true | true | - |
| DigitalOcean (`digitalocean`) | oauth | ok | oauth-dcr · 401 | cloud.digitalocean.com/v1/oauth/register | true | true | - |
| Fly.io (`fly`) | oauth | ok | oauth-dcr · 401 | fly.io/mcp/oauth/register | true | true | initialize error: "authentication failed" |
| Sanity (`sanity`) | oauth | ok | oauth-dcr · 401 | mcp.sanity.io/register | true | true | initialize error: "invalid_token" |
| WorkOS (`workos`) | oauth | ok | oauth-dcr · 401 | signin.workos.com/oauth2/register | true | true | initialize error: "unauthorized" |
| Rootly (`rootly`) | oauth | ok | oauth-dcr · 401 | rootly.com/oauth/register | true | true | initialize error: "unauthorized" |
| BrowserStack (`browserstack`) | oauth | ok | oauth-dcr · 401 | mcp.browserstack.com/auth/oauth2/register | true | true | - |
| Mintlify (`mintlify`) | oauth | ok | oauth-dcr · 401 | mcp.mintlify.com/oauth/register | true | true | initialize error: Missing or invalid authorization header |
| AWS Knowledge (`aws-knowledge`) | none | warn | open · 200 · AWSKnowledgeMCP | - | - | - | PRM https://knowledge-mcp.global.api.aws/.well-known/oauth-protected-resource redirects to another site (https://github.com) |
| Svelte docs (`svelte`) | none | warn | open · 200 · Svelte MCP | - | - | - | PRM https://mcp.svelte.dev/.well-known/oauth-protected-resource/mcp redirects to another site (https://svelte.dev); PRM https://mcp.svelte.dev/.well-known/oauth-protected-resource redirects to another site (https://svelte.dev) |
| Twilio Docs (`twilio-docs`) | none | ok | open · 200 · twilio-docs-mcp | - | - | - | - |
| ClickHouse (`clickhouse`) | oauth | ok | oauth-dcr · 401 | mcp.clickhouse.cloud/register | true | true | initialize error: "Authentication required" |
| MotherDuck (`motherduck`) | oauth | ok | oauth-dcr · 401 | mcp-auth.motherduck.com/register | true | true | initialize error: Authentication required. Please authenticate using OAuth or provide a Bearer token. |
| ThoughtSpot (`thoughtspot`) | oauth | ok | oauth-dcr · 401 | agent.thoughtspot.app/register | true | true | initialize error: "invalid_token" |
| Monte Carlo (`montecarlo`) | oauth | ok | oauth-dcr · 401 | auth.getmontecarlo.com/oauth2/register | true | true | initialize error: "invalid_token" |
| DataHub (`datahub`) | oauth | ok | oauth-dcr · 401 | mcp.datahub.com/mcp/oauth/register | true | true | - |
| Felt (`felt`) | oauth | ok | oauth-dcr · 401 | felt.com/oauth/register | true | true | token endpoint does not list "none" auth (DCR may hand out a client secret; the SDK handles that) |
| ZoomInfo (`zoominfo`) | oauth | ok | oauth-dcr · 401 | mcp.zoominfo.com/oauth/register | true | true | token endpoint does not list "none" auth (DCR may hand out a client secret; the SDK handles that) |
| Clay (`clay`) | oauth | ok | oauth-dcr · 401 | api.clay.com/oauth/register | true | true | - |
| Lusha (`lusha`) | oauth | ok | oauth-dcr · 401 | auth.lusha.com/oauth/register | true | true | token endpoint does not list "none" auth (DCR may hand out a client secret; the SDK handles that) |
| Nutshell (`nutshell`) | oauth | ok | oauth-dcr · 401 | app.nutshell.com/oauth/register | true | true | - |
| beehiiv (`beehiiv`) | oauth | ok | oauth-dcr · 401 | mcp.beehiiv.com/register | true | true | initialize error: "unauthorized" |
| Windsor.ai (`windsor`) | oauth | ok | oauth-dcr · 401 | mcp.windsor.ai/register | true | true | - |
| vidIQ (`vidiq`) | oauth | ok | oauth-dcr · 401 | mcp.vidiq.com/mcp/register | true | true | - |
| Airwallex (`airwallex`) | oauth | ok | oauth-dcr · 401 | mcp.airwallex.com/mcp/register | true | true | - |
| Paddle (`paddle`) | oauth | ok | oauth-dcr · 401 | id.paddle.com/oauth2/register | true | true | initialize error: "No token provided." |
| Checkout.com (`checkout`) | oauth | ok | oauth-dcr · 401 | access.mcp.checkout.com/payment-operations/register | true | true | initialize error: Missing Bearer token |
| Morningstar (`morningstar`) | oauth | ok | oauth-dcr · 401 | mcp.morningstar.com/oauth-issuer/register | true | true | - |
| FactSet (`factset`) | oauth | ok | oauth-dcr · 401 | auth.factset.com/as/clients.oauth2 | true | true | token endpoint does not list "none" auth (DCR may hand out a client secret; the SDK handles that) |
| PitchBook (`pitchbook`) | oauth | ok | oauth-dcr · 401 | mcp.pitchbook.com/auth/register | true | true | - |
| S&P Global (Kensho) (`kensho`) | oauth | ok | oauth-dcr · 401 | kfinance.kensho.com/integrations/register | true | true | - |
| Financial Datasets (`financialdatasets`) | oauth | ok | oauth-dcr · 401 | mcp.financialdatasets.ai/register | true | true | - |
| Greenhouse (`greenhouse`) | oauth | ok | oauth-dcr · 401 | auth.greenhouse.io/register | true | true | initialize error: "not_authenticated" |
| Ashby (`ashby`) | oauth | ok | oauth-dcr · 401 | mcp-auth.ashbyhq.com/oidc/reg | true | true | initialize error: "Unauthorized" |
| Remote (`remote`) | oauth | ok | oauth-dcr · 401 | api.employ.remote.com/oauth/register | true | true | - |
| Indeed (`indeed`) | oauth | ok | oauth-dcr · 401 | secure.indeed.com/oauth/v2/register | true | true | initialize error: "invalid_token" |
| Dice (`dice`) | none | ok | open · 200 · Job Search MCP Server | - | - | - | - |
| PandaDoc (`pandadoc`) | oauth | ok | oauth-dcr · 401 | mcp.pandadoc.com/register | true | true | token endpoint does not list "none" auth (DCR may hand out a client secret; the SDK handles that) |
| Clio (`clio`) | oauth | ok | oauth-dcr · 401 | mcp.api.clio.com/register | true | true | initialize error: "unauthorized" |
| Midpage (`midpage`) | oauth | ok | oauth-dcr · 401 | app.midpage.ai/oauth/register | true | true | initialize error: "invalid_token" |
| Kiwi.com (`kiwi`) | none | ok | open · 200 · kiwicom-flight-search | - | - | - | - |
| trivago (`trivago`) | none | ok | open · 200 · trivago Accommodation Search | - | - | - | - |
| Zillow (`zillow`) | none | ok | open · 200 · fastmcp-external-gateway-pioneer | - | - | - | - |
| BiggerPockets (`biggerpockets`) | oauth | ok | oauth-dcr · 401 | www.biggerpockets.com/oauth/registration | true | true | token endpoint does not list "none" auth (DCR may hand out a client secret; the SDK handles that) |
| Wolfram (`wolfram`) | none | warn | open · 200 · Wolfram | - | - | - | PRM https://agenttools.wolfram.com/.well-known/oauth-protected-resource/mcp redirects to another site (https://www.wolframcloud.com); PRM https://agenttools.wolfram.com/.well-known/oauth-protected-resource redirects to another site (https://www.wolframcloud.com) |
| Consensus (`consensus`) | oauth | ok | oauth-dcr · 401 | consensus.app/oauth/register/ | true | true | initialize error: "unauthorized" |
| Scite (`scite`) | oauth | ok | oauth-dcr · 401 | api.scite.ai/mcp/oauth/register | true | true | initialize error: Authentication required. Please sign in to scite.ai to use MCP tools. |
| Wiley Scholar Gateway (`wiley`) | oauth | ok | oauth-dcr · 401 | connector.scholargateway.ai/register | true | true | - |
| Udemy Business (`udemy`) | oauth | ok | oauth-dcr · 401 | api.udemy.com/auth/external/oidc/dynamic-client/register | true | true | - |
| Strava (`strava`) | oauth | ok | oauth-dcr · 401 | www.strava.com/oauth/mcp/register_client | unlisted | true | PKCE methods not listed (SahilBot sends S256 anyway) |

Not probed (no server URL): `cursor-app`, `apple-notes`, `apple-mail`, `gmail-web`, `gcal-web`, `gdrive-web`, `linkedin-web`, `xcode`, `figma-desktop`, `custom`.
