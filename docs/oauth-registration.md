# SahilBot's own OAuth app registrations

For the app owner. Eleven providers' MCP servers don't let apps register themselves (no dynamic client
registration): Slack, GitHub, Asana, HubSpot, Box, Docusign, Xero, Zoom, Front, Crunchbase and Google.
Without a built-in client, every user has to create their own OAuth app first ("Needs a one-time setup").
With SahilBot's own registration shipped in the build, those apps become **one click**. Connect opens the
provider's sign-in page in the user's browser, and there's nothing to paste. Users can still bring their own
app (Connect apps → the app → **Use your own app**).

Outlook is the twelfth: there's no MCP server SahilBot can use (Microsoft's hosted Microsoft 365 server only
serves Anthropic's Claude apps), so SahilBot signs in to Microsoft itself and calls Microsoft Graph
(`src/main/mail/outlook.ts`). It needs one Microsoft Entra app registration, under the key `outlook`.

This page is the checklist per provider. It was researched on 2026-11-15 from official vendor docs only;
links are under each provider. Where the docs didn't settle something, it says **unconfirmed**. Check those
points in the console when you register.

## How the IDs get into the app

1. Register the app at each provider (below). Use the exact redirect URI listed for it.
2. Put the IDs in one JSON document, shaped like `resources/oauth-clients.example.json`:

   ```json
   {
     "slack":  { "clientId": "…", "redirect": "http://localhost:47613/callback" },
     "github": { "clientId": "…", "clientSecret": "…", "redirect": "http://127.0.0.1:47613/callback" },
     "google": { "clientId": "….apps.googleusercontent.com", "clientSecret": "GOCSPX-…", "redirect": "loopback" },
     "outlook": { "clientId": "1a2b3c4d-…-0123456789ab", "redirect": "loopback" }
   }
   ```

   - Keys are catalog ids (`slack`, `github`, `asana`, `hubspot`, `box`, `docusign`, `xero`, `zoom`,
     `front`, `crunchbase`). `google` is shared by Gmail, Calendar, Drive, Docs, Sheets, Slides and
     BigQuery. A `gmail` (etc.) entry overrides it for that app alone. `outlook` is SahilBot's Microsoft
     Entra app for Outlook mail and calendar: a GUID client ID, no secret, redirect `"loopback"`.
   - `redirect` is either `"loopback"` or an exact URI.
     - `"loopback"`: the provider accepts any `127.0.0.1` port. SahilBot listens on a free port per sign-in.
     - An exact URI must be `http://127.0.0.1|localhost:<port>/callback`.
     - Omitted: Google defaults to `loopback`; other apps default to the redirect in their setup steps.
   - `clientSecret` is only for providers that require one (see each provider).
   - `scopes` (a string or an array) is asked for instead of the scopes the server advertises.
   - Malformed entries are skipped with a warning in the log, and the rest still load.
3. Ship it. Pick one:
   - **CI (recommended):** add a repository secret `SAHILBOT_OAUTH_CLIENTS_JSON` with the whole JSON. In the
     release workflow's publish job, the step "Built-in OAuth clients" runs `scripts/write-oauth-clients.mjs`.
     That step's environment has only this one secret. It writes `resources/oauth-clients.json` (mode 600)
     for electron-builder to package, and logs only which app ids got a client. Without the secret, nothing
     is written and the build has no built-in clients.
   - **Local build:** save the JSON as `resources/oauth-clients.json`. It's gitignored; never commit it.
   - **Development:** the `SAHILBOT_OAUTH_CLIENTS_JSON` environment variable also works when you run from
     source or in hidden test runs. A packaged app ignores the variable and reads only the shipped file.
4. Check: Connect apps shows those apps with a **One click** badge at the top of their section, no longer
   under "Needs a one-time setup".

### Secrets in a desktop app

A desktop app can't keep a client secret secret. Anyone can pull it out of the app bundle. Per RFC 8252
§8.5, it's an "installed app" credential: it identifies the app, but it doesn't authenticate it.

- **Prefer public PKCE clients wherever the provider has them:** Slack (PKCE on), Zoom ("Use Public Client
  OAuth"), Xero (PKCE app type). They ship no secret.
- **Where a provider requires a secret for the code exchange,** ship it as an installed-app secret.
  - This applies to GitHub, Front, HubSpot, Asana, Box and Docusign.
  - Google's Desktop clients also come with one. Google says desktop apps "are public clients and cannot
    keep secrets confidential", and its native-app guide lists `client_secret` as optional.
  - GitHub's own MCP server docs describe its official builds baking the OAuth app secret into the binary
    as "a public, non-confidential credential", with PKCE protecting the flow.
- **SahilBot's side of this:**
  - It always uses PKCE (S256) and a per-sign-in `state`. A code is only accepted with the state that went
    out.
  - It only sends a built-in client to the catalog's own server address. If the user edited the URL, the
    client isn't used there.
  - It never sends the client ID or secret to the renderer. The UI only learns `builtinClient: true`.
- **Never commit `resources/oauth-clients.json`,** and never put the secret in any other workflow step.

### Redirect URIs SahilBot uses

- **Port 47613:** the fixed loopback port for pre-registered clients (`SETUP_PORT` in
  `src/main/connectors.ts`).
- **Path:** always `/callback`.
- **Host:** `localhost` or `127.0.0.1`, as listed per provider. Some providers accept only one of the two.

## Checklist per provider

### Slack

- **Where to create it:** https://api.slack.com/apps → Create New App.
- **App type:**
  - Turn on PKCE (OAuth & Permissions, or `oauth_config.pkce_enabled: true` in the manifest). Slack then
    treats the app as a public desktop client, and its localhost redirects as desktop redirects.
  - Slack support has to reverse PKCE, so decide first.
- **Redirect URI:** `http://localhost:47613/callback`.
- **Scopes:** all of these are user token scopes; desktop redirects can't request bot scopes.
  - Search: `search:read.public`, `search:read.private`, `search:read.mpim`, `search:read.im`,
    `search:read.files`, `search:read.users`.
  - History: `channels:history`, `groups:history`, `mpim:history`, `im:history`.
  - Conversations: `channels:read`, `groups:read`, `im:read`, `mpim:read`, `channels:write`,
    `groups:write`, `im:write`, `mpim:write`.
  - Messages and reactions: `chat:write`, `reactions:read`, `reactions:write`.
  - Files and emoji: `files:read`, `files:write`, `emoji:read`.
  - Canvases and lists: `canvases:read`, `canvases:write`, `lists:read`, `lists:write`.
  - Users: `users:read`, `users:read.email`.
- **PKCE and public client:** yes.
- **Secret:** none. With PKCE on, don't send one. Leave `clientSecret` out.
- **Review before public use:**
  - Slack only lets **internal apps and Slack Marketplace apps** use its MCP server. Unlisted distributed
    apps are refused.
  - For other workspaces to use SahilBot's app, it has to be published in the Slack Marketplace. That needs
    at least 10 active installs, and Slack's functional review can take weeks.
  - Workspace admins may also need to approve the app.
- **Docs:** https://docs.slack.dev/ai/mcp-server/ · https://docs.slack.dev/authentication/using-pkce/ ·
  https://docs.slack.dev/slack-marketplace/

### GitHub

- **Where to create it:** https://github.com/settings/developers → New OAuth App. A GitHub App also works.
- **App type:** OAuth App.
- **Redirect URI:** `http://127.0.0.1:47613/callback` (GitHub recommends 127.0.0.1 over localhost). GitHub
  doesn't require the loopback port to match.
- **Scopes:** the server asks for scopes as tools need them: `repo`, `read:org`, `project`, `gist`,
  `notifications`, `workflow`, `security_events` and others.
- **PKCE:** S256 is supported. There's no public-client mode.
- **Secret: required.** The web-flow token exchange requires `client_secret`. Ship it as an installed-app
  secret.
- **Review before public use:**
  - No marketplace review is needed.
  - Organizations with OAuth app access restrictions must approve the app before org data is visible.
  - SSO orgs need an active SSO session.
- **Docs:** https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps ·
  https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server ·
  https://github.com/github/github-mcp-server/blob/main/docs/policies-and-governance.md

### Asana

- **Where to create it:** https://app.asana.com/0/my-apps → Create new app.
- **App type:** **MCP app**.
- **Redirect URI:** `http://localhost:47613/callback`. Asana requires an exact match. Loopback redirects
  must use PKCE (S256).
- **Scopes:** none. Asana says MCP apps don't take scopes, and sending one fails with "Invalid scope(s)".
  Leave `scopes` out.
- **PKCE:** yes, required for loopback.
- **Secret:** the OAuth docs list `client_secret` as required at the token endpoint. Whether an MCP app
  works without it is **unconfirmed**; ship it.
- **Review before public use:**
  - None documented.
  - Set Manage distribution to "Any workspace".
  - Enterprise admins may restrict apps.
- **Docs:** https://developers.asana.com/docs/integrating-with-asanas-mcp-server ·
  https://developers.asana.com/docs/oauth

### HubSpot

- **Where to create it:** a HubSpot account → Development → **MCP Auth Apps** → Create MCP auth app
  (https://app.hubspot.com/l/mcp-auth-apps/). This is in public beta.
- **App type:** MCP auth app.
- **Redirect URI:** `http://localhost:47613/callback`. Whether HubSpot accepts any localhost redirect is
  **unconfirmed**; its only example is a localhost URL.
- **Scopes:** none to choose. HubSpot works them out from the tools and the user's grants.
- **PKCE:** required. Public-client support is **unconfirmed**.
- **Secret:** issued and asked for during setup, so treat it as required. Ship it as an installed-app secret.
- **Review before public use:** unlisted apps on HubSpot's current platform are capped at 25 installs until
  they're listed on the HubSpot Marketplace. Whether the cap covers MCP auth apps is **unconfirmed**.
- **Docs:** https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server ·
  https://developers.hubspot.com/changelog

### Box

- **Where to create it:** there is no developer-console route documented for the MCP server.
  - Each enterprise's **Box admin** goes to Admin Console → Integrations → Box MCP server → Configure → Add
    Integration Credentials. That produces a client ID and secret for that enterprise only.
  - A Developer Console app (https://app.box.com/developers/console, Custom App, User Authentication) may not
    be accepted by `mcp.box.com` (**unconfirmed**).
- **Redirect URI:** `http://127.0.0.1:47613/callback`. Box lets loopback redirects use any port.
- **Scopes:** `root_readwrite`, `ai.readwrite` (and `docgen.readwrite` with Enterprise Advanced).
- **PKCE:** not documented. The token endpoint has no `code_verifier`.
- **Secret:** required.
- **Review before public use:**
  - Per-enterprise admin setup, as above.
  - Unpublished apps may need a Box admin to enable them.
  - **A single built-in Box client probably can't serve every user.** Leave Box out of
    `oauth-clients.json` unless Box confirms a cross-enterprise client works with its MCP server.
- **Docs:** https://developer.box.com/guides/box-mcp/remote/ ·
  https://developer.box.com/guides/authentication/oauth2/oauth2-setup/ ·
  https://developer.box.com/guides/authorization/platform-app-approval/

### Docusign

- **Where to create it:** a Docusign developer account → Apps and Keys → Add App and Integration Key
  (https://admindemo.docusign.com/apps-and-keys).
- **App type:** Authorization Code Grant.
  - Docusign has a public PKCE variant.
  - But the MCP server page says it accepts tokens from the **Confidential** Authorization Code Grant and
    JWT Grant. Use the confidential grant.
- **Redirect URI:** `http://localhost:47613/callback`, matched exactly (slashes too).
- **Scopes:** `signature`, `spring_read`, `spring_write`, `adm_store_unified_repo_read`, `aow_manage`,
  `models_read`.
- **PKCE:** SahilBot always sends it. Whether the MCP server takes public-grant tokens is **unconfirmed**.
- **Secret:** required (confidential grant).
- **Review before public use:**
  - **Go-Live review** of the integration key (usually 24–48 h), and an allow-list form for the MCP server
    (in beta).
  - Redirect URIs and secrets aren't copied to production; re-enter them there.
  - **A public integration requires joining the Docusign Partner Program.**
  - Account admins must turn on MCP.
- **Docs:** https://developers.docusign.com/platform/mcp-server/ ·
  https://developers.docusign.com/platform/auth/authcode/ · https://developers.docusign.com/platform/go-live/

### Xero

- **Where to create it:** https://developer.xero.com/app/manage → New app.
- **App type:** **Mobile or desktop app** (PKCE). Custom Connections apps can't use MCP.
- **Redirect URI:** `http://localhost:47613/callback`.
  - Xero's PKCE flow allows http only for localhost.
  - Its standard-flow docs say `http://127.0.0.1` can't be used.
  - Matching is exact, with no wildcards.
- **Scopes:** only those for the tools you want the agent to call. Add them as `scopes` if the server's
  advertised set is too broad.
- **PKCE and public client:** yes. "PKCE doesn't need a client secret."
- **Secret:** none.
- **Review before public use:**
  - Remote MCP needs a paid Xero developer plan (Core or above).
  - Starter apps can only connect to the demo org.
  - Connection limits grow by tier: Core 50, Plus 1,000, Advanced 10,000.
  - Apps on Plus and above must be **certified**. Uncertified apps are limited per organisation.
- **Note:** the catalog uses the server Xero's MCP docs give, `https://api.xero.com/mcp/v1` (checked
  2026-11-15: it answers 401 with RFC 9728 sign-in metadata).
- **Docs:** https://developer.xero.com/faq/remote-mcp · https://developer.xero.com/documentation/guides/oauth2/pkce-flow ·
  https://developer.xero.com/pricing

### Zoom

- **Where to create it:** https://marketplace.zoom.us/ → Develop → Build App → **General App**.
  - Under App Credentials, turn on **Use Public Client OAuth**. It issues a separate public client ID with
    no secret.
- **Redirect URI:** register `http://127.0.0.1:47613/callback`, and use that same URI in
  `oauth-clients.json`: `"redirect": "http://127.0.0.1:47613/callback"`.
  - Zoom says to use `127.0.0.1`, not `localhost`, for loopback.
  - The per-user setup steps still show the localhost URI, so existing users' own apps keep working.
  - Zoom ignores only the port when it matches loopback redirects.
  - Its build-flow page warns that loopback URLs may be questioned in Marketplace review.
- **Scopes:** Zoom's granular scopes for the meeting, recording and Docs tools. The list for
  `mcp.zoom.us/mcp/zoom/streamable` is **unconfirmed**; take it from Zoom's MCP page for each product.
- **PKCE and public client:** yes. PKCE is required, and there's no secret and no Authorization header.
- **Secret:** none (public client).
- **Review before public use:**
  - A private app works only inside your own Zoom account.
  - Sharing outside it needs Zoom's beta approval ("Request to share"), which is limited.
  - Public use requires **Zoom Marketplace publishing** (listed or unlisted), with Zoom's app and security
    review.
- **Docs:** https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/ ·
  https://developers.zoom.us/docs/integrations/oauth/ · https://developers.zoom.us/docs/distribute/

### Front

- **Where to create it:** Front → Settings → Company → Developers → Create app (company admins only). Then
  Features → Add feature → **Front MCP**.
- **App type:** Front developer app with the Front MCP feature.
- **Redirect URI:**
  - Front documents `http://localhost/callback` (no port) as matching any local port.
  - Whether `http://localhost:47613/callback` also matches is **unconfirmed**. Register both if the form
    allows it.
- **Scopes:** resource permissions `read`, `write`, and `send` only if sending is wanted. SahilBot asks
  before every send either way.
- **PKCE:** compatible, but the token request must be a confidential client.
- **Secret: required.** Basic authentication at the token endpoint.
- **Review before public use:**
  - Apps are private to the Front instance that created them.
  - To make it public, contact Front's partner team. A published app can't be edited.
  - Users authorizing OAuth apps must be Front admins.
- **Docs:** https://dev.frontapp.com/docs/mcp-server · https://dev.frontapp.com/docs/create-and-manage-apps ·
  https://dev.frontapp.com/docs/oauth

### Crunchbase

- **Where to create it:** Crunchbase → Account Settings → Integrations → MCP → create a custom OAuth client.
  Who can create one, and whether it works for other customers, is **unconfirmed**.
- **Redirect URI:** `http://127.0.0.1:47613/callback`. Matching is exact, with no wildcards. HTTPS is
  required except for localhost and 127.0.0.1.
- **Scopes:** none hard-coded. Crunchbase says to use the scopes in the server's metadata, which is what
  SahilBot does by default.
- **PKCE:** OAuth 2.1 with PKCE. Public clients are **unconfirmed**.
- **Secret:** the docs say to store the client secret, so assume one is issued. Ship it.
- **Review before public use:**
  - Each user needs a Crunchbase MCP seat.
  - Shared or headless use is arranged with Crunchbase Customer Success.
- **Alternative:** Crunchbase supports **Client ID Metadata Documents (CIMD)**, so a client that publishes
  one can connect without registration. SahilBot doesn't do CIMD yet. Adding it would make Crunchbase one
  click without any shipped client.
- **Docs:** https://data.crunchbase.com/docs/building-a-crunchbase-mcp-integration

### Google (Gmail, Calendar, Drive, Docs, Sheets, Slides, BigQuery)

- **Where to create it:**
  - Google Cloud console → create a project.
  - Enable each MCP API (`gmailmcp.googleapis.com`, `calendarmcp.googleapis.com`,
    `drivemcp.googleapis.com`, and so on) and each product API.
  - Google Auth Platform → Branding, Audience, Data access.
  - Clients → Create client.
- **App type:** **Desktop app.** When the console offers it, tick **"Use this client for an AI-powered
  agent"**.
  - Google's Workspace MCP guide shows a Web application client.
  - Its native-app guide and Cloud MCP guide say a Desktop client for apps on the user's machine.
  - SahilBot is a desktop app.
- **Redirect:** `"redirect": "loopback"`. Desktop clients take `http://127.0.0.1:<port>`, and SahilBot
  picks a free port per sign-in.
- **Scopes:**
  - Gmail: `gmail.readonly`, `gmail.compose`.
  - Calendar: `calendar.calendarlist.readonly`, `calendar.events.freebusy`, `calendar.events.readonly`.
  - Drive: `drive.readonly`, `drive.file`.
  - Docs, Sheets and Slides: `drive.readonly`, `drive.file`, plus their own scopes (`documents`,
    `spreadsheets`, `presentations`).
  - BigQuery: `bigquery`. Users also need IAM `roles/mcp.toolUser`.
  - SahilBot asks for what each server advertises.
- **PKCE and public client:** yes. Google calls desktop apps public clients and says to always use PKCE.
- **Secret:** Desktop clients come with a `GOCSPX-…` secret. Ship it as an installed-app secret; Google's
  native-app guide marks it optional.
- **Review before public use:**
  - **Developer Preview:** Google Workspace MCP servers currently require membership in the Google
    Workspace Developer Preview Program.
  - **Testing mode:** at most 100 test users, and authorizations expire 7 days after consent.
  - **Unverified app:** users see the "unverified app" screen, and the app is capped at 100 new users.
  - **Verification:** publish the consent screen and complete **brand verification**.
  - **Restricted scopes need restricted-scope verification:** `gmail.readonly`, `gmail.compose` and
    `drive.readonly`.
    - An app that reaches restricted data "from or through a third-party server" also needs a yearly CASA
      **security assessment**.
    - SahilBot talks to Google's own MCP servers straight from the user's Mac. Whether that path is exempt
      is **unconfirmed**; ask Google during verification.
  - Workspace admins can block high-risk scopes for their users.
- **Docs:** https://developers.google.com/workspace/guides/configure-mcp-servers ·
  https://docs.cloud.google.com/mcp/set-up-authentication-mcp-servers ·
  https://developers.google.com/identity/protocols/oauth2/native-app ·
  https://support.google.com/cloud/answer/13464325 ·
  https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification

### Outlook (Outlook.com and Microsoft 365 mail and calendar)

- **Where to create it:** https://entra.microsoft.com → Applications → App registrations → **New
  registration** (any Microsoft account works; a free Entra tenant is enough).
  - Name: `SahilBot`.
  - Supported account types: **"Accounts in any organizational directory (Any Microsoft Entra ID tenant -
    Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)"**. SahilBot signs in on `/common`, so
    work, school and personal (Outlook.com, Hotmail, Live) accounts all work.
  - Redirect URI: platform **"Public client/native (mobile & desktop)"** (shown later under Authentication as
    **"Mobile and desktop applications"**), URI `http://localhost`. Entra ignores the port of a loopback
    redirect, so SahilBot listens on a free `127.0.0.1` port per sign-in and sends `http://localhost:<port>`.
    Don't register it under **Web** or **Single-page application**: the code exchange then wants a secret
    (AADSTS7000218) or an Origin header.
  - Authentication → **Allow public client flows: Yes** (harmless, and avoids AADSTS7000218 on some tenants).
- **API permissions:** Add a permission → Microsoft Graph → **Delegated**: `Mail.ReadWrite`, `Mail.Send`,
  `Calendars.ReadWrite`, `User.Read`, `offline_access` (plus `openid` and `email`, which are there by
  default). None needs admin consent for personal accounts; a work tenant can still require an admin to
  approve the app.
- **Config entry:** `"outlook": { "clientId": "<Application (client) ID>", "redirect": "loopback" }`.
  - **No secret:** it's a public client. SahilBot refuses an `outlook` entry with a `clientSecret`, and
    Microsoft refuses a secret from a desktop redirect anyway (AADSTS700025).
  - `scopes` can't be set: SahilBot always asks for the list above.
- **PKCE and public client:** yes (S256, per-sign-in `state`, one-shot loopback listener, 5-minute timeout).
- **Tokens:** the refresh token is kept only in the Keychain (`outlook:refreshToken`); access tokens stay in
  memory. Refresh tokens rotate and are saved on each refresh; `invalid_grant` signs the user out and asks
  them to sign in again.
- **Without a built-in client:** Connect apps → Outlook shows these same steps and a client-ID field, so each
  user can register their own free app. With one, "Advanced" still lets them use their own.
- **Review before public use:**
  - **Publisher verification** (Entra → Branding & properties → verified publisher, needs a Microsoft
    Partner Network ID): without it, users see "unverified" on the consent screen, and many work tenants
    block user consent to unverified multitenant apps.
  - Work tenants with user consent turned off need an admin to grant consent once for their organization.
- **Docs:** https://learn.microsoft.com/entra/identity-platform/quickstart-register-app ·
  https://learn.microsoft.com/entra/identity-platform/reply-url#localhost-exceptions ·
  https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow ·
  https://learn.microsoft.com/graph/permissions-reference ·
  https://learn.microsoft.com/entra/identity-platform/publisher-verification-overview

## Summary

| Provider | App type | Redirect to register | Public PKCE client | Secret shipped | Before the public can use it |
| --- | --- | --- | --- | --- | --- |
| Slack | Slack app, PKCE on | `http://localhost:47613/callback` | yes | no | Slack Marketplace listing (MCP refuses unlisted distributed apps) |
| GitHub | OAuth App | `http://127.0.0.1:47613/callback` | no | yes | none (orgs may need to approve the app) |
| Asana | MCP app | `http://localhost:47613/callback` | PKCE yes | yes (to be safe) | "Any workspace" distribution |
| HubSpot | MCP auth app (beta) | `http://localhost:47613/callback` | unconfirmed | yes | Marketplace listing past 25 installs (unconfirmed for MCP apps) |
| Box | per-enterprise admin credentials | `http://127.0.0.1:47613/callback` | no | yes | each enterprise's admin; a shared client likely not possible |
| Docusign | Integration key, confidential auth code | `http://localhost:47613/callback` | no (for MCP) | yes | Go-Live, MCP allow-list, Partner Program |
| Xero | Mobile or desktop app (PKCE) | `http://localhost:47613/callback` | yes | no | paid developer tier, certification on Plus and above |
| Zoom | General app, public client | `http://127.0.0.1:47613/callback` | yes | no | Marketplace publishing and review |
| Front | Developer app + Front MCP | `http://localhost:47613/callback` (+ `http://localhost/callback`) | no | yes | Front partner team to go public |
| Crunchbase | Custom OAuth client (or CIMD) | `http://127.0.0.1:47613/callback` | unconfirmed | likely | MCP seat per user |
| Google | Desktop app client | loopback (any port) | yes | yes (optional per Google) | Developer Preview, verification, restricted-scope verification and CASA |
| Outlook (Microsoft) | Entra app, Mobile and desktop platform | `http://localhost` (any port) | yes | no | publisher verification; admin consent in some work tenants |
