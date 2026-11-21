import { shell } from 'electron'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { ConnectorApiKey, ConnectorConfig, ConnectorPreset, ConnectorSetup, ConnectorStatus, ToolEffect } from '@shared/types'
import { RESEND_KEY_SECRET, verifyResendKey, type Fetch as ResendFetch } from './mail/resend'
import type { ToolRegistry } from './agent/registry'
import type { ToolDef } from './agent/types'
import { CONSEQUENTIAL } from './agent/permissions'
import type { Db } from './db'
import type { Secrets } from './secrets'
import { gmailPolicy, type ToolPolicy } from './mail/gmail'
import { builtinFor, type BuiltinClient, type BuiltinClients } from './oauth-clients'

// MCP connectors: remote servers with OAuth sign-in (browser + loopback callback, tokens in
// the Keychain) and local stdio servers. Each server's tools become agent tools loaded on
// demand through find_tools. Design follows opencode/Cline/OpenClaw MCP OAuth handling (MIT/Apache).

// ---------------------------------------------------------------- catalog
//
// Every remote preset below was verified on 2026-11-15 by the readiness sweep
// (tests/live/connectors-sweep.test.ts; results in docs/connectors-status.md) with read-only HTTPS
// requests: an MCP initialize POST (401 = sign-in required, 200 = open server), then the server's
// RFC 9728 /.well-known/oauth-protected-resource and its authorization server's RFC 8414/OIDC
// metadata (registration endpoint, PKCE S256), plus a DNS check of each icon domain. Nothing was
// registered or signed in. A preset whose server stops working gets `unavailable` (kept, with why).
// "DCR" = the metadata has a registration_endpoint (one click); "no DCR" = the provider needs
// a one-time OAuth app (auth: 'oauth-static', with a setup guide). Evidence is in the comment
// on each line: what answered, and the registration endpoint (or its absence).

/** Fixed loopback port for pre-registered OAuth clients: the redirect URL the user registers has to match exactly. */
export const SETUP_PORT = 47613
/** The redirect URL a pre-registered client uses (RFC 8252 loopback, fixed path). */
export function setupRedirect(host: 'localhost' | '127.0.0.1' = '127.0.0.1'): string {
  return `http://${host}:${SETUP_PORT}/callback`
}

const R = setupRedirect
const S = {
  slack: {
    minutes: 5, needsSecret: false, redirectUri: R('localhost'), idHint: 'Basic Information → App Credentials → Client ID', docs: 'https://docs.slack.dev/ai/slack-mcp-server',
    steps: [
      { title: 'Create a Slack app in your workspace', text: 'Create New App → From scratch → name it "SahilBot" and pick your workspace. Slack only lets internal (or Slack Marketplace) apps use its MCP server, and an app you create in your own workspace is internal.', links: [['Create app', 'https://api.slack.com/apps?new_app=1']] },
      { title: 'Add the redirect URL and turn on PKCE', text: 'OAuth & Permissions → Redirect URLs → Add, paste the URL below, Save URLs. On the same page, turn on PKCE (it marks the app as a desktop app, so no secret is needed).', links: [] },
      { title: 'Add user token scopes', text: 'OAuth & Permissions → User Token Scopes: add search:read.public, search:read.private, search:read.im, search:read.mpim, search:read.users, channels:history, groups:history, im:history, mpim:history, chat:write, users:read, canvases:read, canvases:write. If your app settings show an MCP switch (Agents & AI Apps), turn it on.', links: [] },
      { title: 'Paste the Client ID here', text: 'Basic Information → App Credentials → Client ID. The secret is optional (only if you left PKCE off).', links: [] }
    ]
  },
  asana: {
    minutes: 3, needsSecret: true, redirectUri: R('localhost'), idHint: 'shown after you create the app', docs: 'https://developers.asana.com/docs/connecting-mcp-clients-to-asanas-v2-server',
    steps: [
      { title: 'Create an MCP app in Asana', text: 'Developer console → Create new app → name "SahilBot", app type "MCP app" → Create app.', links: [['Asana developer console', 'https://app.asana.com/0/my-apps']] },
      { title: 'Add the redirect URL', text: 'In the app\'s OAuth settings, add the redirect URL below and save.', links: [] },
      { title: 'Paste the Client ID and Client secret here', text: 'Both are shown on the app page. On Enterprise plans an admin may need to allow the app.', links: [] }
    ]
  },
  hubspot: {
    minutes: 4, needsSecret: true, redirectUri: R('localhost'), idHint: 'the MCP auth app\'s details page', docs: 'https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server',
    steps: [
      { title: 'Create an MCP auth app in HubSpot', text: 'In your HubSpot account open Development → MCP Auth Apps → Create MCP auth app. Name it "SahilBot" and enter the redirect URL below.', links: [['Open HubSpot', 'https://app.hubspot.com/'], ['HubSpot guide', 'https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server']] },
      { title: 'Paste the Client ID and Client secret here', text: 'Copy both from the MCP auth app (not from another kind of HubSpot app).', links: [] }
    ]
  },
  github: {
    minutes: 3, needsSecret: true, redirectUri: R('127.0.0.1'), idHint: 'the OAuth app page, top', docs: 'https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app',
    steps: [
      { title: 'Register a GitHub OAuth app', text: 'Application name "SahilBot", Homepage URL https://github.com, Authorization callback URL = the URL below → Register application. GitHub\'s MCP server doesn\'t let apps register themselves, so this one-time app stands in.', links: [['New OAuth app', 'https://github.com/settings/applications/new']] },
      { title: 'Create a client secret', text: 'On the app page press "Generate a new client secret" and copy it right away (GitHub shows it once).', links: [] },
      { title: 'Paste the Client ID and secret here', text: 'Organizations with OAuth app restrictions may need to approve the app before org repos show up.', links: [] }
    ]
  },
  box: {
    minutes: 5, needsSecret: true, redirectUri: R('127.0.0.1'), idHint: 'Configuration → OAuth 2.0 Credentials', docs: 'https://developer.box.com/guides/box-mcp/remote/',
    steps: [
      { title: 'Create a Box Platform app', text: 'Developer Console → Create Platform App → Custom App → User Authentication (OAuth 2.0), name "SahilBot".', links: [['Box Developer Console', 'https://app.box.com/developers/console']] },
      { title: 'Add the redirect URL and scopes', text: 'Configuration → OAuth 2.0 Redirect URIs: add the URL below. Application Scopes: tick "Read all files and folders" (and "Write all files and folders" if SahilBot should edit). Save.', links: [] },
      { title: 'Paste the Client ID and Client secret here', text: 'Configuration → OAuth 2.0 Credentials. A Box admin may need to enable the Box MCP server (Admin Console → Integrations) or approve the app.', links: [] }
    ]
  },
  docusign: {
    minutes: 6, needsSecret: true, redirectUri: R('localhost'), idHint: 'Integration Key (a UUID)', docs: 'https://www.docusign.com/blog/developers/docusign-mcp-server-general-availability',
    steps: [
      { title: 'Add an app and integration key', text: 'Apps and Keys → Add App and Integration Key → name "SahilBot". Choose Authorization Code Grant and add a secret key (copy it).', links: [['Docusign Apps and Keys (developer)', 'https://admindemo.docusign.com/apps-and-keys']] },
      { title: 'Add the redirect URL', text: 'Under Additional settings → Redirect URIs, add the URL below and save.', links: [] },
      { title: 'Paste the Integration Key and secret here', text: 'The Integration Key is the client ID. For live (non-demo) accounts Docusign requires the key to pass Go-Live review first.', links: [] }
    ]
  },
  xero: {
    minutes: 4, needsSecret: true, redirectUri: R('localhost'), idHint: 'the app\'s Configuration page', docs: 'https://developer.xero.com/documentation/guides/oauth2/auth-flow/',
    steps: [
      { title: 'Create a Xero app', text: 'My Apps → New app → name "SahilBot", integration type "Web app", company URL any of yours, redirect URI = the URL below → Create app.', links: [['Xero My Apps', 'https://developer.xero.com/app/manage']] },
      { title: 'Generate a client secret', text: 'Configuration → Generate a secret, and copy it.', links: [] },
      { title: 'Paste the Client ID and secret here', text: 'Xero matches the redirect URL exactly (no trailing slash).', links: [] }
    ]
  },
  zoom: {
    minutes: 6, needsSecret: true, redirectUri: R('localhost'), idHint: 'Basic Information → App Credentials', docs: 'https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/',
    steps: [
      { title: 'Build a General app on the Zoom Marketplace', text: 'Develop → Build App → General App, user-managed, name "SahilBot". Zoom\'s MCP servers require a registered app (no automatic registration).', links: [['Zoom App Marketplace', 'https://marketplace.zoom.us/'], ['Zoom MCP guide', 'https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/']] },
      { title: 'Add the redirect URL and scopes', text: 'Basic Information → OAuth Information: OAuth Redirect URL = the URL below, and add it to the OAuth allow list. Scopes: add the meeting, cloud recording and Zoom Docs scopes you want SahilBot to use.', links: [] },
      { title: 'Paste the Client ID and Client secret here', text: 'Basic Information → App Credentials.', links: [] }
    ]
  },
  front: {
    minutes: 4, needsSecret: true, redirectUri: R('localhost'), idHint: 'the developer app\'s page', docs: 'https://dev.frontapp.com/docs/mcp-server',
    steps: [
      { title: 'Create a developer app in Front', text: 'Settings → Company → Developer → create an app named "SahilBot". Front\'s MCP server doesn\'t let apps register themselves, so this one-time app stands in.', links: [['Open Front', 'https://app.frontapp.com/'], ['Front MCP guide', 'https://dev.frontapp.com/docs/mcp-server']] },
      { title: 'Add the Front MCP feature and the redirect URL', text: 'In the app\'s Features tab: Add feature → Front MCP. Add the redirect URL below. Under Resource permissions pick read and write; add send only if SahilBot should send messages (it still asks you every time). Save.', links: [] },
      { title: 'Paste the Client ID and Client secret here', text: 'Both are on the app page. Each teammate then signs in to Front with their own account.', links: [] }
    ]
  },
  crunchbase: {
    minutes: 10, needsSecret: false, redirectUri: R('127.0.0.1'), idHint: 'issued by Crunchbase', docs: 'https://data.crunchbase.com/docs',
    steps: [
      { title: 'Ask Crunchbase for an OAuth client', text: 'Crunchbase\'s MCP server only signs in apps it already knows (it offers no self-registration). Ask Crunchbase API support or your account manager for an OAuth client for a desktop app, with the redirect URL below.', links: [['Crunchbase API docs', 'https://data.crunchbase.com/docs']] },
      { title: 'Paste the client ID here', text: 'Add the secret too if Crunchbase gave you one.', links: [] }
    ]
  }
} satisfies Record<string, ConnectorSetup>

export const PRESETS: ConnectorPreset[] = [
  // Connected only by the user's Cursor API key (Settings → Connected apps → Cursor), never by a CLI found on this Mac.
  { id: 'cursor-app', name: 'Cursor', url: 'app:cursor', color: '#111111', category: 'Code', domain: 'cursor.com', auth: 'app', description: 'Hand coding work to Cursor Cloud Agents on your GitHub repos. Connect with your Cursor API key.' },
  { id: 'apple-notes', name: 'Notes, Reminders & Calendar', url: 'app:mac_apps', color: '#F5B400', category: 'Built in', domain: 'apple.com', auth: 'app', description: 'Your Mac\'s own apps; macOS asks once to allow access.' },
  // SahilBot's own research tool (agent/tools/research.ts): PubMed and the other official medical databases, no sign-in.
  { id: 'pubmed', name: 'PubMed & medical sources', url: 'app:research', color: '#20558A', category: 'Built in', domain: 'pubmed.ncbi.nlm.nih.gov', auth: 'app', description: 'PubMed, MeSH, open full text, ClinicalTrials.gov, FDA labels and adverse events, MedlinePlus. No sign-in; cited papers are checked against PubMed.' },
  { id: 'apple-mail', name: 'Mail (all your accounts)', url: 'app:mail', color: '#1A8CFF', category: 'Built in', domain: 'apple.com', auth: 'app', description: 'Apple Mail on this Mac: Gmail, iCloud, Outlook and more, no sign-in. macOS asks once.' },
  // Web automation, by design: the user signs in inside SahilBot's own browser and SahilBot uses the
  // site like they do (no connector, no API). Listed next to the app's real connector, below it.
  { id: 'gmail-web', name: 'Gmail (in SahilBot\'s browser)', url: 'https://mail.google.com/', color: '#EA4335', category: 'Communication', domain: 'mail.google.com/mail/', auth: 'browser', description: 'Sign in inside SahilBot\'s browser; SahilBot uses Gmail on the web like you do.' },
  { id: 'gcal-web', name: 'Google Calendar (in SahilBot\'s browser)', url: 'https://calendar.google.com/', color: '#4285F4', category: 'Productivity', domain: 'calendar.google.com/calendar/', auth: 'browser', description: 'Sign in inside SahilBot\'s browser; SahilBot uses Calendar on the web like you do.' },
  { id: 'gdrive-web', name: 'Google Drive (in SahilBot\'s browser)', url: 'https://drive.google.com/', color: '#0F9D58', category: 'Productivity', domain: 'drive.google.com/drive/', auth: 'browser', description: 'Sign in inside SahilBot\'s browser; SahilBot uses Drive on the web like you do.' },
  { id: 'linkedin-web', name: 'LinkedIn (in SahilBot\'s browser)', url: 'https://www.linkedin.com/', color: '#0A66C2', category: 'Social', auth: 'browser', description: 'Sign in inside SahilBot\'s browser; any site works this way.' },
  // On this Mac: official servers that desktop apps run themselves (no key, nothing downloaded). Only the exact
  // command or loopback address in LOCAL_SERVERS runs under these entries.
  { id: 'xcode', name: 'Xcode', url: 'stdio:xcrun mcpbridge', color: '#147EFB', category: 'On this Mac', domain: 'developer.apple.com', auth: 'none', description: 'Build, test, read and edit the project open in Xcode 26.3 or later.' }, // NEW 2026-11-15: Apple's own bridge (developer.apple.com/documentation/xcode/giving-external-agents-access-to-xcode): `xcrun mcpbridge` over stdio; Xcode → Settings → Intelligence → "Allow external agents to use Xcode tools"
  { id: 'figma-desktop', name: 'Figma (desktop app)', url: 'http://127.0.0.1:3845/mcp', color: '#A259FF', category: 'On this Mac', domain: 'figma.com', auth: 'none', description: 'Design context for your current selection in the Figma desktop app.' }, // NEW 2026-11-15: Figma's local server (developers.figma.com/docs/figma-mcp-server/local-server-installation): http://127.0.0.1:3845/mcp, served by the Figma desktop app once its desktop MCP server is turned on
  // Google's MCP servers: one-time Google setup (a Desktop OAuth client shared by all of them). 2026-11-15: each answers initialize 200, PRM → accounts.google.com (PKCE S256, refresh), no DCR.
  { id: 'gmail', name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1', color: '#EA4335', category: 'Communication', domain: 'mail.google.com/mail/', auth: 'google', description: 'Search, read, label and draft email; sending always asks.' },
  { id: 'gcal', name: 'Google Calendar', url: 'https://calendarmcp.googleapis.com/mcp/v1', color: '#4285F4', category: 'Productivity', domain: 'calendar.google.com/calendar/', auth: 'google', description: 'Events, availability and invites.' },
  { id: 'gdrive', name: 'Google Drive', url: 'https://drivemcp.googleapis.com/mcp/v1', color: '#0F9D58', category: 'Productivity', domain: 'drive.google.com/drive/', auth: 'google', description: 'Find and read Docs, Sheets and files.' },
  // Productivity
  { id: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', color: '#111111', category: 'Productivity', auth: 'oauth', description: 'Pages, databases and comments.' }, // 2026-11-15: 401+PRM, DCR mcp.notion.com/register
  { id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', color: '#5E6AD2', category: 'Productivity', auth: 'oauth', description: 'Issues, projects and cycles.' }, // 2026-11-15: 401+PRM, DCR mcp.linear.app/register
  { id: 'asana', name: 'Asana', url: 'https://mcp.asana.com/v2/mcp', color: '#F06A6A', category: 'Productivity', auth: 'oauth-static', setup: S.asana, description: 'Tasks, projects and portfolios.' }, // 2026-11-15: 401+PRM, AS app.asana.com has no registration_endpoint; Asana docs: V2 needs an "MCP app" (was 'oauth': fixed)
  // Atlassian's current server (v2; v1 answers without RFC 9728 metadata). Also covers Bitbucket and Loom.
  { id: 'atlassian', name: 'Jira & Confluence', url: 'https://mcp.atlassian.com/v2/mcp', color: '#0052CC', category: 'Productivity', domain: 'atlassian.com', auth: 'oauth', description: 'Jira issues, Confluence pages, plus Bitbucket and Loom.' }, // 2026-11-15: 401+PRM /v2/mcp, DCR auth.atlassian.com/…/dcr/register (was /v1/mcp: updated)
  { id: 'monday', name: 'monday.com', url: 'https://mcp.monday.com/mcp', color: '#FF3D57', category: 'Productivity', auth: 'oauth', description: 'Boards, items and updates.' }, // 2026-11-15: 401+PRM, DCR auth.monday.com/oauth_ms/oauth/register
  { id: 'clickup', name: 'ClickUp', url: 'https://mcp.clickup.com/mcp', color: '#7B68EE', category: 'Productivity', auth: 'oauth', description: 'Tasks, docs and spaces.' }, // 2026-11-15: 401+PRM, DCR mcp.clickup.com/oauth/register; no refresh grant listed: re-sign-in on expiry
  { id: 'airtable', name: 'Airtable', url: 'https://mcp.airtable.com/mcp', color: '#18BFFF', category: 'Productivity', auth: 'oauth', description: 'Bases, tables and records.' }, // 2026-11-15: 401+PRM, DCR airtable.com/oauth2/v1/register
  { id: 'todoist', name: 'Todoist', url: 'https://ai.todoist.net/mcp', color: '#E44332', category: 'Productivity', domain: 'todoist.com', auth: 'oauth', description: 'Tasks, projects and due dates.' }, // NEW 2026-11-14, swept 2026-11-15: 401+PRM, DCR todoist.com/oauth/register; Doist's official server (MCP registry)
  { id: 'calendly', name: 'Calendly', url: 'https://mcp.calendly.com/', color: '#006BFF', category: 'Productivity', auth: 'oauth', description: 'Event types, bookings and availability.' }, // NEW 2026-11-14, swept 2026-11-15: 401+PRM, DCR calendly.com/oauth/register
  { id: 'box', name: 'Box', url: 'https://mcp.box.com', color: '#0061D5', category: 'Productivity', auth: 'oauth-static', setup: S.box, description: 'Files and folders in Box.' }, // 2026-11-15: 401+PRM, AS api.box.com has no registration_endpoint; Box docs: pre-registered app (was 'oauth': fixed)
  { id: 'dropbox', name: 'Dropbox', url: 'https://mcp.dropbox.com/mcp', color: '#0061FF', category: 'Productivity', auth: 'oauth', description: 'Files and folders in Dropbox.' }, // 2026-11-15: 401+PRM, DCR dropbox.com/oauth2/register
  { id: 'zapier', name: 'Zapier', url: 'https://mcp.zapier.com/api/mcp/mcp', color: '#FF4F00', category: 'Productivity', auth: 'oauth', description: 'Thousands of app actions via your Zaps.' }, // 2026-11-15: 401+PRM, DCR mcp.zapier.com/api/v1/oauth/register
  { id: 'make', name: 'Make', url: 'https://mcp.make.com/', color: '#6D00CC', category: 'Productivity', auth: 'oauth', description: 'Run and manage your Make scenarios.' }, // NEW 2026-11-14, swept 2026-11-15: 401+PRM, DCR make.com/oauth/v2/register/mcp
  { id: 'granola', name: 'Granola', url: 'https://mcp.granola.ai/mcp', color: '#1E1E1E', category: 'Productivity', domain: 'granola.ai', auth: 'oauth', description: 'Meeting notes and transcripts.' }, // 2026-11-15: 401+PRM, DCR mcp-auth.granola.ai/oauth2/register
  { id: 'fireflies', name: 'Fireflies', url: 'https://mcp.fireflies.ai/mcp', color: '#E1308A', category: 'Productivity', domain: 'fireflies.ai', auth: 'oauth', description: 'Meeting recordings and summaries.' }, // 2026-11-15: 401+PRM, DCR mcp.fireflies.ai/register
  { id: 'jotform', name: 'Jotform', url: 'https://mcp.jotform.com/', color: '#FF6100', category: 'Productivity', auth: 'oauth', description: 'Forms and submissions.' }, // 2026-11-15: 401+PRM, DCR oauth2.jotform.com/register-public-client
  { id: 'docusign', name: 'Docusign', url: 'https://mcp.docusign.com/mcp', color: '#4C00FF', category: 'Productivity', auth: 'oauth-static', setup: S.docusign, description: 'Agreements and envelopes.' }, // 2026-11-15: 401+PRM, AS has no registration_endpoint; Docusign: bring your own integration key (was 'oauth': fixed)
  // NEW 2026-11-15 (URLs from each vendor's listing in Anthropic's connector directory / MCP registry, probed read-only)
  { id: 'trello', name: 'Trello', url: 'https://mcp.trello.com/v1', color: '#0079BF', category: 'Productivity', domain: 'trello.com', auth: 'oauth', description: 'Boards, lists and cards.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR auth.atlassian.com/…/dcr/register (Atlassian-hosted)
  { id: 'coda', name: 'Coda (Superhuman Docs)', url: 'https://docs.superhuman.com/apis/mcp', color: '#EE5A29', category: 'Productivity', domain: 'coda.io', auth: 'oauth', description: 'Docs, pages and tables in Coda / Superhuman Docs.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR id.superhuman.com/tokens/v4/api/oauth2/register; no refresh grant listed: re-sign-in on expiry
  { id: 'readwise', name: 'Readwise', url: 'https://mcp2.readwise.io/mcp', color: '#F4C430', category: 'Productivity', domain: 'readwise.io', auth: 'oauth', description: 'Your highlights, Reader saves and daily review.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR readwise.io/o/register/
  { id: 'egnyte', name: 'Egnyte', url: 'https://mcp-server.egnyte.com/mcp', color: '#00A5A8', category: 'Productivity', domain: 'egnyte.com', auth: 'oauth', description: 'Search and read files in Egnyte.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR mcp-oauth.egnyte.com/clients
  { id: 'guru', name: 'Guru', url: 'https://mcp.api.getguru.com/mcp', color: '#4B4BF7', category: 'Productivity', domain: 'getguru.com', auth: 'oauth', description: 'Search your company knowledge and draft cards.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR mcp.api.getguru.com/oauth/mcp/register
  { id: 'docsend', name: 'DocSend', url: 'https://docsend.com/mcp', color: '#1E7AF0', category: 'Productivity', domain: 'docsend.com', auth: 'oauth', description: 'Data rooms, shared links and who viewed what.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR docsend.com/oauth/register
  { id: 'gdocs', name: 'Google Docs', url: 'https://docsmcp.googleapis.com/mcp/v1', color: '#4285F4', category: 'Productivity', domain: 'docs.google.com/document/', auth: 'google', description: 'Read and edit your Google Docs.' }, // NEW 2026-11-15, swept 2026-11-15: initialize 200, PRM → accounts.google.com (no DCR): uses "Set up Google once"
  { id: 'basecamp', name: 'Basecamp', url: 'https://mcp.basecamp.com/mcp', color: '#1D2D35', category: 'Productivity', domain: 'basecamp.com', auth: 'oauth', description: 'Projects, to-dos, message boards and schedules.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR app.basecamp.com/oauth/clients (DPoP offered, not required); URL from basecamp.com/ai
  // Communication
  { id: 'slack', name: 'Slack', url: 'https://mcp.slack.com/mcp', color: '#4A154B', category: 'Communication', auth: 'oauth-static', setup: S.slack, description: 'Search, read and post in channels.' }, // 2026-11-15: 401+PRM, no registration_endpoint; Slack docs: "We do not support … Dynamic Client Registration" (was 'oauth': fixed)
  { id: 'zoom', name: 'Zoom', url: 'https://mcp.zoom.us/mcp/zoom/streamable', color: '#0B5CFF', category: 'Communication', auth: 'oauth-static', setup: S.zoom, description: 'Meetings, recordings, summaries and Zoom Docs.' }, // NEW 2026-11-14, swept 2026-11-15: 401+PRM (zoom.us), AS zoom.us has no registration_endpoint; Zoom docs: manual client registration
  { id: 'intercom', name: 'Intercom', url: 'https://mcp.intercom.com/mcp', color: '#1F8DED', category: 'Support', auth: 'oauth', description: 'Conversations, tickets and help center articles.' }, // 2026-11-15: 401+PRM, DCR mcp.intercom.com/register (moved to Support 2026-11-15)
  { id: 'livestorm', name: 'Livestorm', url: 'https://mcp.livestorm.co/mcp', color: '#00B37E', category: 'Communication', domain: 'livestorm.co', auth: 'oauth', description: 'Webinars, sessions and registrants.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR mcp.livestorm.co/register
  { id: 'bird', name: 'Bird', url: 'https://mcp.bird.com/', color: '#0E5CFF', category: 'Communication', domain: 'bird.com', auth: 'oauth', description: 'Email, SMS and WhatsApp through your Bird workspace; sending always asks.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR platform.bird.com/v1/oauth/register
  { id: 'superhuman-mail', name: 'Superhuman Mail', url: 'https://mcp.mail.superhuman.com/mcp', color: '#6E56CF', category: 'Communication', domain: 'superhuman.com', auth: 'oauth', description: 'Search, read and draft email in Superhuman; sending always asks.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR mcp.auth.mail.superhuman.com/oauth2/register; URL from help.superhuman.com
  // Native (no MCP server): SahilBot's own resend tool calls Resend's REST API with the user's key (agent/tools/resend.ts).
  { id: 'resend', name: 'Resend', url: 'app:resend', color: '#111111', category: 'Communication', domain: 'resend.com', auth: 'apikey', apiKey: { in: 'header', name: 'Authorization', format: 'Bearer {key}', getKeyUrl: 'https://resend.com/api-keys', hint: 'Resend → API Keys → Create API Key ("Full access", or "Sending access" to only send).', placeholder: 're_…', pattern: '^re_[A-Za-z0-9_-]{8,}$' }, description: 'Email from your own domain: send, check delivery, list verified domains (sending asks unless every recipient is trusted).' }, // resend.com/docs/api-reference/introduction: Authorization: Bearer re_…; verified with GET /domains
  { id: 'mandrill', name: 'Mailchimp Transactional', url: 'https://mandrillapp.com/mcp', color: '#FFE01B', category: 'Communication', domain: 'mandrillapp.com', auth: 'apikey', apiKey: { in: 'header', name: 'Authorization', format: 'Bearer {key}', getKeyUrl: 'https://mandrillapp.com/settings', hint: 'Mandrill → Settings → API Keys → New API Key (a Transactional key, not a Marketing one).' }, description: 'Transactional email: templates, message status and sending (sending always asks).' }, // NEW 2026-11-15, swept 2026-11-15: initialize 200 with JSON-RPC error "Authorization: Bearer <api_key> required"; header from mailchimp.com/developer/transactional/guides/how-to-use-mailchimps-transactional-messaging-mcp/
  // Support
  { id: 'chatbase', name: 'Chatbase', url: 'https://mcp.chatbase.co/api/mcp', color: '#111111', category: 'Support', domain: 'chatbase.co', auth: 'oauth', description: 'Your support agents, their sources, conversations and tickets.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR chatbase.co/api/oauth/register
  { id: 'helpscout', name: 'Help Scout', url: 'https://mcp.helpscout.net/mcp', color: '#1292EE', category: 'Support', domain: 'helpscout.com', auth: 'oauth', description: 'Search conversations and pull support reports (read-only).' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR mcp.helpscout.net/oauth/register; URL from docs.helpscout.com
  { id: 'front', name: 'Front', url: 'https://mcp.frontapp.com/mcp', color: '#A857F1', category: 'Support', domain: 'front.com', auth: 'oauth-static', setup: S.front, description: 'Shared inboxes, conversations and replies; sending always asks.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, AS app.frontapp.com has no registration_endpoint; dev.frontapp.com/docs/mcp-server: "doesn't support Dynamic Client Registration"
  // Design & media
  { id: 'figma', name: 'Figma', url: 'https://mcp.figma.com/mcp', color: '#A259FF', category: 'Design', auth: 'oauth', description: 'Design files and components.' }, // 2026-11-15: 401+PRM, DCR api.figma.com/v1/oauth/mcp/register
  { id: 'canva', name: 'Canva', url: 'https://mcp.canva.com/mcp', color: '#00C4CC', category: 'Design', auth: 'oauth', description: 'Designs, templates and exports.' }, // 2026-11-15: 401+PRM, DCR mcp.canva.com/register
  { id: 'miro', name: 'Miro', url: 'https://mcp.miro.com/', color: '#FFD02F', category: 'Design', auth: 'oauth', description: 'Boards, stickies and diagrams.' }, // 2026-11-15: 401+PRM, DCR mcp.miro.com/register
  { id: 'gamma', name: 'Gamma', url: 'https://mcp.gamma.app/mcp', color: '#7C3AED', category: 'Design', domain: 'gamma.app', auth: 'oauth', description: 'Generate decks and docs.' }, // 2026-11-15: 401+PRM, DCR auth.gamma.app/oauth/register
  { id: 'heygen', name: 'HeyGen', url: 'https://mcp.heygen.com/mcp/v1/', color: '#7559FF', category: 'Media & AI', domain: 'heygen.com', auth: 'oauth', description: 'AI avatar videos and voice, on your plan\'s credits.' }, // NEW 2026-11-14, swept 2026-11-15: 401+PRM /mcp/v1, DCR api2.heygen.com/v1/oauth/register; URL from developers.heygen.com/mcp/overview
  { id: 'hyperframes', name: 'HyperFrames by HeyGen', url: 'https://mcp.heygen.com/mcp/hyperframes', color: '#5B3DF5', category: 'Media & AI', domain: 'heygen.com', auth: 'oauth', description: 'Animated slides and motion-graphics videos made from HTML.' }, // NEW 2026-11-14, swept 2026-11-15: 401+PRM /mcp/hyperframes, DCR api2.heygen.com/v1/oauth/register; MCP registry (the server 307s to /mcp/hyperframes/, same origin, followed)
  { id: 'webflow', name: 'Webflow', url: 'https://mcp.webflow.com/mcp', color: '#4353FF', category: 'Design', auth: 'oauth', description: 'Sites and CMS collections.' }, // 2026-11-15: 401+PRM, DCR mcp.webflow.com/oauth/register
  { id: 'wix', name: 'Wix', url: 'https://mcp.wix.com/mcp', color: '#0C6EFC', category: 'Design', auth: 'oauth', description: 'Sites, stores and bookings.' }, // 2026-11-15: 401+PRM, DCR mcp.wix.com/register
  { id: 'frontify', name: 'Frontify', url: 'https://mcp.frontify-integrations.com/mcp', color: '#2D3232', category: 'Design', domain: 'frontify.com', auth: 'oauth', description: 'Brand guidelines, assets and templates.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR mcp.frontify-integrations.com/oauth/register
  // Media & AI
  { id: 'higgsfield', name: 'Higgsfield', url: 'https://mcp.higgsfield.ai/mcp', color: '#C7F23A', category: 'Media & AI', domain: 'higgsfield.ai', auth: 'oauth', description: 'AI images, video and voice on your plan\'s credits; publishing always asks.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM /mcp, DCR clerk.higgsfield.ai/oauth/register
  { id: 'invideo', name: 'invideo AI', url: 'https://mcp.invideo.io/mcp', color: '#2D6BFF', category: 'Media & AI', domain: 'invideo.io', auth: 'oauth', description: 'AI videos in the invideo editor, on your plan\'s credits.' }, // NEW 2026-11-20: 401+PRM /mcp (probed); URL from help.invideo.io (the old /sse endpoint is retired)
  { id: 'vimeo', name: 'Vimeo', url: 'https://mcp.vimeo.com/mcp', color: '#17D5FF', category: 'Media & AI', domain: 'vimeo.com', auth: 'oauth', description: 'Your Vimeo videos, showcases, stats and uploads; uploads and edits ask.' }, // NEW 2026-11-20: 401+PRM, DCR mcp.vimeo.com/register, PKCE S256 (probed); official server, public beta
  { id: 'descript', name: 'Descript', url: 'https://api.descript.com/v2/mcp', color: '#3D5AFE', category: 'Media & AI', domain: 'descript.com', auth: 'oauth', description: 'Import media and edit video and podcasts with prompts.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM (resource /v2/mcp), DCR auth.descript.com/v1/oauth2/register
  { id: 'picsart', name: 'Picsart Media Studio', url: 'https://api.picsart.com/connectors/media-tools/mcp', color: '#C209C1', category: 'Media & AI', domain: 'picsart.com', auth: 'oauth', description: 'Turn clips and photos into finished videos.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR auth.picsart.com/api/oauth2/register
  // Sales & marketing
  { id: 'hubspot', name: 'HubSpot', url: 'https://mcp.hubspot.com/', color: '#FF7A59', category: 'Sales & marketing', auth: 'oauth-static', setup: S.hubspot, description: 'Contacts, deals and companies.' }, // 2026-11-15: 401+PRM, no registration_endpoint; HubSpot docs: MCP auth app (was 'oauth': fixed)
  { id: 'apollo', name: 'Apollo', url: 'https://mcp.apollo.io/mcp', color: '#2E3A59', category: 'Sales & marketing', auth: 'oauth', description: 'Prospects and enrichment.' }, // 2026-11-15: 401+PRM, DCR mcp.apollo.io/…/register_oauth_client
  { id: 'attio', name: 'Attio', url: 'https://mcp.attio.com/mcp', color: '#111827', category: 'Sales & marketing', auth: 'oauth', description: 'CRM records and lists.' }, // 2026-11-15: 401+PRM, DCR app.attio.com/oauth/register
  { id: 'close', name: 'Close', url: 'https://mcp.close.com/mcp', color: '#3A5BF0', category: 'Sales & marketing', auth: 'oauth', description: 'Leads, calls and pipeline.' }, // 2026-11-15: 401+PRM, DCR api.close.com/oauth2/register/
  { id: 'pipedrive', name: 'Pipedrive', url: 'https://mcp.pipedrive.ai/mcp', color: '#017737', category: 'Sales & marketing', domain: 'pipedrive.com', auth: 'oauth', description: 'Deals, people and activities.' }, // 2026-11-15: 401+PRM, DCR oauth.pipedrive.com/oauth/register (was mcp.pipedrive.com/mcp: no OAuth metadata there; updated)
  { id: 'gong', name: 'Gong', url: 'https://mcp.gong.io/mcp', color: '#8039DF', category: 'Sales & marketing', auth: 'oauth', description: 'Call recordings and insights.' }, // 2026-11-15: 401+PRM, DCR app.gong.io/oauth2/register
  { id: 'klaviyo', name: 'Klaviyo', url: 'https://mcp.klaviyo.com/mcp', color: '#232426', category: 'Sales & marketing', auth: 'oauth', description: 'Email and SMS marketing.' }, // 2026-11-15: 401+PRM, DCR mcp.klaviyo.com/register
  { id: 'semrush', name: 'Semrush', url: 'https://mcp.semrush.com/v1/mcp', color: '#FF642D', category: 'Sales & marketing', auth: 'oauth', description: 'SEO, keywords and traffic.' }, // 2026-11-15: 401+PRM, DCR api.semrush.com/…/oauth2/register
  { id: 'ahrefs', name: 'Ahrefs', url: 'https://api.ahrefs.com/mcp/mcp', color: '#FF8800', category: 'Sales & marketing', auth: 'oauth', description: 'Backlinks and keyword research.' }, // 2026-11-15: 401+PRM, DCR api.ahrefs.com/mcp/register; no refresh grant listed: re-sign-in on expiry
  { id: 'similarweb', name: 'Similarweb', url: 'https://mcp.similarweb.com/mcp', color: '#092540', category: 'Sales & marketing', auth: 'oauth', description: 'Website traffic and market data.' }, // 2026-11-15: 401+PRM, DCR mcp-auth.similarweb.com/register
  { id: 'crunchbase', name: 'Crunchbase', url: 'https://mcp.crunchbase.com/mcp', color: '#146AFF', category: 'Sales & marketing', auth: 'oauth-static', setup: S.crunchbase, description: 'Companies, funding and people.' }, // 2026-11-15: 401+PRM, AS crunchbase.com has no registration_endpoint (client-ID metadata documents only) (was 'oauth': fixed)
  { id: 'buffer', name: 'Buffer', url: 'https://mcp.buffer.com/mcp', color: '#231F20', category: 'Social', domain: 'buffer.com', auth: 'oauth', description: 'Draft, queue and schedule social posts; publishing asks.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR auth.buffer.com/reg; URL from developers.buffer.com
  { id: 'brevo', name: 'Brevo', url: 'https://mcp.brevo.com/v1/brevo/mcp', color: '#0B996E', category: 'Sales & marketing', domain: 'brevo.com', auth: 'apikey', apiKey: { in: 'header', name: 'Authorization', format: 'Bearer {key}', getKeyUrl: 'https://app.brevo.com/settings/keys/api', hint: 'Account → SMTP & API → API Keys → Generate a new key, and tick the MCP option.' }, description: 'Contacts, lists, email and SMS campaigns; sending always asks.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM /v1/brevo/mcp; developers.brevo.com/docs/mcp-protocol: "Authorization: Bearer <MCP token>" (2026-11-15: the server also advertises OAuth DCR at mcp.brevo.com/oauth, not in Brevo's docs: kept on the documented key) Re-probed 2026-11-15: AS mcp.brevo.com/oauth has DCR + S256 + public clients, but developers.brevo.com/docs/mcp-protocol documents only the MCP token (OAuth is described only for Brevo's own Claude/ChatGPT connectors, with fewer tools): stays apikey until Brevo documents OAuth for MCP clients.
  { id: 'supermetrics', name: 'Supermetrics', url: 'https://mcp.supermetrics.com/mcp', color: '#4B2FD6', category: 'Sales & marketing', domain: 'supermetrics.com', auth: 'oauth', description: 'Ad, SEO and social reporting: Google, Meta, TikTok, LinkedIn Ads and more.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR api.supermetrics.com/oauth/register
  { id: 'crustdata', name: 'Crustdata', url: 'https://mcp.crustdata.com/mcp', color: '#0A0A0A', category: 'Sales & marketing', domain: 'crustdata.com', auth: 'oauth', description: 'Search and enrich company and people data.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR mcp.crustdata.com/register
  { id: 'replicate', name: 'Replicate', url: 'https://mcp.replicate.com/sse', color: '#202020', category: 'Media & AI', domain: 'replicate.com', auth: 'oauth', description: 'Run AI models for images, video, audio and text; runs bill your account.' }, // NEW 2026-11-15, swept 2026-11-15: 401 (/sse), PRM resource mcp.replicate.com, DCR mcp.replicate.com/register; URL from replicate.com/docs/reference/mcp
  { id: 'runway', name: 'Runway', url: 'https://mcp.runwayml.com/mcp', color: '#0A0A0A', category: 'Media & AI', domain: 'runwayml.com', auth: 'oauth', description: 'Generate and edit video and images on your Runway credits.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR mcp.runwayml.com/register; URL from runwayml.com/mcp
  // Social
  { id: 'typefully', name: 'Typefully', url: 'https://mcp.typefully.com/mcp', color: '#1D9BF0', category: 'Social', domain: 'typefully.com', auth: 'oauth', description: 'Draft and schedule posts for X, LinkedIn, Threads, Bluesky and more; publishing asks.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR api.typefully.com/oauth2/register
  { id: 'metricool', name: 'Metricool', url: 'https://ai.metricool.com/mcp', color: '#2C2C80', category: 'Social', domain: 'metricool.com', auth: 'oauth', description: 'Social analytics, best times to post and scheduled posts.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR app.metricool.com/oauth/register
  { id: 'windsor-social', name: 'Windsor.ai Social', url: 'https://mcp.windsor.ai/social_media', color: '#1F3B73', category: 'Social', domain: 'windsor.ai', auth: 'oauth', description: 'Organic social stats and posts across Instagram, Facebook, TikTok, YouTube and LinkedIn.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR mcp.windsor.ai/social_media/register
  // Finance & commerce
  { id: 'stripe', name: 'Stripe', url: 'https://mcp.stripe.com', color: '#635BFF', category: 'Finance & commerce', auth: 'oauth', description: 'Payments, customers and invoices.' }, // 2026-11-15: 401+PRM, DCR access.stripe.com/mcp/oauth2/register
  { id: 'paypal', name: 'PayPal', url: 'https://mcp.paypal.com/mcp', color: '#003087', category: 'Finance & commerce', auth: 'oauth', description: 'Invoices, orders and disputes.' }, // 2026-11-15: 401+PRM, DCR mcp.paypal.com/register
  { id: 'square', name: 'Square', url: 'https://mcp.squareup.com/mcp', color: '#3E4348', category: 'Finance & commerce', domain: 'squareup.com', auth: 'oauth', description: 'Payments, orders and catalog.' }, // 2026-11-15: 401+PRM /mcp (Streamable HTTP), DCR mcp.squareup.com/register (was /sse: moved to the streamable endpoint)
  { id: 'plaid', name: 'Plaid', url: 'https://mcp.plaid.com/mcp', color: '#111111', category: 'Finance & commerce', auth: 'oauth', description: 'Your Plaid developer dashboard: items, logs and usage.' }, // 2026-11-15: 401+PRM, DCR api.dashboard.plaid.com/oauth/register
  { id: 'xero', name: 'Xero', url: 'https://api.xero.com/mcp/v1', color: '#13B5EA', category: 'Finance & commerce', auth: 'oauth-static', setup: S.xero, description: 'Accounting: invoices and contacts.' }, // 2026-11-15: Xero's docs list api.xero.com/mcp/v1; 401 + RFC 9728 resource_metadata (api.xero.com/.well-known/oauth-protected-resource/mcp/v1). The older mcp.xero.com/mcp answers 401 without it.
  { id: 'mercury', name: 'Mercury', url: 'https://mcp.mercury.com/mcp', color: '#5266EB', category: 'Finance & commerce', domain: 'mercury.com', auth: 'oauth', description: 'Accounts, transactions and cash flow; payments always ask.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR mcp.mercury.com/register
  { id: 'brex', name: 'Brex', url: 'https://api.brex.com/mcp', color: '#F46A35', category: 'Finance & commerce', domain: 'brex.com', auth: 'oauth', description: 'Your cards, expenses, limits and policy.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM (resource api.brex.com), DCR api.brex.com/v3/clients
  { id: 'mollie', name: 'Mollie', url: 'https://mcp.mollie.com/mcp', color: '#0A0A0A', category: 'Finance & commerce', domain: 'mollie.com', auth: 'oauth', description: 'Payments, refunds, subscriptions and settlements.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR api.mollie.com/oauth2/register
  { id: 'navan', name: 'Navan', url: 'https://mcp.navan.com/mcp', color: '#0B2A4A', category: 'Finance & commerce', domain: 'navan.com', auth: 'oauth', description: 'Travel and expense data from Navan.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR login.navan.com/oidc/register
  { id: 'bigcommerce', name: 'BigCommerce', url: 'https://api.bigcommerce.com/mcp', color: '#121118', category: 'Finance & commerce', domain: 'bigcommerce.com', auth: 'oauth', description: 'Your store\'s products, orders and customers (early access; turn on MCP in store settings).' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR login.bigcommerce.com/oauth/register; URL from docs.bigcommerce.com/developer/api-reference/mcp/overview
  // Code
  { id: 'github', name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', color: '#24292F', category: 'Code', domain: 'github.com', auth: 'oauth-static', setup: S.github, description: 'Repos, issues and pull requests.' }, // 2026-11-15: 401+PRM, AS github.com/login/oauth has no registration_endpoint; GitHub host guide: DCR not supported (was 'oauth': fixed)
  { id: 'sentry', name: 'Sentry', url: 'https://mcp.sentry.dev/mcp', color: '#362D59', category: 'Code', domain: 'sentry.io', auth: 'oauth', description: 'Errors and performance issues.' }, // 2026-11-15: 401+PRM, DCR mcp.sentry.dev/oauth/register
  { id: 'vercel', name: 'Vercel', url: 'https://mcp.vercel.com', color: '#000000', category: 'Code', domain: 'vercel.com', auth: 'oauth', description: 'Deployments, logs and domains.' }, // 2026-11-15: 401+PRM, DCR api.vercel.com/login/oauth/register
  { id: 'netlify', name: 'Netlify', url: 'https://mcp.netlify.com/mcp', color: '#00AD9F', category: 'Code', auth: 'oauth', description: 'Sites and deploys.' }, // 2026-11-15: 401+PRM, DCR mcp.netlify.com/oauth-server/reg
  { id: 'cloudflare', name: 'Cloudflare', url: 'https://mcp.cloudflare.com/mcp', color: '#F38020', category: 'Code', domain: 'cloudflare.com', auth: 'oauth', description: 'The whole Cloudflare API: Workers, DNS, R2, KV, D1 and more.' }, // NEW 2026-11-14, swept 2026-11-15: 401+PRM, DCR mcp.cloudflare.com/register (Cloudflare's recommended server; bindings.mcp is deprecated)
  { id: 'cloudflare-observability', name: 'Cloudflare Observability', url: 'https://observability.mcp.cloudflare.com/mcp', color: '#F38020', category: 'Code', domain: 'cloudflare.com', auth: 'oauth', description: 'Workers logs and analytics.' }, // NEW 2026-11-14, swept 2026-11-15: 401+PRM, DCR observability.mcp.cloudflare.com/register
  { id: 'cloudflare-docs', name: 'Cloudflare Docs', url: 'https://docs.mcp.cloudflare.com/mcp', color: '#F38020', category: 'Code', domain: 'developers.cloudflare.com', auth: 'none', description: 'Cloudflare developer docs. No sign-in.' }, // NEW 2026-11-14, swept 2026-11-15: initialize 200, open
  { id: 'cloudflare-browser', name: 'Cloudflare Browser Rendering', url: 'https://browser.mcp.cloudflare.com/mcp', color: '#F38020', category: 'Code', domain: 'cloudflare.com', auth: 'oauth', description: 'Fetch pages, screenshots and markdown through Cloudflare\'s browsers.' }, // NEW 2026-11-20: 401+PRM /mcp (probed)
  { id: 'cloudflare-builds', name: 'Cloudflare Workers Builds', url: 'https://builds.mcp.cloudflare.com/mcp', color: '#F38020', category: 'Code', domain: 'cloudflare.com', auth: 'oauth', description: 'Build history and logs for Workers.' }, // NEW 2026-11-20: 401+PRM /mcp (probed)
  { id: 'cloudflare-ai-gateway', name: 'Cloudflare AI Gateway', url: 'https://ai-gateway.mcp.cloudflare.com/mcp', color: '#F38020', category: 'Code', domain: 'cloudflare.com', auth: 'oauth', description: 'AI Gateway logs, prompts and responses.' }, // NEW 2026-11-20: 401+PRM /mcp (probed)
  { id: 'cloudflare-autorag', name: 'Cloudflare AutoRAG', url: 'https://autorag.mcp.cloudflare.com/mcp', color: '#F38020', category: 'Code', domain: 'cloudflare.com', auth: 'oauth', description: 'Search your AutoRAG document indexes.' }, // NEW 2026-11-20: 401+PRM /mcp (probed)
  { id: 'cloudflare-auditlogs', name: 'Cloudflare Audit Logs', url: 'https://auditlogs.mcp.cloudflare.com/mcp', color: '#F38020', category: 'Code', domain: 'cloudflare.com', auth: 'oauth', description: 'Who changed what in your Cloudflare account.' }, // NEW 2026-11-20: 401+PRM /mcp (probed)
  { id: 'cloudflare-dns-analytics', name: 'Cloudflare DNS Analytics', url: 'https://dns-analytics.mcp.cloudflare.com/mcp', color: '#F38020', category: 'Code', domain: 'cloudflare.com', auth: 'oauth', description: 'DNS query analytics and performance.' }, // NEW 2026-11-20: 401+PRM /mcp (probed)
  { id: 'cloudflare-logpush', name: 'Cloudflare Logpush', url: 'https://logs.mcp.cloudflare.com/mcp', color: '#F38020', category: 'Code', domain: 'cloudflare.com', auth: 'oauth', description: 'Logpush job health and summaries.' }, // NEW 2026-11-20: 401+PRM /mcp (probed)
  { id: 'cloudflare-graphql', name: 'Cloudflare GraphQL', url: 'https://graphql.mcp.cloudflare.com/mcp', color: '#F38020', category: 'Code', domain: 'cloudflare.com', auth: 'oauth', description: 'Analytics through Cloudflare\'s GraphQL API.' }, // NEW 2026-11-20: 401+PRM /mcp (probed)
  { id: 'cloudflare-containers', name: 'Cloudflare Containers', url: 'https://containers.mcp.cloudflare.com/mcp', color: '#F38020', category: 'Code', domain: 'cloudflare.com', auth: 'oauth', description: 'A sandbox container to run code; running anything asks.' }, // NEW 2026-11-20: 401+PRM /mcp (probed)
  { id: 'cloudflare-casb', name: 'Cloudflare CASB', url: 'https://casb.mcp.cloudflare.com/mcp', color: '#F38020', category: 'Code', domain: 'cloudflare.com', auth: 'oauth', description: 'SaaS security findings across your connected apps.' }, // NEW 2026-11-20: 401+PRM /mcp (probed)
  { id: 'supabase', name: 'Supabase', url: 'https://mcp.supabase.com/mcp', color: '#3ECF8E', category: 'Code', auth: 'oauth', description: 'Databases, auth and storage.' }, // 2026-11-15: 401+PRM, DCR api.supabase.com/platform/oauth/apps/register
  { id: 'neon', name: 'Neon', url: 'https://mcp.neon.tech/mcp', color: '#00E599', category: 'Code', auth: 'oauth', description: 'Serverless Postgres.' }, // 2026-11-15: 401+PRM, DCR mcp.neon.tech/api/register
  { id: 'huggingface', name: 'Hugging Face', url: 'https://huggingface.co/mcp', color: '#FFD21E', category: 'Code', domain: 'huggingface.co', auth: 'oauth', description: 'Models, datasets and Spaces.' }, // 2026-11-15: initialize 200 (anonymous works), DCR huggingface.co/oauth/register
  { id: 'deepwiki', name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', color: '#0F172A', category: 'Code', auth: 'none', description: 'Explains any public GitHub repo. No sign-in.' }, // 2026-11-15: initialize 200, open
  { id: 'context7', name: 'Context7', url: 'https://mcp.context7.com/mcp', color: '#059669', category: 'Code', auth: 'none', description: 'Up-to-date library docs. No sign-in.' }, // 2026-11-15: initialize 200, open
  { id: 'mslearn', name: 'Microsoft Learn', url: 'https://learn.microsoft.com/api/mcp', color: '#0078D4', category: 'Code', domain: 'learn.microsoft.com', auth: 'none', description: 'Official Microsoft docs. No sign-in.' }, // 2026-11-15: initialize 200, open
  { id: 'railway', name: 'Railway', url: 'https://mcp.railway.com/', color: '#0B0D0E', category: 'Code', domain: 'railway.com', auth: 'oauth', description: 'Deploy and debug apps, databases and logs on Railway.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR backboard.railway.com/oauth/register
  { id: 'postman', name: 'Postman', url: 'https://mcp.postman.com/minimal', color: '#FF6C37', category: 'Code', domain: 'postman.com', auth: 'oauth', description: 'Workspaces, collections, specs and environments.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM /minimal, DCR mcp.postman.com/register
  { id: 'grafana', name: 'Grafana Cloud', url: 'https://mcp.grafana.com/mcp', color: '#F46800', category: 'Code', domain: 'grafana.com', auth: 'oauth', description: 'Metrics, logs, traces, dashboards and alerts.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR mcp.grafana.com/mcp/oauth/register
  { id: 'honeycomb', name: 'Honeycomb', url: 'https://mcp.honeycomb.io/mcp', color: '#FFB000', category: 'Code', domain: 'honeycomb.io', auth: 'oauth', description: 'Query traces, datasets and SLOs (US region).' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR ui.honeycomb.io/oauth/register
  { id: 'circleci', name: 'CircleCI', url: 'https://mcp.circleci.com/v1/mcp', color: '#343434', category: 'Code', domain: 'circleci.com', auth: 'oauth', description: 'Pipelines, failed builds, logs and flaky tests.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR app.circleci.com/oauth/register; no refresh grant listed: re-sign-in on expiry
  { id: 'planetscale', name: 'PlanetScale', url: 'https://mcp.pscale.dev/mcp/planetscale', color: '#000000', category: 'Code', domain: 'planetscale.com', auth: 'oauth', description: 'Your Postgres and MySQL databases, branches and schema.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR auth.planetscale.com/oauth/registration
  { id: 'betterstack', name: 'Better Stack', url: 'https://mcp.betterstack.com/', color: '#2F2F7A', category: 'Code', domain: 'betterstack.com', auth: 'oauth', description: 'Logs, metrics, uptime monitors and incidents.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR betterstack.com/oauth/register
  { id: 'mapbox', name: 'Mapbox', url: 'https://mcp.mapbox.com/mcp', color: '#4264FB', category: 'Code', domain: 'mapbox.com', auth: 'oauth', description: 'Geocoding, place search, routing and maps.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR api.mapbox.com/oauth/register
  { id: 'gitlab', name: 'GitLab', url: 'https://gitlab.com/api/v4/mcp', color: '#FC6D26', category: 'Code', domain: 'gitlab.com', auth: 'oauth', description: 'Projects, issues, merge requests and pipelines on GitLab.com.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR gitlab.com/oauth/register; URL from docs.gitlab.com/user/model_context_protocol/mcp_server/
  { id: 'buildkite', name: 'Buildkite', url: 'https://mcp.buildkite.com/mcp', color: '#14CC80', category: 'Code', domain: 'buildkite.com', auth: 'oauth', description: 'Pipelines, builds, jobs, logs and test results.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR mcp.buildkite.com/oauth/register; URL from buildkite.com/docs/apis/mcp-server
  { id: 'prisma', name: 'Prisma Postgres', url: 'https://mcp.prisma.io/mcp', color: '#2D3748', category: 'Code', domain: 'prisma.io', auth: 'oauth', description: 'Create and manage Prisma Postgres databases, backups and queries.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR auth.prisma.io/register; URL from prisma.io/docs/ai/tools/mcp-server
  { id: 'datadog', name: 'Datadog', url: 'https://mcp.datadoghq.com/v1/mcp', color: '#632CA6', category: 'Code', domain: 'datadoghq.com', auth: 'oauth', description: 'Logs, metrics, traces, monitors and incidents (US1 site; an admin turns on MCP access).' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR app.datadoghq.com/api/v2/oauth2/register; URL from docs.datadoghq.com/bits_ai/mcp_server/setup
  { id: 'render', name: 'Render', url: 'https://mcp.render.com/mcp', color: '#8A05FF', category: 'Code', domain: 'render.com', auth: 'apikey', apiKey: { in: 'header', name: 'Authorization', format: 'Bearer {key}', getKeyUrl: 'https://dashboard.render.com/u/settings?add-api-key', hint: 'Account Settings → API Keys → Create API Key.', placeholder: 'rnd_…' }, description: 'Services, deploys, logs, metrics and databases on Render.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, AS api.render.com has no registration_endpoint; render.com/docs/mcp-server: header "Authorization: Bearer <YOUR_API_KEY>" Re-probed 2026-11-15: still no registration_endpoint (S256, public clients); render.com/docs/mcp-server documents OAuth for Render's own plugins and API keys: stays apikey.
  { id: 'pagerduty', name: 'PagerDuty', url: 'https://mcp.pagerduty.com/mcp', color: '#06AC38', category: 'Code', domain: 'pagerduty.com', auth: 'apikey', apiKey: { in: 'header', name: 'Authorization', format: 'Token token={key}', getKeyUrl: 'https://support.pagerduty.com/main/docs/api-access-keys', hint: 'In PagerDuty: My Profile → User Settings → Create API User Token (US service region).' }, description: 'Incidents, services and on-call; paging people always asks.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, AS app.pagerduty.com has no registration_endpoint; docs.pagerduty.com/developer/mcp-tooling-remote-server: "Authorization": "Token token=<key>" Re-probed 2026-11-15: still no registration_endpoint; PagerDuty documents API tokens and pre-registered Scoped OAuth apps (127.0.0.1 redirects): stays apikey.
  // Data & analytics
  { id: 'posthog', name: 'PostHog', url: 'https://mcp.posthog.com/mcp', color: '#F54E00', category: 'Data & analytics', auth: 'oauth', description: 'Product analytics and flags.' }, // 2026-11-15: 401+PRM, DCR oauth.posthog.com/oauth/register/
  { id: 'amplitude', name: 'Amplitude', url: 'https://mcp.amplitude.com/mcp', color: '#1E61F0', category: 'Data & analytics', auth: 'oauth', description: 'Product analytics.' }, // 2026-11-15: 401+PRM, DCR mcp.amplitude.com/register
  { id: 'mixpanel', name: 'Mixpanel', url: 'https://mcp.mixpanel.com/mcp', color: '#7856FF', category: 'Data & analytics', auth: 'oauth', description: 'Events, funnels and dashboards (US data region).' }, // NEW 2026-11-14, swept 2026-11-15: 401+PRM, DCR mixpanel.com/oauth/mcp/register/ (EU projects: mcp-eu.mixpanel.com, also DCR, as a custom server)
  { id: 'cloudflare-radar', name: 'Cloudflare Radar', url: 'https://radar.mcp.cloudflare.com/mcp', color: '#F38020', category: 'Data & analytics', domain: 'radar.cloudflare.com', auth: 'oauth', description: 'Internet traffic trends, outages and attacks.' }, // NEW 2026-11-14, swept 2026-11-15: 401+PRM, DCR radar.mcp.cloudflare.com/register
  { id: 'vanta', name: 'Vanta', url: 'https://mcp.vanta.com/mcp', color: '#5E2DE5', category: 'Data & analytics', auth: 'oauth', description: 'Compliance tests, controls and evidence.' }, // NEW 2026-11-14, swept 2026-11-15: 401+PRM, DCR api.vanta.com/oauth/register
  { id: 'bigquery', name: 'BigQuery', url: 'https://bigquery.googleapis.com/mcp', color: '#4285F4', category: 'Data & analytics', domain: 'cloud.google.com', auth: 'google', description: 'Datasets, tables and SQL queries in your Google Cloud.' }, // NEW 2026-11-15, swept 2026-11-15: initialize 200, PRM → accounts.google.com (no DCR): uses "Set up Google once"
  { id: 'alphavantage', name: 'Alpha Vantage', url: 'https://mcp.alphavantage.co/mcp', color: '#1A8F5A', category: 'Data & analytics', domain: 'alphavantage.co', auth: 'oauth', description: 'Stock, forex, crypto and economic data, fundamentals and news.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR mcp.alphavantage.co/register
  { id: 'hex', name: 'Hex', url: 'https://app.hex.tech/mcp', color: '#473982', category: 'Data & analytics', domain: 'hex.tech', auth: 'oauth', description: 'Ask the Hex agent questions over your data and projects (Team plan and up).' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR auth.app.hex.tech/oauth2/register; URL from learn.hex.tech/docs/administration/mcp-server
  { id: 'pendo', name: 'Pendo', url: 'https://app.pendo.io/mcp/v0/shttp', color: '#E01F5D', category: 'Data & analytics', domain: 'pendo.io', auth: 'oauth', description: 'Product usage, accounts, guides and segments (US region; an admin turns on AI access).' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR app.pendo.io/oauth/v1/register; URL from support.pendo.io
  // Research
  { id: 'exa', name: 'Exa search', url: 'https://mcp.exa.ai/mcp', color: '#1F40ED', category: 'Research', auth: 'none', description: 'High-quality web search and page contents. No sign-in.' }, // 2026-11-15: initialize 200, open
  { id: 'perplexity', name: 'Perplexity', url: 'https://api.perplexity.ai/mcp', color: '#20808D', category: 'Research', domain: 'perplexity.ai', auth: 'oauth', description: 'Web-grounded answers and search with citations (bills your API account).' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM (resource api.perplexity.ai), DCR api.perplexity.ai/oauth/register; URL from docs.perplexity.ai
  { id: 'tavily', name: 'Tavily', url: 'https://mcp.tavily.com/mcp', color: '#4F46E5', category: 'Research', domain: 'tavily.com', auth: 'oauth', description: 'Web search, extract, crawl and research.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM, DCR mcp.tavily.com/register
  { id: 'firecrawl', name: 'Firecrawl', url: 'https://mcp.firecrawl.dev/v2/mcp-oauth', color: '#FA5D19', category: 'Research', domain: 'firecrawl.dev', auth: 'oauth', description: 'Search the web and scrape pages into clean text.' }, // NEW 2026-11-15, swept 2026-11-15: 401+PRM /v2/mcp-oauth (docs.firecrawl.dev/mcp-server: OAuth variant), DCR firecrawl.dev/api/oauth/register
  { id: 'parallel', name: 'Parallel Search', url: 'https://search.parallel.ai/mcp', color: '#111111', category: 'Research', domain: 'parallel.ai', auth: 'none', description: 'Free web search and page fetch. No sign-in.' }, // NEW 2026-11-15, swept 2026-11-15: initialize 200, open
  // ---- NEW 2026-11-15, batch 2: 69 more official remote servers. Each URL comes from the vendor's own docs, the official
  // MCP registry (registry.modelcontextprotocol.io, vendor-namespaced entry) or Anthropic's connector directory; each was
  // probed read-only like the sweep (initialize, RFC 9728, RFC 8414, DCR, PKCE S256) and no client was registered.
  // Productivity
  { id: 'craft', name: 'Craft', url: 'https://mcp.craft.do/my/mcp', color: '#3478F6', category: 'Productivity', domain: 'craft.do', auth: 'oauth', description: 'Notes, docs and tasks in Craft.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR mcp.craft.do/my/auth/register; URL from MCP registry do.craft.mcp/server
  { id: 'evernote', name: 'Evernote', url: 'https://mcp.evernote.com/mcp', color: '#00A82D', category: 'Productivity', domain: 'evernote.com', auth: 'oauth', description: 'Search, read and create notes (paid plans; beta).' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR accounts.evernote.com/auth/register; URL from help.evernote.com "Evernote MCP"
  { id: 'otter', name: 'Otter.ai', url: 'https://mcp.otter.ai/mcp', color: '#1F5EFF', category: 'Productivity', domain: 'otter.ai', auth: 'oauth', description: 'Meeting transcripts and summaries from Otter.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR otter.ai/oauth/register; URL from Anthropic's connector directory
  { id: 'fathom', name: 'Fathom', url: 'https://api.fathom.ai/mcp', color: '#6C47FF', category: 'Productivity', domain: 'fathom.ai', auth: 'oauth', description: 'Meeting notes, summaries and transcripts.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR api.fathom.ai/mcp/oauth/register; URL from MCP registry ai.fathom.api/mcp
  { id: 'tldv', name: 'tl;dv', url: 'https://mcp.tldv.io/mcp', color: '#7F56D9', category: 'Productivity', domain: 'tldv.io', auth: 'oauth', description: 'Meeting recordings, notes and transcripts.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR keycloak.tldv.io/realms/mcp.tldv.io/clients-registrations/openid-connect; URL from Anthropic's connector directory
  { id: 'typeform', name: 'Typeform', url: 'https://api.typeform.com/mcp', color: '#262627', category: 'Productivity', domain: 'typeform.com', auth: 'oauth', description: 'Forms, quizzes and their responses.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR api.typeform.com/oauth/register; URL from MCP registry com.typeform/typeform (US; EU: api.eu.typeform.com/mcp)
  { id: 'gsheets', name: 'Google Sheets', url: 'https://sheetsmcp.googleapis.com/mcp/v1', color: '#0F9D58', category: 'Productivity', domain: 'docs.google.com/spreadsheets/', auth: 'google', description: 'Read and update your Google Sheets.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: initialize 200, PRM → accounts.google.com (no DCR): uses "Set up Google once"; URL from Anthropic's connector directory
  { id: 'gslides', name: 'Google Slides', url: 'https://slidesmcp.googleapis.com/mcp/v1', color: '#F4B400', category: 'Productivity', domain: 'docs.google.com/presentation/', auth: 'google', description: 'Read and edit your Google Slides.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: initialize 200, PRM → accounts.google.com (no DCR): uses "Set up Google once"; URL from Anthropic's connector directory
  // Communication
  { id: 'ringcentral', name: 'RingCentral Team Chat', url: 'https://mcp.labs.ringcentral.com/ringex/v1.1.0/team-chat', color: '#FF7A00', category: 'Communication', domain: 'ringcentral.com', auth: 'oauth', description: 'Team chat messages, teams and people; posting always asks.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR mcp.labs.ringcentral.com/ringex/team-chat/oauth/register; URL from Anthropic's connector directory (RingCentral Labs)
  // Support
  { id: 'pylon', name: 'Pylon', url: 'https://mcp.usepylon.com/', color: '#5E5CE6', category: 'Support', domain: 'usepylon.com', auth: 'oauth', description: 'Customer support issues, accounts and contacts.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR o.auth.usepylon.com/oauth2/register; URL from Anthropic's connector directory
  // Design
  { id: 'lucid', name: 'Lucid', url: 'https://mcp.lucid.app/mcp', color: '#F96B13', category: 'Design', domain: 'lucid.co', auth: 'oauth', description: 'Diagrams, flowcharts, org charts and mind maps in Lucidchart.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR mcp.lucid.app/oauth/register; URL from MCP registry app.lucid.mcp/lucid
  { id: 'mural', name: 'Mural', url: 'https://mcp-canvas.mural.co/mcp', color: '#FF4B4B', category: 'Design', domain: 'mural.co', auth: 'oauth', description: 'Whiteboards, stickies and workshop boards.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR mcp-canvas.mural.co/register; URL from MCP registry co.mural/mural
  { id: 'excalidraw', name: 'Excalidraw', url: 'https://mcp.excalidraw.com/mcp', color: '#6965DB', category: 'Design', domain: 'excalidraw.com', auth: 'none', description: 'Hand-drawn style diagrams and sketches. No sign-in.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: initialize 200 (Excalidraw), open; URL from Anthropic's connector directory
  // Media & AI
  { id: 'cloudinary', name: 'Cloudinary', url: 'https://asset-management.mcp.cloudinary.com/mcp', color: '#3448C5', category: 'Media & AI', domain: 'cloudinary.com', auth: 'oauth', description: 'Upload, find, transform and deliver images and videos.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR asset-management.mcp.cloudinary.com/register; URL from MCP registry com.cloudinary/asset-management-mcp
  { id: 'lottiefiles', name: 'LottieFiles', url: 'https://creator.mcp.lottiefiles.com/mcp', color: '#00DDB3', category: 'Media & AI', domain: 'lottiefiles.com', auth: 'oauth', description: 'Create and edit Lottie animations.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR creator.mcp.lottiefiles.com/register; URL from MCP registry com.lottiefiles/creator
  // Code
  { id: 'jam', name: 'Jam', url: 'https://mcp.jam.dev/mcp', color: '#E8487F', category: 'Code', domain: 'jam.dev', auth: 'oauth', description: 'Bug reports with console logs, network requests and screen recordings.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR api.jam.dev/oauth/register; URL from MCP registry dev.jam/jam
  { id: 'newrelic', name: 'New Relic', url: 'https://mcp.newrelic.com/mcp/', color: '#1CE783', category: 'Code', domain: 'newrelic.com', auth: 'oauth', description: 'Telemetry, logs, errors and alerts (NRQL queries).' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR dcr.service.newrelic.com/register; URL from Anthropic's connector directory
  { id: 'axiom', name: 'Axiom', url: 'https://mcp.axiom.co/mcp', color: '#1A1A1A', category: 'Code', domain: 'axiom.co', auth: 'oauth', description: 'Query logs, traces and datasets with APL.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR authorization.axiom.co/oauth2/register; URL from MCP registry co.axiom/mcp
  { id: 'digitalocean', name: 'DigitalOcean', url: 'https://mcp.digitalocean.com/mcp', color: '#0080FF', category: 'Code', domain: 'digitalocean.com', auth: 'oauth', description: 'Droplets, apps, databases and DNS; creating resources asks.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR cloud.digitalocean.com/v1/oauth/register; URL from MCP registry com.digitalocean/mcp
  { id: 'fly', name: 'Fly.io', url: 'https://mcp.fly.io', color: '#7C3AED', category: 'Code', domain: 'fly.io', auth: 'oauth', description: 'Apps, machines, logs and volumes on Fly.io.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR fly.io/mcp/oauth/register; URL from MCP registry io.fly/fly-mcp
  { id: 'sanity', name: 'Sanity', url: 'https://mcp.sanity.io/', color: '#F03E2F', category: 'Code', domain: 'sanity.io', auth: 'oauth', description: 'Query and edit structured content; publishing always asks.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR mcp.sanity.io/register; URL from Anthropic's connector directory
  { id: 'workos', name: 'WorkOS', url: 'https://mcp.workos.com/mcp', color: '#6363F1', category: 'Code', domain: 'workos.com', auth: 'oauth', description: 'Users, organizations, SSO and directory sync.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR signin.workos.com/oauth2/register; URL from MCP registry com.workos/mcp
  { id: 'rootly', name: 'Rootly', url: 'https://mcp.rootly.com/mcp', color: '#5E35B1', category: 'Code', domain: 'rootly.com', auth: 'oauth', description: 'Incidents, alerts, on-call and retrospectives; paging always asks.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR rootly.com/oauth/register; URL from Anthropic's connector directory
  { id: 'browserstack', name: 'BrowserStack', url: 'https://mcp.browserstack.com/mcp', color: '#F48120', category: 'Code', domain: 'browserstack.com', auth: 'oauth', description: 'Run and debug web and mobile tests on real devices.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR mcp.browserstack.com/auth/oauth2/register; URL from Anthropic's connector directory
  { id: 'mintlify', name: 'Mintlify', url: 'https://mcp.mintlify.com', color: '#0D9373', category: 'Code', domain: 'mintlify.com', auth: 'oauth', description: 'Edit and manage your Mintlify docs sites.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR mcp.mintlify.com/oauth/register; URL from MCP registry com.mintlify/adminmcp
  { id: 'aws-knowledge', name: 'AWS Knowledge', url: 'https://knowledge-mcp.global.api.aws', color: '#FF9900', category: 'Code', domain: 'aws.amazon.com', auth: 'none', description: 'Official AWS docs, guides and regional availability. No sign-in.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: initialize 200 (AWSKnowledgeMCP), open; URL from awslabs.github.io/mcp/servers/aws-knowledge-mcp-server (no auth, rate limited)
  { id: 'svelte', name: 'Svelte docs', url: 'https://mcp.svelte.dev/mcp', color: '#FF3E00', category: 'Code', domain: 'svelte.dev', auth: 'none', description: 'Svelte and SvelteKit docs and code checks. No sign-in.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: initialize 200 (Svelte MCP), open; URL from MCP registry dev.svelte/mcp
  { id: 'twilio-docs', name: 'Twilio Docs', url: 'https://mcp.twilio.com/docs', color: '#F22F46', category: 'Code', domain: 'twilio.com', auth: 'none', description: 'Twilio developer docs and API reference. No sign-in.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: initialize 200 (twilio-docs-mcp), open; URL from Anthropic's connector directory
  // Data & analytics
  { id: 'clickhouse', name: 'ClickHouse', url: 'https://mcp.clickhouse.cloud/mcp', color: '#FFCC01', category: 'Data & analytics', domain: 'clickhouse.com', auth: 'oauth', description: 'Query and explore your ClickHouse Cloud services.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR mcp.clickhouse.cloud/register; URL from Anthropic's connector directory
  { id: 'motherduck', name: 'MotherDuck', url: 'https://api.motherduck.com/mcp', color: '#FFDE00', category: 'Data & analytics', domain: 'motherduck.com', auth: 'oauth', description: 'Query DuckDB databases in MotherDuck; writes ask.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR mcp-auth.motherduck.com/register; URL from Anthropic's connector directory
  { id: 'thoughtspot', name: 'ThoughtSpot', url: 'https://agent.thoughtspot.app/mcp', color: '#2770EF', category: 'Data & analytics', domain: 'thoughtspot.com', auth: 'oauth', description: 'Ask questions of your data with ThoughtSpot Spotter.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401 (no RFC 9728 metadata; AS metadata at the server origin, as the SDK falls back to), DCR agent.thoughtspot.app/register; URL from MCP registry app.thoughtspot/mcp-server
  { id: 'montecarlo', name: 'Monte Carlo', url: 'https://mcp.getmontecarlo.com/mcp', color: '#2E5BFF', category: 'Data & analytics', domain: 'montecarlodata.com', auth: 'oauth', description: 'Data quality alerts, lineage and table health.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR auth.getmontecarlo.com/oauth2/register; URL from Anthropic's connector directory
  { id: 'datahub', name: 'DataHub', url: 'https://mcp.datahub.com/mcp', color: '#1890FF', category: 'Data & analytics', domain: 'datahub.com', auth: 'oauth', description: 'Search your data catalog, lineage and glossary.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR mcp.datahub.com/mcp/oauth/register; URL from Anthropic's connector directory
  { id: 'felt', name: 'Felt', url: 'https://felt.com/mcp', color: '#EE4B6A', category: 'Data & analytics', domain: 'felt.com', auth: 'oauth', description: 'Make and analyze maps from your data.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR felt.com/oauth/register; URL from Anthropic's connector directory
  // Sales & marketing
  { id: 'zoominfo', name: 'ZoomInfo', url: 'https://mcp.zoominfo.com/mcp', color: '#E8332A', category: 'Sales & marketing', domain: 'zoominfo.com', auth: 'oauth', description: 'B2B contacts, companies and intent signals (uses your credits).' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR mcp.zoominfo.com/oauth/register; URL from Anthropic's connector directory
  { id: 'clay', name: 'Clay', url: 'https://api.clay.com/v3/mcp', color: '#2E2E2E', category: 'Sales & marketing', domain: 'clay.com', auth: 'oauth', description: 'Find and enrich prospects and companies (uses Clay credits).' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR api.clay.com/oauth/register; URL from Anthropic's connector directory
  { id: 'lusha', name: 'Lusha', url: 'https://mcp.lusha.com/mcp', color: '#4A37E8', category: 'Sales & marketing', domain: 'lusha.com', auth: 'oauth', description: 'Contact and company enrichment.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR auth.lusha.com/oauth/register; URL from MCP registry com.lusha.mcp/mcp
  { id: 'nutshell', name: 'Nutshell', url: 'https://app.nutshell.com/mcp', color: '#F37121', category: 'Sales & marketing', domain: 'nutshell.com', auth: 'oauth', description: 'Nutshell CRM: leads, contacts and sales reports.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR app.nutshell.com/oauth/register; URL from Anthropic's connector directory
  { id: 'beehiiv', name: 'beehiiv', url: 'https://mcp.beehiiv.com/mcp', color: '#F5C443', category: 'Sales & marketing', domain: 'beehiiv.com', auth: 'oauth', description: 'Newsletters, posts, subscribers and analytics; sending always asks.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR mcp.beehiiv.com/register; URL from MCP registry com.beehiiv/beehiiv
  { id: 'windsor', name: 'Windsor.ai', url: 'https://mcp.windsor.ai/', color: '#1F3B73', category: 'Sales & marketing', domain: 'windsor.ai', auth: 'oauth', description: 'Marketing reports across 350+ sources: Google, Meta, TikTok and more.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR mcp.windsor.ai/register; URL from Anthropic's connector directory
  // Social
  { id: 'vidiq', name: 'vidIQ', url: 'https://mcp.vidiq.com/mcp', color: '#E02424', category: 'Social', domain: 'vidiq.com', auth: 'oauth', description: 'YouTube keyword research, channel stats and trending videos.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR mcp.vidiq.com/mcp/register; URL from Anthropic's connector directory
  // Finance & commerce
  { id: 'airwallex', name: 'Airwallex', url: 'https://mcp.airwallex.com/mcp', color: '#612FFF', category: 'Finance & commerce', domain: 'airwallex.com', auth: 'oauth', description: 'Global accounts, cards, invoices and payouts; money moves always ask.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR mcp.airwallex.com/mcp/register; URL from Anthropic's connector directory
  { id: 'paddle', name: 'Paddle', url: 'https://mcp.paddle.com/mcp', color: '#F9DB3D', category: 'Finance & commerce', domain: 'paddle.com', auth: 'oauth', description: 'Products, prices, subscriptions and transactions; refunds always ask.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR id.paddle.com/oauth2/register; URL from MCP registry com.paddle/mcp
  { id: 'checkout', name: 'Checkout.com', url: 'https://mcp.checkout.com/', color: '#1C1C1C', category: 'Finance & commerce', domain: 'checkout.com', auth: 'oauth', description: 'Look into payments, disputes and settlements, plus the API docs.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR access.mcp.checkout.com/payment-operations/register; URL from Anthropic's connector directory
  { id: 'morningstar', name: 'Morningstar', url: 'https://mcp.morningstar.com/mcp', color: '#E31B23', category: 'Finance & commerce', domain: 'morningstar.com', auth: 'oauth', description: 'Fund and stock data, ratings and analyst research.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR mcp.morningstar.com/oauth-issuer/register; URL from Anthropic's connector directory
  { id: 'factset', name: 'FactSet', url: 'https://mcp.factset.com/content/v1', color: '#00559C', category: 'Finance & commerce', domain: 'factset.com', auth: 'oauth', description: 'Fundamentals, estimates and prices (FactSet subscription).' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR auth.factset.com/as/clients.oauth2; URL from Anthropic's connector directory
  { id: 'pitchbook', name: 'PitchBook', url: 'https://premium.mcp.pitchbook.com/mcp', color: '#1E7BC6', category: 'Finance & commerce', domain: 'pitchbook.com', auth: 'oauth', description: 'Private company, deal and investor data (PitchBook subscription).' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR mcp.pitchbook.com/auth/register; URL from Anthropic's connector directory
  { id: 'kensho', name: 'S&P Global (Kensho)', url: 'https://kfinance.kensho.com/integrations/mcp', color: '#D6002A', category: 'Finance & commerce', domain: 'spglobal.com', auth: 'oauth', description: 'S&P Capital IQ financials, filings and transcripts (subscription).' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR kfinance.kensho.com/integrations/register; URL from Anthropic's connector directory
  { id: 'financialdatasets', name: 'Financial Datasets', url: 'https://mcp.financialdatasets.ai/', color: '#111827', category: 'Finance & commerce', domain: 'financialdatasets.ai', auth: 'oauth', description: 'Stock prices, financial statements, filings and insider trades.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR mcp.financialdatasets.ai/register; URL from MCP registry ai.financialdatasets/mcp
  // HR & recruiting
  { id: 'greenhouse', name: 'Greenhouse', url: 'https://mcp.greenhouse.io/mcp', color: '#24A47F', category: 'HR & recruiting', domain: 'greenhouse.com', auth: 'oauth', description: 'Candidates, jobs, interviews and offers; emailing candidates always asks.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR auth.greenhouse.io/register; URL from Anthropic's connector directory
  { id: 'ashby', name: 'Ashby', url: 'https://mcp.ashbyhq.com/mcp/v1', color: '#5047E5', category: 'HR & recruiting', domain: 'ashbyhq.com', auth: 'oauth', description: 'Recruiting data: candidates, pipelines and interviews.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR mcp-auth.ashbyhq.com/oidc/reg; URL from Anthropic's connector directory
  { id: 'remote', name: 'Remote', url: 'https://mcp.remote.com/mcp', color: '#624DE3', category: 'HR & recruiting', domain: 'remote.com', auth: 'oauth', description: 'Employees, time off, payslips and expenses; approvals ask.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR api.employ.remote.com/oauth/register; URL from Anthropic's connector directory
  { id: 'indeed', name: 'Indeed', url: 'https://mcp.indeed.com/claude/mcp', color: '#003A9B', category: 'HR & recruiting', domain: 'indeed.com', auth: 'oauth', description: 'Search job listings and details on Indeed.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR secure.indeed.com/oauth/v2/register; URL from docs.indeed.com/mcp
  { id: 'dice', name: 'Dice', url: 'https://mcp.dice.com/mcp', color: '#CC0000', category: 'HR & recruiting', domain: 'dice.com', auth: 'none', description: 'Search tech jobs on Dice. No sign-in.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: initialize 200 (Job Search MCP Server), open; URL from Anthropic's connector directory
  // Legal
  { id: 'pandadoc', name: 'PandaDoc', url: 'https://mcp.pandadoc.com/v1/mcp', color: '#47B881', category: 'Legal', domain: 'pandadoc.com', auth: 'oauth', description: 'Documents, templates and quotes; sending for signature always asks.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR mcp.pandadoc.com/register; URL from MCP registry com.pandadoc.mcp/mcp
  { id: 'clio', name: 'Clio', url: 'https://mcp.api.clio.com/mcp', color: '#0070E0', category: 'Legal', domain: 'clio.com', auth: 'oauth', description: 'Legal research and dockets from Clio Library and Clio Docket, with citations.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR mcp.api.clio.com/register; URL from Anthropic's connector directory
  { id: 'midpage', name: 'Midpage', url: 'https://app.midpage.ai/mcp', color: '#111111', category: 'Legal', domain: 'midpage.ai', auth: 'oauth', description: 'US case law, statutes and live court dockets.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR app.midpage.ai/oauth/register; URL from Anthropic's connector directory
  // Travel & real estate
  { id: 'kiwi', name: 'Kiwi.com', url: 'https://mcp.kiwi.com/', color: '#00A991', category: 'Travel & real estate', domain: 'kiwi.com', auth: 'none', description: 'Search flights and fares. No sign-in.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: initialize 200 (kiwicom-flight-search), open; URL from Anthropic's connector directory
  { id: 'trivago', name: 'trivago', url: 'https://mcp.trivago.com/mcp', color: '#0088D9', category: 'Travel & real estate', domain: 'trivago.com', auth: 'none', description: 'Compare hotel prices across booking sites. No sign-in.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: initialize 200 (trivago Accommodation Search), open; URL from MCP registry com.trivago.mcp/mcp
  { id: 'zillow', name: 'Zillow', url: 'https://mcp.zillow.com/api/v2', color: '#006AFF', category: 'Travel & real estate', domain: 'zillow.com', auth: 'none', description: 'Homes, rentals, Zestimates and affordability. No sign-in.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: initialize 200 (fastmcp-external-gateway-pioneer), open; URL from Anthropic's connector directory
  { id: 'biggerpockets', name: 'BiggerPockets', url: 'https://www.biggerpockets.com/mcp', color: '#0B7DDB', category: 'Travel & real estate', domain: 'biggerpockets.com', auth: 'oauth', description: 'Real estate deal calculators and the investing library.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR www.biggerpockets.com/oauth/registration; URL from Anthropic's connector directory
  // Education & science
  { id: 'wolfram', name: 'Wolfram', url: 'https://agenttools.wolfram.com/mcp', color: '#DD1100', category: 'Education & science', domain: 'wolfram.com', auth: 'none', description: 'Exact math, data and Wolfram|Alpha answers. No sign-in.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: initialize 200 (Wolfram), open; URL from support.wolfram.com (free Cloud MCP, no authentication)
  { id: 'consensus', name: 'Consensus', url: 'https://mcp.consensus.app/mcp', color: '#1F6FEB', category: 'Education & science', domain: 'consensus.app', auth: 'oauth', description: 'Search peer-reviewed research and read the findings.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR consensus.app/oauth/register; URL from Anthropic's connector directory
  { id: 'scite', name: 'Scite', url: 'https://api.scite.ai/mcp', color: '#1B2A4A', category: 'Education & science', domain: 'scite.ai', auth: 'oauth', description: 'Research answers backed by citations that support or contrast.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR api.scite.ai/mcp/oauth/register; URL from MCP registry ai.scite/mcp
  { id: 'wiley', name: 'Wiley Scholar Gateway', url: 'https://connector.scholargateway.ai/v2/mcp', color: '#1A1A1A', category: 'Education & science', domain: 'wiley.com', auth: 'oauth', description: 'Full-text search of Wiley journals, with citations.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR connector.scholargateway.ai/register; URL from Anthropic's connector directory
  { id: 'udemy', name: 'Udemy Business', url: 'https://api.udemy.com/mcp', color: '#A435F0', category: 'Education & science', domain: 'udemy.com', auth: 'oauth', description: 'Courses, learning paths and labs on your Udemy Business plan.' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR api.udemy.com/auth/external/oidc/dynamic-client/register; URL from Anthropic's connector directory
  // Health & fitness
  // Not listed: PubMed / ClinicalTrials.gov servers at *.mcp.claude.com are hosted by Anthropic for Claude, not for
  // other apps (same reason as Microsoft 365); SahilBot's own research tool searches PubMed directly.
  { id: 'strava', name: 'Strava', url: 'https://mcp.strava.com/mcp', color: '#FC4C02', category: 'Health & fitness', domain: 'strava.com', auth: 'oauth', description: 'Your activities, training zones and performance (read-only).' }, // NEW 2026-11-15 (batch 2), swept 2026-11-15: 401+PRM, DCR www.strava.com/oauth/mcp/register_client (PKCE methods unlisted; S256 sent); URL from Anthropic's connector directory
  { id: 'custom', name: 'Custom MCP server', url: '', color: '#7C5CFF', category: 'Other', auth: 'oauth', description: 'Any MCP server: a URL, or a local command.' }
]

/**
 * Test-only catalog entries for acceptance tests (a local fake OAuth + MCP server), from
 * SAHILBOT_TEST_PRESETS (a JSON array of { id, name, url, description?, auth? }). Honoured only in a
 * hidden test run (SAHILBOT_HIDDEN=1), only for loopback server URLs, only for 'oauth', 'none' or
 * 'oauth-static' (an app without self-registration: it connects in one click only with a built-in
 * client from SAHILBOT_OAUTH_CLIENTS_JSON, else it needs its setup), and never replacing a real
 * catalog entry. A normal run ignores it.
 */
export function testPresets(env: NodeJS.ProcessEnv = process.env, existing: Array<Pick<ConnectorPreset, 'id'>> = PRESETS): ConnectorPreset[] {
  if (env.SAHILBOT_HIDDEN !== '1' || !env.SAHILBOT_TEST_PRESETS) return []
  let raw: unknown
  try { raw = JSON.parse(env.SAHILBOT_TEST_PRESETS) } catch { return [] }
  if (!Array.isArray(raw)) return []
  const taken = new Set(existing.map((p) => p.id))
  const out: ConnectorPreset[] = []
  for (const x of raw.slice(0, 5) as Array<Record<string, unknown>>) {
    const id = typeof x?.id === 'string' ? x.id : ''
    const name = typeof x?.name === 'string' ? x.name.trim().slice(0, 40) : ''
    const url = typeof x?.url === 'string' ? x.url : ''
    const auth = x?.auth === 'none' ? 'none' : x?.auth === 'oauth-static' ? 'oauth-static' : 'oauth'
    if (!/^test-[a-z0-9-]{1,30}$/.test(id) || !name || taken.has(id) || !/^http:\/\//.test(url) || !isLoopbackUrl(url)) continue
    taken.add(id)
    const setup: ConnectorSetup | undefined = auth === 'oauth-static'
      ? { minutes: 2, needsSecret: false, redirectUri: setupRedirect(), steps: [{ title: `Create an OAuth app in ${name}`, text: 'Test app: any client ID the fake server knows.', links: [] }] }
      : undefined
    out.push({ id, name, url, auth, ...(setup ? { setup } : {}), color: '#64748B', category: 'Other', description: typeof x.description === 'string' ? x.description.slice(0, 200) : `${name} (test app).` })
  }
  return out
}
PRESETS.push(...testPresets())

/** The app's whole name appears in the text as words ("Google Calendar" in "check my google calendar"). */
export function namedIn(text: string, name: string): boolean {
  const n = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if (n.length < 3) return false
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `.includes(` ${n} `)
}

/**
 * The text asks to USE the app (the user's account, or something in it), not just mentions it: "my Notion",
 * "add it to Notion", "my Notion workspace", or a search for the app itself ("notion"). "Web search for Notion
 * and Obsidian pricing" only talks about the apps.
 */
export function usesApp(text: string, name: string): boolean {
  if (!namedIn(text, name)) return false
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9']+/g, ' ')} `
  const n = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  // The app's name is (nearly) the whole query: a search for its tools ("notion", "acme tasks", "notion tools").
  if (t.replace(` ${n} `, ' ').trim().split(/\s+/).filter(Boolean).length <= 2) return true
  return new RegExp(` (?:my|our|the user's|user's|in|into|to|from|via|with|using) ${n} `).test(t) ||
    new RegExp(` ${n} (?:account|workspace|page|pages|database|databases|inbox|board|boards|calendar|drive|doc|docs|notes|tasks|issues|project|projects|repo|repos|channel|channels|files|folder|data|connector|api|integration|tools?) `).test(t)
}

/**
 * Signs in with one click: the server registers SahilBot itself (DCR), needs no sign-in, or SahilBot
 * ships its own app registration for it (`builtinClient`, set on the presets main hands out).
 */
export function isOneClick(p: Pick<ConnectorPreset, 'auth' | 'builtinClient'>): boolean {
  return p.auth === 'oauth' || p.auth === 'none' || ((p.auth === 'oauth-static' || p.auth === 'google') && !!p.builtinClient)
}

/**
 * Local catalog entries and the one thing each may run: an exact command (absolute path, fixed args,
 * nothing downloaded) or a loopback address a desktop app serves. A saved config for one of these is
 * always rewritten to this, and connecting refuses anything else, so a settings edit can't turn
 * "Xcode" into an arbitrary command. The usual stdio safety still applies (SAFE_ENV_BLOCK).
 *
 * Considered and left out (official, keyless stdio servers that don't fit): the MCP reference
 * filesystem/memory servers (they duplicate SahilBot's own file and memory tools without its path
 * checks), Playwright MCP and Chrome DevTools MCP (npx fetches and runs the latest package from npm
 * at every start, and SahilBot already has its own browser), JetBrains' IDE server (its port is
 * picked per install), Docker's MCP gateway (it runs any server from Docker's catalog).
 */
export const LOCAL_SERVERS: Record<string, ({ kind: 'stdio'; command: string; args: string[] } | { kind: 'remote'; url: string }) & { hint: string }> = {
  xcode: { kind: 'stdio', command: '/usr/bin/xcrun', args: ['mcpbridge'], hint: 'Open Xcode 26.3 or later with your project, turn on Xcode → Settings → Intelligence → "Allow external agents to use Xcode tools", then press Reconnect (Xcode asks once to allow SahilBot).' },
  'figma-desktop': { kind: 'remote', url: 'http://127.0.0.1:3845/mcp', hint: 'Open the Figma desktop app, turn on its desktop MCP server (in Dev Mode, the inspect panel → "Enable desktop MCP server"), then press Reconnect.' }
}

/** A catalog entry served on this Mac (no https server to probe). */
export function isLocalPreset(p: Pick<ConnectorPreset, 'id'> | undefined): boolean {
  return !!p && Object.prototype.hasOwnProperty.call(LOCAL_SERVERS, p.id)
}

/** A saved config for a local catalog entry, pinned to its allowed command or address. */
function pinLocal<T extends Partial<ConnectorConfig>>(c: T): T {
  const l = c.preset && Object.prototype.hasOwnProperty.call(LOCAL_SERVERS, c.preset) ? LOCAL_SERVERS[c.preset] : undefined
  if (!l) return c
  const rest: Partial<ConnectorConfig> = { ...c }
  for (const k of ['url', 'command', 'args', 'env', 'headerName', 'clientId'] as const) delete rest[k]
  return (l.kind === 'stdio' ? { ...rest, kind: 'stdio', command: l.command, args: [...l.args] } : { ...rest, kind: 'remote', url: l.url }) as T
}

/** The redirect URL a connector with its own (pre-registered) client uses. */
export function redirectFor(preset?: string): string {
  return PRESETS.find((p) => p.id === preset)?.setup?.redirectUri ?? setupRedirect()
}

/** The site whose icon represents a preset: its explicit domain (may include a path), else the server URL's host minus mcp./api./www. */
export function iconDomain(p: Pick<ConnectorPreset, 'url' | 'domain'>): string | null {
  if (p.domain) return p.domain
  let host: string
  try { host = new URL(p.url).hostname.toLowerCase() } catch { return null }
  if (!host || !host.includes('.') || /^(\d+\.){3}\d+$/.test(host) || host === 'localhost') return null
  const labels = host.split('.')
  while (labels.length > 2 && /^(www|mcp|api|app)$/.test(labels[0])) labels.shift()
  return labels.slice(-2).join('.')
}

/** Favicon services; a site with a path (mail.google.com/mail/) gets that page's icon, not the domain's. */
const ICON_SOURCES = (site: string): string[] => [
  site.includes('/')
    ? `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(`https://${site}`)}&sz=128`
    : `https://www.google.com/s2/favicons?domain=${encodeURIComponent(site)}&sz=128`,
  `https://icons.duckduckgo.com/ip3/${encodeURIComponent(site.split('/')[0])}.ico`
]
const ICON_RETRY_MS = 3 * 24 * 3600_000
const ICON_TYPES: Record<string, string> = { png: 'image/png', ico: 'image/x-icon', svg: 'image/svg+xml', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

/**
 * App icons for the catalog: fetched once per preset from a favicon service, kept as files in the
 * data folder and handed to the renderer as data: URLs (it can't load remote images).
 */
export class ConnectorIcons {
  private urls = new Map<string, string>()
  private running: Promise<void> | null = null
  private misses: Record<string, number>

  constructor(private dir: string, private presets: ConnectorPreset[], private changed: () => void, private fetcher: typeof fetch = fetch) {
    this.misses = this.readMisses()
    for (const f of existsSync(dir) ? readdirSync(dir) : []) {
      const m = /^(.+)\.(png|ico|svg|jpg|webp|gif)$/.exec(f)
      if (!m) continue
      try { this.urls.set(m[1], `data:${ICON_TYPES[m[2]]};base64,${readFileSync(join(dir, f)).toString('base64')}`) } catch { /* unreadable: refetch */ }
    }
  }

  /** What's cached now; missing icons are fetched in the background and `changed` fires as they land. */
  all(): Record<string, string> {
    void this.fill()
    return Object.fromEntries(this.urls)
  }

  private readMisses(): Record<string, number> {
    try { return JSON.parse(readFileSync(join(this.dir, 'misses.json'), 'utf8')) as Record<string, number> } catch { return {} }
  }

  private fill(): Promise<void> {
    if (this.running) return this.running
    const now = Date.now()
    const todo = this.presets.filter((p) => !this.urls.has(p.id) && iconDomain(p) && !(this.misses[p.id] && now - this.misses[p.id] < ICON_RETRY_MS))
    if (!todo.length) return Promise.resolve()
    let dirty = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const notify = (): void => {
      dirty = true
      timer ??= setTimeout(() => { timer = null; if (dirty) { dirty = false; this.changed() } }, 250)
    }
    const queue = [...todo]
    const worker = async (): Promise<void> => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        const got = await this.fetchOne(iconDomain(p)!).catch(() => null)
        if (got) {
          try { writeFileSync(join(this.dir, `${p.id}.${got.ext}`), got.bytes) } catch { /* cache is best effort */ }
          this.urls.set(p.id, `data:${ICON_TYPES[got.ext]};base64,${got.bytes.toString('base64')}`)
          delete this.misses[p.id]
          notify()
        } else this.misses[p.id] = Date.now()
      }
    }
    this.running = Promise.all(Array.from({ length: 6 }, worker)).then(() => {
      try { writeFileSync(join(this.dir, 'misses.json'), JSON.stringify(this.misses)) } catch { /* best effort */ }
    }).finally(() => { this.running = null })
    return this.running
  }

  private async fetchOne(domain: string): Promise<{ bytes: Buffer; ext: string } | null> {
    for (const url of ICON_SOURCES(domain)) {
      try {
        const r = await this.fetcher(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' })
        if (!r.ok) continue
        const type = (r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
        const bytes = Buffer.from(await r.arrayBuffer())
        // Tiny responses are the services' "no icon" placeholders.
        if (bytes.length < 120 || bytes.length > 400_000) continue
        const ext = type.includes('png') ? 'png' : type.includes('icon') || url.endsWith('.ico') ? 'ico' : type.includes('svg') ? 'svg' : type.includes('jpeg') ? 'jpg' : type.includes('webp') ? 'webp' : type.includes('gif') ? 'gif' : null
        if (ext) return { bytes, ext }
      } catch { /* try the next source */ }
    }
    return null
  }
}

const MAX_TOOL_NAME = 64
const SAFE_ENV_BLOCK = /^(NODE_OPTIONS|DYLD_|LD_|ELECTRON_)/
/** Everyday words that don't say which app a request needs. */
const SUGGEST_STOP = new Set(['and', 'the', 'for', 'with', 'your', 'you', 'any', 'all', 'from', 'into', 'files', 'file', 'data', 'sign', 'needs', 'setup', 'more', 'own', 'one', 'via', 'app', 'apps', 'read', 'find', 'search', 'get', 'list', 'make', 'new'])

interface Live {
  client: Client
  /** Registered agent tool names (enabled tools only). */
  tools: string[]
  /** Every tool the server offers, as listed. */
  all: ServerTool[]
  /** Server tool name (as listed) → its collision-free agent tool name. */
  names: Map<string, string>
}

type ServerTool = { name: string; description?: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; title?: string } }

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

/** server__tool, capped at 64 chars for OpenAI-style tool names. */
export function toolName(server: string, tool: string): string {
  const n = `${slug(server)}__${slug(tool)}`
  return n.length <= MAX_TOOL_NAME ? n : `${n.slice(0, MAX_TOOL_NAME - 9)}_${Buffer.from(n).toString('base64url').slice(0, 8)}`
}

/**
 * Agent names for one server's tools, keyed by the server's own names. Names that slug to the same
 * thing (send-email, send_email) don't collide: the first in the server's order keeps the plain name,
 * later ones get _2, _3… (the lowest free suffix), so each server tool maps to exactly one agent tool.
 */
export function toolNames(server: string, tools: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const bases = tools.map((t) => toolName(server, t))
  const used = new Set<string>()
  const later: number[] = []
  // Plain names first, so a tool whose name is naturally "x_2" isn't displaced by a suffixed "x".
  bases.forEach((b, i) => {
    if (out.has(tools[i])) return
    if (used.has(b)) { later.push(i); return }
    used.add(b)
    out.set(tools[i], b)
  })
  for (const i of later) {
    if (out.has(tools[i])) continue
    for (let n = 2; ; n++) {
      const suffix = `_${n}`
      const name = `${bases[i].slice(0, MAX_TOOL_NAME - suffix.length)}${suffix}`
      if (used.has(name) || bases.includes(name)) continue
      used.add(name)
      out.set(tools[i], name)
      break
    }
  }
  // In the server's order.
  return new Map(tools.filter((t, i) => tools.indexOf(t) === i).map((t) => [t, out.get(t)!]))
}

/** MCP annotations and verbs decide the effect: reads run, writes follow the permission mode. */
export function effectFor(name: string, ann?: { readOnlyHint?: boolean; destructiveHint?: boolean }): ToolEffect {
  if (ann?.readOnlyHint) return 'read'
  if (ann?.destructiveHint || /(^|[_\-.])(delete|remove|trash|archive|destroy)/i.test(name)) return 'destructive'
  // Only the leading verb counts (create_report, update_view are writes), and a write verb anywhere wins (find_and_replace).
  if (/(^|[_\-.])(create|update|replace|set|add|write|edit|send|post|put|patch|insert|upsert|modify|move|rename|upload|submit|assign|merge|publish|share|invite|apply)([_\-.]|$)/i.test(name) ||
    /[a-z](Create|Update|Replace|Set|Add|Write|Edit|Send|Post|Put|Patch|Insert|Upsert|Modify|Move|Rename|Upload|Submit|Assign|Merge|Publish|Share|Invite|Apply)([A-Z]|$)/.test(name)) return 'write_external'
  // Servers often prefix their own name (notion-search, slack_list_channels); write verbs were already caught above.
  if (/^([a-z0-9]+[_\-.])?(get|list|search|read|fetch|query|find|lookup|describe|view|show|retrieve|count|stats|report|overview|research)([_\-.]|$)/i.test(name) ||
    /^(get|list|search|read|fetch|query|find|lookup|describe|view|show|retrieve|count)[A-Z]/.test(name)) return 'read'
  return 'write_external'
}

type EffectRule = [RegExp, { effect: ToolEffect; consequential?: boolean; hardStop?: string }]

const SEND_HARD = (what: string): EffectRule[1] => ({ effect: 'write_external', consequential: true, hardStop: what })
const ASK: EffectRule[1] = { effect: 'write_external', consequential: true }
const READ: EffectRule[1] = { effect: 'read', consequential: false }
const DESTROY: EffectRule[1] = { effect: 'destructive', consequential: true }

/**
 * Well-known tool names of catalog apps where the generic verb rules would be too lenient (or too
 * strict), gmailPolicy-style. First match wins; anything unmatched falls through to the generic
 * rules, whose default for an unknown tool is write_external. Names are matched case-insensitively
 * against the server's own tool name.
 */
export const EFFECT_MAPS: Record<string, EffectRule[]> = {
  slack: [
    [/^(slack_)?(send_message|schedule_message|post_message|reply_to_thread|send_message_draft)$/i, SEND_HARD('posts a message in Slack as you')],
    [/^(slack_)?(search|read|list|get)_/i, READ],
    [/^(slack_)?(create|update)_canvas$/i, ASK]
  ],
  github: [
    [/^merge_pull_request$/i, SEND_HARD('merges a pull request on GitHub')],
    [/^(push_files|create_or_update_file|delete_file|create_branch|create_repository|fork_repository)$/i, ASK],
    [/^(create_pull_request|update_pull_request|create_issue|update_issue|add_issue_comment|add_comment_to_pending_review|create_and_submit_pull_request_review|submit_pending_pull_request_review|request_copilot_review|assign_copilot_to_issue)$/i, ASK],
    [/^(get|list|search)_/i, READ]
  ],
  stripe: [
    [/(^|_)(create_refund|refund)/i, SEND_HARD('refunds a Stripe payment')],
    [/^(cancel_subscription|update_subscription|finalize_invoice|send_invoice|create_payment_link|create_invoice|create_invoice_item|create_price|create_product|create_coupon|create_customer|update_dispute)$/i, ASK],
    [/^(list|retrieve|search|get)_/i, READ]
  ],
  paypal: [
    [/(refund|capture|payout)/i, SEND_HARD('moves money in PayPal')],
    [/^(send_invoice|send_invoice_reminder|cancel_sent_invoice|create_invoice|create_order|create_product|create_subscription_plan|create_subscription|cancel_subscription|update_subscription|create_shipment_tracking|accept_dispute_claim)$/i, ASK],
    [/^(list|get|show|search)_/i, READ]
  ],
  square: [
    // Square's server exposes one generic API tool: every call can change the account.
    [/^make_api_request$/i, ASK],
    [/^get_(service|type)_info$/i, READ]
  ],
  vercel: [
    [/(buy|purchase|renew)_domain/i, SEND_HARD('buys a domain on Vercel')],
    [/^(deploy|create_deployment|promote|rollback|request_promote|request_rollback)/i, ASK]
  ],
  cloudflare: [
    // Code-mode server: "search" reads the API spec, "execute" runs API calls.
    [/^search$/i, READ],
    [/^execute$/i, ASK]
  ],
  'cloudflare-containers': [
    // A sandbox shell: running or writing anything asks.
    [/^(container_exec|container_file_write|container_file_delete|container_initialize)/i, ASK],
    [/^(container_ls|container_file_read)/i, READ]
  ],
  vimeo: [
    [/^delete_/i, DESTROY],
    // Uploads, edits and new showcases change the account.
    [/(upload|edit|update|create|add|set|remove|move)/i, ASK],
    [/^(get|list|search|read|fetch)/i, READ]
  ],
  invideo: [
    [/^delete_/i, DESTROY],
    // Generation and exports spend plan credits.
    [/(generate|create|render|export|publish|upload)/i, ASK],
    [/^(get|list|search|read)/i, READ]
  ],
  supabase: [
    [/^(execute_sql|apply_migration|deploy_edge_function|merge_branch|reset_branch|rebase_branch|pause_project|restore_project|create_project|create_branch|confirm_cost)$/i, ASK],
    [/^delete_branch$/i, DESTROY]
  ],
  heygen: [
    [/^delete_/i, DESTROY],
    // Video generation, conversions, uploads and consents spend plan credits or act on the account.
    [/(generate|create|render|text_to_video|image_to_video|reference_to_video|convert_speech|send_video_agent_message|update_video_translation)/i, ASK],
    [/^(get|list|search|bulk_video_translation_statuses)/i, READ]
  ],
  hyperframes: [
    [/^render/i, ASK],
    // compose renders the MP4 on its own (its own description), so it may spend credits.
    [/^compose$/i, ASK],
    [/^(get|list)_/i, READ]
  ],
  docusign: [
    [/(send|void|resend)_?envelope|^send/i, SEND_HARD('sends documents for signature through Docusign')]
  ],
  make: [
    [/scenarios?_run|run_scenario/i, ASK],
    [/scenarios?_(activate|deactivate)/i, ASK]
  ],
  zapier: [
    // Zap actions are named after the app action (gmail_send_email, slack_send_channel_message).
    [/(^|_)(send|post|reply|publish|tweet|forward)(_|$)/i, SEND_HARD('sends or posts something through Zapier')]
  ],
  calendly: [
    [/cancel/i, DESTROY]
  ],
  todoist: [
    [/^delete-object$/i, DESTROY]
  ],
  // ---- NEW 2026-11-15 apps. Names are the servers' own (as listed in their directory entries); money
  // and mass-sends are hard stops, outward actions (posting, paging people, deploying) ask.
  mercury: [
    [/^(get|list|search)/i, READ],
    // requestSendMoney / requestTransferMoney set a payment up for approval: still money.
    [/(send|transfer)_?money|payment|recipient|^(approve|cancel)/i, SEND_HARD('moves money from your Mercury account')]
  ],
  brex: [
    [/^(get|list)_/i, READ],
    [/(pay|transfer|reimburse)/i, SEND_HARD('moves money in Brex')]
  ],
  mollie: [
    [/^(aggregate|get|list|search)/i, READ],
    [/(Refund|Capture|Payment|Payout|Transfer|Mandate|Charge)/i, SEND_HARD('takes, refunds or moves money in Mollie')],
    [/^cancel/i, ASK]
  ],
  railway: [
    [/(^|-)(deploy|accept-deploy|deploy-artifact|create-deployment|redeploy|restart)/i, ASK],
    [/(^|-)(delete|remove)/i, DESTROY],
    [/^(get|list|search)-/i, READ]
  ],
  render: [
    // Creating services and databases starts billing on the account.
    [/^(create|deploy|restart|suspend|resume|scale)_|update_(env|environment)/i, ASK],
    [/^(get|list|query)_/i, READ]
  ],
  pagerduty: [
    // Incidents and responders page real people.
    [/^(create_incident|add_responders|escalate|reassign|create_status_update|send_)/i, SEND_HARD('pages or notifies people through PagerDuty')],
    [/^(resolve|acknowledge|merge|snooze|manage)_|^(create|update)_schedule/i, ASK],
    [/^(get|list|search)_/i, READ]
  ],
  circleci: [
    [/^(run|rerun|trigger|cancel|approve)_/i, ASK],
    [/^(get|list|find|analyze|download)_/i, READ]
  ],
  planetscale: [
    [/execute_write_query|create_(branch|deploy_request)|deploy|promote|revert/i, ASK],
    [/(delete|drop)/i, DESTROY],
    [/^planetscale_(get|list|search|execute_read_query)/i, READ]
  ],
  grafana: [
    [/(create|add_activity_to)_incident|alerting_manage|create_annotation|update_dashboard/i, ASK],
    [/^(get|list|search|query|find|describe|ask_assistant)/i, READ]
  ],
  betterstack: [
    [/(acknowledge|resolve|escalate)_incident|create_(incident|monitor|heartbeat)/i, ASK]
  ],
  bigquery: [
    // SQL can change tables and every query is billed.
    [/^execute_sql$/i, ASK],
    [/^(list|get)_/i, READ]
  ],
  trello: [
    [/^trelloRead/i, READ],
    [/^trello(Delete|Archive)/i, DESTROY]
  ],
  egnyte: [
    [/create_link|share/i, ASK]
  ],
  docsend: [
    [/create_space_link|create_link|send|invite|add_.*(permission|member)/i, ASK]
  ],
  higgsfield: [
    [/(publish|deploy_website|tiktok_prepare_publish|participate_in_contest)/i, SEND_HARD('publishes something publicly through Higgsfield')],
    [/(cancel_trial_auto_renewal|select_workspace)/i, ASK],
    // Generations spend plan credits.
    [/(generate|upscale|create_voice|reframe|outpaint|remove_background|dubbing|voice_change|motion_control|execute_preset|build_ai_influencer|scene_builder_3d_generate|video_analysis_create)/i, ASK],
    [/^(get_|list_|show_|search_|balance|transactions|models_explore|job_display|jobs_wait)/i, READ]
  ],
  descript: [
    [/^(prompt_project_agent|import_media)$/i, { effect: 'write_external', consequential: false }],
    [/^(get|list)_/i, READ]
  ],
  typefully: [
    [/^(get|list|search)_/i, READ],
    // A scheduled or published draft goes out to the user's social accounts.
    [/(publish|schedule|share)/i, SEND_HARD('posts to your social accounts through Typefully')]
  ],
  metricool: [
    [/^(create|update)ScheduledPost$/i, SEND_HARD('schedules a post to your social accounts through Metricool')],
    [/^get/i, READ]
  ],
  'windsor-social': [
    [/^(get|list|search)_/i, READ],
    [/^(execute_action|create_destination_task)$/i, SEND_HARD('posts or changes your social accounts through Windsor.ai')]
  ],
  supermetrics: [
    // manage_* tools change live ad campaigns (and spend) or social accounts.
    [/^manage_(campaign|social_media)$/i, SEND_HARD('changes live ad campaigns or social posts through Supermetrics')],
    [/^(data_query|campaign_and_resource_get|marketing_utilities)$/i, READ]
  ],
  bird: [
    [/(_list|_get)$/i, READ],
    [/(send|broadcast|call|campaigns?_(launch|start|schedule)|messages?_create)/i, SEND_HARD('sends email, SMS, WhatsApp or calls through Bird')]
  ],
  livestorm: [
    [/^livestorm_(get|list|search)/i, READ],
    // Registering people emails them invitations.
    [/(bulk_register|register_people|invite|send)/i, SEND_HARD('registers or emails people through Livestorm')]
  ],
  chatbase: [
    [/^chatbase_(get|list|export|search)/i, READ],
    [/create_ticket_message|reply/i, ASK]
  ],
  gitlab: [
    [/^(merge_merge_request|accept_merge_request|merge)$|^merge_/i, SEND_HARD('merges code on GitLab')],
    [/^(get|list|search)_/i, READ],
    [/(create|update)_(issue|merge_request|note|comment|workitem|work_item)|create_branch|(create|run|retry|cancel)_pipeline/i, ASK]
  ],
  buildkite: [
    [/^(get|list|search|read)_|_logs?$/i, READ],
    [/(create_build|rebuild|unblock|cancel_build|retry|trigger)/i, ASK]
  ],
  prisma: [
    [/(delete|drop)/i, DESTROY],
    [/(execute|run)_?(sql|query)|create_(database|backup)|restore/i, ASK]
  ],
  datadog: [
    [/^(search|get|analyze|aggregate|list)_/i, READ]
  ],
  front: [
    [/^(get|list|search)_/i, READ],
    [/(send|reply|forward)/i, SEND_HARD('sends a message to customers through Front')]
  ],
  'superhuman-mail': [
    [/^(get|list|search|read)_/i, READ],
    [/(^|_)(send|reply|forward)(_|$)/i, SEND_HARD('sends email as you through Superhuman')]
  ],
  mandrill: [
    [/^account_status$/i, READ],
    // call_api reaches the whole Transactional API, including sending: it always asks.
    [/^call_api$|send/i, SEND_HARD('calls the Mailchimp Transactional API, which can send email')]
  ],
  brevo: [
    [/(^|_)(get|list)_/i, READ],
    [/(send|schedule)/i, SEND_HARD('sends email or SMS through Brevo')]
  ],
  buffer: [
    [/^(get|list|search)_/i, READ],
    [/(post|publish|share|schedule|queue)/i, SEND_HARD('posts to your social accounts through Buffer')]
  ],
  bigcommerce: [
    [/refund/i, SEND_HARD('refunds an order in BigCommerce')],
    [/(order|price|inventory|publish|channel)/i, ASK]
  ],
  replicate: [
    // Model runs bill the account.
    [/(create_prediction|run|create_training|create_deployment|predict)/i, ASK]
  ],
  runway: [
    [/(generate|image_to|text_to|video_to|upscale|create)/i, ASK]
  ],
  perplexity: [
    [/(search|ask|research|reason)/i, READ]
  ],
  pendo: [
    // Read-only analytics (names like accountQuery, guideMetrics, segmentList).
    [/./, READ]
  ],
  firecrawl: [
    // Search and scrape only read the web (they spend credits, nothing else).
    [/^firecrawl_/i, READ]
  ],
  tavily: [
    [/^tavily_/i, READ]
  ],
  alphavantage: [
    // Market data only: every tool is a read (names are like TIME_SERIES_DAILY).
    [/./, READ]
  ],
  mapbox: [
    [/_tool$/i, READ]
  ],
  crustdata: [
    [/^crustdata_/i, READ]
  ],
  // ---- NEW 2026-11-15, batch 2. Names are the servers' own (their directory listings and tools/list of the
  // open ones). Money moves, mass sends and public posting are hard stops; deploys, deletes, merges and
  // outward actions ask; read-only tools are explicit reads. Unmatched names fall to the generic rules.
  // Finance & commerce
  airwallex: [
    [/^(get|list|search|retrieve)_/i, READ],
    [/(transfer|payout|payment|conversion|convert|fx_|quote_?lock|refund|create_beneficiary|update_beneficiary)/i, SEND_HARD('moves money or adds a payee in Airwallex')],
    [/(create|activate|update|freeze|cancel)_card|card_limit|(create|finalize|send|void)_billing_invoice|create_billing_(customer|price|coupon|meter|subscription)|cancel_billing/i, ASK]
  ],
  paddle: [
    [/^(list|get|preview|search)_/i, READ],
    [/(adjustment|refund|credit|charge|create_transaction|capture)/i, SEND_HARD('charges, credits or refunds money in Paddle')],
    [/^(cancel|pause|resume|update)_subscription|^(create|update)_(price|product|discount|customer|address|business)|activate_subscription/i, ASK]
  ],
  checkout: [
    // Tools are namespaced (developer-documentation___docs_search, payment-operations___get_payment).
    [/(^|_)(get|list|search|retrieve|fetch|docs_search|docs_fetch|api_search|guide)(_|$)/i, READ],
    [/(refund|capture|void|payout|transfer|create_payment|request_payment|payment_link)/i, SEND_HARD('takes, refunds or moves money through Checkout.com')],
    [/(dispute).*(accept|submit|evidence)|(accept|submit)_.*dispute/i, ASK]
  ],
  morningstar: [[/./, READ]],
  factset: [[/./, READ]],
  pitchbook: [[/./, READ]],
  kensho: [[/./, READ]],
  financialdatasets: [[/./, READ]],
  // Sales & marketing
  zoominfo: [
    // Lookups spend ZoomInfo credits but change nothing.
    [/^(search|enrich|lookup|get|account_research|contact_research|conversation_intelligence)/i, READ]
  ],
  clay: [
    [/^(get|list)-/i, READ],
    // Finding and enriching spends Clay credits.
    [/(find-and-enrich|add-.*data-points)/i, ASK]
  ],
  lusha: [
    [/(search|enrich|lookup|get|list|prospect)/i, READ]
  ],
  nutshell: [
    [/^(get|list|fetch|search|nutshell_(events|leads_report|list|search|get))/i, READ]
  ],
  beehiiv: [
    [/^(get|list|search)_/i, READ],
    // A post that's sent or scheduled goes to every subscriber; broadcast emails too.
    [/(send|schedule|publish|broadcast)/i, SEND_HARD('sends or publishes to your beehiiv subscribers')],
    [/^(ban|remove|unsubscribe)_|delete_/i, DESTROY]
  ],
  windsor: [
    [/^(get|list|search)_/i, READ],
    [/^(execute_action|create_destination_task)$/i, SEND_HARD('changes ads or posts through Windsor.ai')]
  ],
  vidiq: [
    [/^vidiq_/i, READ]
  ],
  // Support & communication
  pylon: [
    [/^(get|list|search)_/i, READ],
    [/(send|reply|post_message)/i, SEND_HARD('replies to customers through Pylon')],
    [/^(create|update)_issue$/i, ASK]
  ],
  ringcentral: [
    // manage_* tools post, edit and delete chat messages and webhooks.
    [/^manage_(post|chat_item|incoming_webhook|adaptive_card)$/i, SEND_HARD('posts or changes messages in RingCentral team chat')],
    [/^manage_team$/i, ASK],
    [/^(read_team_chat|find_person|about_)/i, READ]
  ],
  // Productivity & design
  lucid: [
    [/(share_document|share_link)/i, ASK],
    [/^(search|fetch)$/i, READ]
  ],
  mural: [
    [/(share|invite)/i, ASK],
    [/^(get|list|search)/i, READ]
  ],
  excalidraw: [
    // Export uploads the drawing to excalidraw.com behind a shareable link.
    [/^export_to_excalidraw$/i, ASK],
    [/^(read_me|create_view|read_checkpoint)$/i, READ],
    [/^save_checkpoint$/i, { effect: 'write_external', consequential: false }]
  ],
  craft: [
    [/_(get|list|search)$|^(search|get|list)/i, READ]
  ],
  evernote: [
    [/^(search|get|list|find|read)/i, READ]
  ],
  otter: [[/./, READ]],
  fathom: [[/./, READ]],
  tldv: [[/./, READ]],
  typeform: [
    [/^(get|list|retrieve)_/i, READ],
    [/(publish|share)/i, ASK]
  ],
  gsheets: [
    [/^get_/i, READ]
  ],
  gslides: [
    [/^read_/i, READ]
  ],
  cloudinary: [
    [/^(list|get|search|download)-|^asset-.*-(get|list)$/i, READ]
  ],
  lottiefiles: [
    [/^(get|list|search)/i, READ]
  ],
  // Code
  jam: [[/./, READ]],
  newrelic: [
    [/^(analyze|get|list|search|run_nrql|execute_nrql|natural_language|fetch|query)/i, READ]
  ],
  axiom: [
    [/^(query|list|get|check|search)/i, READ]
  ],
  digitalocean: [
    // New droplets, apps and databases start billing; power and resize change running servers.
    [/(destroy|delete)/i, DESTROY],
    [/(^|[-_])(list|get|describe|logs?|info)([-_]|$)/i, READ],
    [/(create|resize|rebuild|restore|power|reboot|shutdown|deploy|redeploy|rollback|attach|detach|snapshot|update|assign)/i, ASK]
  ],
  fly: [
    [/(destroy|delete)/i, DESTROY],
    [/(^|[-_])(list|status|logs?|get|show|info)([-_]|$)/i, READ],
    [/(create|deploy|launch|run|start|stop|restart|scale|update|secrets?|set|suspend|resume|clone|extend)/i, ASK]
  ],
  sanity: [
    // Publishing puts content on the live site.
    [/^publish|_publish/i, SEND_HARD('publishes content to your live site through Sanity')],
    [/^(deploy_schema|create_project|create_dataset|add_cors_origin|discard_drafts|unpublish)/i, ASK],
    [/^(get|list|query|search|read)_/i, READ]
  ],
  workos: [
    [/^(query|whoami|list_operations)$/i, READ],
    [/^mutate$/i, ASK]
  ],
  rootly: [
    // New incidents and alerts page the people on call.
    [/^(create_incident|create_alert|create_alert_event|add_responders?)$|^(page|escalate)_/i, SEND_HARD('pages or notifies people through Rootly')],
    [/^(resolve|acknowledge|mitigate|cancel|update)_(incident|alert)/i, ASK],
    [/^(get|list|search|collect|check|find)_/i, READ]
  ],
  browserstack: [
    [/^(fetch|get|list|search)/i, READ]
  ],
  mintlify: [
    [/(publish|deploy|merge)/i, ASK],
    [/^(get|list|search|read)/i, READ]
  ],
  'aws-knowledge': [[/./, READ]],
  svelte: [[/./, READ]],
  'twilio-docs': [[/./, READ]],
  // Data & analytics
  clickhouse: [
    [/^(run_select_query|get_|list_|describe_)/i, READ]
  ],
  motherduck: [
    [/^query_rw$/i, ASK],
    [/^(query|list_|search_catalog|ask_docs)/i, READ]
  ],
  thoughtspot: [
    // Analysis sessions are private to the user; a new Liveboard is visible to others.
    [/^(create_analysis_session|send_session_message)$/i, { effect: 'write_external', consequential: false }],
    [/^create_dashboard$/i, ASK],
    [/^(get_|check_)/i, READ]
  ],
  montecarlo: [
    [/^(get|search|list)/i, READ]
  ],
  datahub: [
    [/^(search|get|list|compare)/i, READ]
  ],
  felt: [
    [/^share_map$/i, ASK],
    [/^(who_am_i|get_|list_)/i, READ]
  ],
  // HR & recruiting
  greenhouse: [
    [/^(get|list|search)_/i, READ],
    [/(send|email)/i, SEND_HARD('emails candidates through Greenhouse')],
    [/^(anonymize|delete|merge)_|^bulk_delete/i, DESTROY],
    [/(hire|reject|offer|advance|move_application|activate_user|deactivate|bulk_)/i, ASK]
  ],
  ashby: [
    [/^(describe|filter|search|get)_/i, READ]
  ],
  remote: [
    [/^(get|list)_/i, READ],
    // Payroll and expense approvals pay people.
    [/(payroll|approve|payment|reimburse)/i, SEND_HARD('approves pay or expenses in Remote')]
  ],
  indeed: [[/./, READ]],
  dice: [[/./, READ]],
  // Legal
  pandadoc: [
    [/(send|resend)_?document|^send/i, SEND_HARD('sends documents for signature through PandaDoc')],
    [/^(get|list|search|download)/i, READ]
  ],
  clio: [
    [/^(get|search|list|continue_conversation|export_document)/i, READ]
  ],
  midpage: [[/./, READ]],
  // Travel & real estate
  kiwi: [
    [/^search-flight$/i, READ],
    [/^feedback-to-devs$/i, ASK]
  ],
  trivago: [[/./, READ]],
  zillow: [[/./, READ]],
  biggerpockets: [[/./, READ]],
  // Education & science, health & fitness
  wolfram: [[/./, READ]],
  consensus: [
    [/^(search|get|find)/i, READ]
  ],
  scite: [[/./, READ]],
  wiley: [[/./, READ]],
  udemy: [[/./, READ]],
  strava: [[/./, READ]],
  // On this Mac
  xcode: [
    // ExecuteSnippet runs code in your project's context.
    [/^ExecuteSnippet$/i, ASK],
    [/^Xcode(RM|Remove|Delete)/i, DESTROY],
    [/^(XcodeWrite|XcodeUpdate|XcodeMV|XcodeMakeDir|BuildProject|RunAllTests|RunSomeTests|RunTests|XcodeRefreshCodeIssuesInFile)$/i, { effect: 'write_external', consequential: false }],
    [/^(XcodeRead|XcodeGrep|XcodeGlob|XcodeLS|XcodeList|GetBuildLog|GetTestList|RenderPreview|DocumentationSearch)/i, READ]
  ],
  'figma-desktop': [
    [/^(get_|whoami|create_design_system_rules)/i, READ]
  ]
}

/** Money moves are always a hard stop, whatever the app (create_refund, create_payout, transfer_funds). */
const MONEY = /(^|[_\-.])(refund|payout|pay|charge|capture|transfer|purchase|buy|checkout)([_\-.]|$)|[a-z](Refund|Payout|Charge|Capture|Transfer|Purchase|Buy)([A-Z]|$)/
/** Publishing or sending to other people asks even in Auto mode. */
const OUTWARD = /(^|[_\-.])(send|post|publish|tweet|reply|forward|invite|share|broadcast|deploy|merge)([_\-.]|$)|[a-z](Send|Post|Publish|Reply|Forward|Invite|Share|Deploy|Merge)([A-Z]|$)|^(send|post|publish|reply|forward|invite|share|deploy|merge)[A-Z]/

/**
 * What one connector tool may do. Gmail's tools are mapped by name (read vs. labels vs. trash vs.
 * send, and sending always asks); catalog apps with an EFFECT_MAPS entry go by their well-known tool
 * names; everything else by MCP annotations and verbs, with unknown tools treated as write_external.
 */
export function toolPolicy(preset: string | undefined, name: string, ann?: { readOnlyHint?: boolean; destructiveHint?: boolean }, args?: unknown): ToolPolicy {
  if (preset === 'gmail') return gmailPolicy(name, ann)
  const words = `${name.replace(/[_\-.]+/g, ' ')} ${JSON.stringify(args ?? {}).slice(0, 200)}`
  const rule = EFFECT_MAPS[preset ?? '']?.find(([re]) => re.test(name))?.[1]
  if (rule) return { effect: rule.effect, consequential: rule.consequential ?? (rule.effect !== 'read' && CONSEQUENTIAL.test(words)), ...(rule.hardStop ? { hardStop: rule.hardStop } : {}) }
  const effect = effectFor(name, ann)
  if (effect !== 'read' && MONEY.test(name)) return { effect: effect === 'destructive' ? 'destructive' : 'write_external', consequential: true, hardStop: 'moves money or buys something' }
  // Tool names use underscores (send_email), which regex word boundaries don't split on.
  return { effect, consequential: effect !== 'read' && (OUTWARD.test(name) || CONSEQUENTIAL.test(words)) }
}

// ---------------------------------------------------------------- Google: one OAuth client for Gmail, Calendar and Drive

export const GOOGLE_PRESETS = ['gmail', 'gcal', 'gdrive', 'gdocs', 'gsheets', 'gslides', 'bigquery']
const GOOGLE_CLIENT_KEY = 'google:oauthClient'
/** The error for an app that needs its one-time OAuth app first. */
export function setupNeeded(p: Pick<ConnectorPreset, 'name' | 'setup'>): string {
  return `${p.name} needs a one-time setup (about ${p.setup?.minutes ?? 5} minutes): open Connect apps → ${p.name} and follow the steps, then it connects with one click.`
}

// ---------------------------------------------------------------- API keys (official servers that take the user's own key)
//
// The key lives in the Keychain under mcp:<id>:apiKey. It's put on each request as it's built (a
// header, or a query parameter on a copy of the URL), so the saved URL, settings, status text and
// errors never contain it; every error from such a server is redacted before it's shown or stored.

const keySecret = (id: string): string => `mcp:${id}:apiKey`

/**
 * API-key apps SahilBot talks to natively (its own tool, no MCP server): where the key lives and the one
 * cheap read that verifies it. Their tile works like any API-key app's; there's no connector config.
 */
export const NATIVE_KEY_APPS: Record<string, { secret: string; tools: string[]; verify(key: string, f?: ResendFetch): Promise<{ ok: true } | { ok: false; error: string }> }> = {
  resend: { secret: RESEND_KEY_SECRET, tools: ['resend'], verify: (key, f) => verifyResendKey(f ?? ((url, init) => fetch(url, { ...init, redirect: 'error' }) as never), key) }
}
export const isNativeKeyApp = (id: string | undefined): boolean => !!id && Object.prototype.hasOwnProperty.call(NATIVE_KEY_APPS, id)

/**
 * The API key on the clipboard, if it looks like one for this app: the whole clipboard (trimmed, quotes and a
 * "Bearer " dropped), or the one token in it that matches the app's known prefix. Null otherwise; the
 * clipboard's text is never echoed back.
 */
export function keyFromClipboard(text: string, p: Pick<ConnectorPreset, 'name' | 'apiKey'>): string | null {
  if (!p.apiKey) return null
  const raw = String(text ?? '').slice(0, 4096)
  const whole = normalizeApiKey(raw, p.apiKey)
  if (!validateApiKey(whole, p)) return whole
  if (!p.apiKey.pattern) return null
  const re = new RegExp(p.apiKey.pattern.replace(/^\^/, '').replace(/\$$/, ''))
  const hits = raw.split(/[\s"'`,;]+/).filter((t) => re.test(t) && !validateApiKey(t, p))
  return hits.length === 1 ? hits[0] : null
}

/** The error for an API-key app that has no key yet. */
export function apiKeyNeeded(p: Pick<ConnectorPreset, 'name'>): string {
  return `${p.name} needs your ${p.name} API key: open Connect apps → ${p.name}, paste the key, and it connects.`
}

/** A pasted key, tidied: outer spaces and quotes go, and a "Bearer " the format adds anyway is dropped. */
export function normalizeApiKey(raw: string, spec: Pick<ConnectorApiKey, 'format'>): string {
  let k = String(raw ?? '').trim().replace(/^["'`]+|["'`]+$/g, '').trim()
  const prefix = /^(\S+\s+)\{key\}/.exec(spec.format ?? '')?.[1]
  if (prefix && k.toLowerCase().startsWith(prefix.toLowerCase())) k = k.slice(prefix.length).trim()
  return k
}

/** Problems with a pasted key, or null when it looks right (the server has the final say). */
export function validateApiKey(key: string, p: Pick<ConnectorPreset, 'name' | 'apiKey'>): string | null {
  const k = String(key ?? '')
  if (!k) return `Paste your ${p.name} API key.`
  if (/\s/.test(k)) return 'The key has spaces or line breaks in it; copy it again.'
  if (!/^[\x21-\x7e]+$/.test(k) || k.length < 8 || k.length > 512) return `That doesn't look like a ${p.name} API key; copy it again.`
  if (p.apiKey?.pattern && !new RegExp(p.apiKey.pattern).test(k)) return `That doesn't look like a ${p.name} API key${p.apiKey.placeholder ? ` (they look like ${p.apiKey.placeholder})` : ''}.`
  return null
}

/** Same scheme, host and port (an API key is sent only to its preset's own server). */
export function sameOrigin(a: string | undefined, b: string): boolean {
  try { return !!a && new URL(a).origin === new URL(b).origin } catch { return false }
}

/** The URL and headers for one connection: the key goes in only here, at request time. */
export function apiKeyRequest(url: string, spec: ConnectorApiKey, key: string): { url: URL; headers: Record<string, string> } {
  const u = new URL(url)
  if (spec.in === 'query') { u.searchParams.set(spec.name, key); return { url: u, headers: {} } }
  return { url: u, headers: { [spec.name]: (spec.format ?? '{key}').replace('{key}', key) } }
}

/**
 * Text with secrets taken out: the exact values given (and their URL-encoded forms), plus anything
 * shaped like a credential (key=… query parameters, Bearer tokens), so a server or SDK error that
 * echoes a request can't leak a key into the UI, settings or logs.
 */
export function redactSecret(text: string, ...secrets: Array<string | undefined | null>): string {
  let t = String(text ?? '')
  for (const s of secrets) {
    if (!s || s.length < 4) continue
    for (const v of new Set([s, encodeURIComponent(s)])) t = t.split(v).join('••••')
  }
  return t
    .replace(/((?:^|[?&\s,;("'])(?:x-)?(?:api[_-]?key|apikey|key|token|access[_-]?token|auth|secret)\s*[=:]\s*)(?!••••)[^&\s"'<>,;)]+/gi, '$1••••')
    .replace(/\b(Bearer|Token|Basic)\s+(?!••••)[A-Za-z0-9._~+/=-]{8,}/g, '$1 ••••')
}

/** A refused key, in plain words with where to get a new one. */
export function explainKeyError(message: string, p: Pick<ConnectorPreset, 'name' | 'apiKey'>): string {
  const m = String(message ?? '')
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[_ ]?(api[_ ]?)?(key|token)|UnauthorizedError/i.test(m)) {
    return `${p.name} didn't accept the API key. Make a new one${p.apiKey ? ` at ${p.apiKey.getKeyUrl}` : ''} and paste it under Connect apps → ${p.name}.`
  }
  return m
}

export const GOOGLE_SETUP_NEEDED = 'Google apps need a one-time setup (about 5 minutes): open Connect apps → Gmail → "Set up Google once", then connect again.'

/** Problems with a pasted Google OAuth client, or null when it looks right. */
export function validateGoogleClient(clientId: string, clientSecret?: string): string | null {
  const id = String(clientId ?? '').trim()
  if (!id) return 'Paste the client ID.'
  if (/\s/.test(id)) return 'The client ID has spaces in it; copy it again.'
  if (!/^\d{5,}-[a-z0-9_]{8,}\.apps\.googleusercontent\.com$/i.test(id)) return 'That doesn\'t look like a Google OAuth client ID. It ends in .apps.googleusercontent.com (e.g. 1234567890-abc123….apps.googleusercontent.com).'
  const sec = String(clientSecret ?? '').trim()
  if (!sec) return 'Paste the client secret too (Google asks for it from Desktop apps; it starts with GOCSPX-).'
  if (/\s/.test(sec) || sec.length < 16 || sec.length > 80 || (!/^GOCSPX-/.test(sec) && !/^[A-Za-z0-9_-]{20,40}$/.test(sec))) return 'That doesn\'t look like a Google client secret (it usually starts with GOCSPX-).'
  return null
}

// ---------------------------------------------------------------- health

/** Wait before reconnect attempt n (1-based): 5s, 15s, 45s, 2m15s… capped at 10 minutes. */
export function backoffMs(attempt: number): number {
  return Math.min(10 * 60_000, 5000 * 3 ** Math.max(0, attempt - 1))
}
export const MAX_RECONNECTS = 8

/** A sign-in that worked before was refused: the token expired and couldn't be refreshed, or was revoked. */
export function expiredText(name: string): string {
  return `Sign-in expired or was revoked. Press Reconnect to sign in to ${name} again.`
}

/** The server refused the connection's credentials (401, invalid or revoked token). */
export function isAuthError(e: unknown): boolean {
  if (e instanceof UnauthorizedError) return true
  const m = String((e as Error)?.message ?? e ?? '')
  // Not the bare word "unauthorized": servers use it for ordinary permission errors on one item.
  return /\b401\b|invalid_token|invalid_grant|token (has )?(expired|been revoked)/i.test(m)
}

/** Why a failed connect failed, for the Connect apps state: a missing setup, or a server that isn't answering. */
export function connectorReason(message: string): ConnectorStatus['reason'] | undefined {
  const m = String(message ?? '')
  if (isConnectionError(m) || /\b(502|503|504)\b|Service Unavailable|Bad Gateway|Gateway Time-?out/i.test(m)) return 'unavailable'
  if (/needs a one-time setup|need a one-time setup|needs your .{1,40} API key|didn't accept the API key|didn't accept the client ID|address was changed/i.test(m)) return 'setup'
  return undefined
}

/** Errors that mean the connection dropped (not that the tool itself failed). */
export function isConnectionError(message: string): boolean {
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|socket hang up|Not connected|Connection closed|other side closed|network (error|is down)|SSE stream disconnected/i.test(String(message ?? ''))
}

function portOf(uri?: string): number | undefined {
  try { return uri ? Number(new URL(uri).port) || undefined : undefined } catch { return undefined }
}

/** Options for one connector's sign-in. */
interface OauthOptions {
  /** A pre-registered client (Google, oauth-static apps, custom servers with a client ID). */
  staticClient?: { client_id: string; client_secret?: string }
  /** The exact redirect URL registered with the provider; the listener binds its port only when the browser opens. */
  fixedRedirect?: string
  /** Opens the browser when sign-in is needed; background connects only report "needs sign-in". */
  interactive?: boolean
  /** Scopes to ask for instead of the server's advertised set (rewritten into the authorize URL). */
  scope?: string
  /** Opens the sign-in page (default: the user's browser, see openSignIn). */
  open?: (url: string) => Promise<unknown>
  /** The app's name, for the page the browser shows after signing in ("Connected to Slack"). */
  appName?: string
  /** The provider sent the browser back with a code: bring SahilBot to the front. */
  onSignedIn?: () => void
}

/** 127.0.0.1, ::1 or localhost. */
export function isLoopbackUrl(url: string): boolean {
  try { return /^(127\.0\.0\.1|\[::1\]|localhost)$/.test(new URL(url).hostname) } catch { return false }
}

/**
 * Loads a sign-in page without a browser, following its redirects back to SahilBot's loopback
 * callback, and returns the last page's text (the callback page). Only for local fake authorization
 * servers in tests: every hop must stay on loopback.
 */
export async function headlessSignIn(url: string, fetcher: typeof fetch = fetch): Promise<string> {
  let u = url
  for (let hop = 0; hop < 6; hop++) {
    if (!isLoopbackUrl(u)) throw new Error('Headless sign-in only follows loopback addresses')
    const r = await fetcher(u, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    const loc = r.headers.get('location')
    if (!loc) return (await r.text().catch(() => '')).slice(0, 20_000)
    await r.body?.cancel().catch(() => undefined)
    u = new URL(loc, u).href
  }
  return ''
}

/** Sign-in pages a hidden (test) run asked to open: captured here, never opened in a real browser. */
export const capturedSignIns: Array<{ url: string; page?: string; at: number }> = []

/**
 * Opens a sign-in page in the user's default browser (shell.openExternal; on SahilBot Server the shim
 * asks the paired browser to open it). Never in one of SahilBot's own windows: the provider's page,
 * its cookies and the password typed there stay in the browser the user already trusts.
 *
 * A hidden test run (SAHILBOT_HIDDEN) never opens the user's browser: the URL is captured
 * (capturedSignIns, plus a JSON line in SAHILBOT_TEST_EXTERNAL_LOG when set). With
 * SAHILBOT_TEST_OAUTH_FETCH=1 a loopback page (a local fake authorization server) is then signed in
 * headlessly, and the callback page it ends on is captured too. That never applies to a real provider.
 */
export async function openSignIn(url: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.SAHILBOT_HIDDEN) {
    const rec: { url: string; page?: string; at: number } = { url, at: Date.now() }
    try {
      if (env.SAHILBOT_TEST_OAUTH_FETCH === '1' && isLoopbackUrl(url)) rec.page = await headlessSignIn(url)
    } finally {
      capturedSignIns.push(rec)
      if (env.SAHILBOT_TEST_EXTERNAL_LOG) { try { appendFileSync(env.SAHILBOT_TEST_EXTERNAL_LOG, `${JSON.stringify(rec)}\n`) } catch { /* test log only */ } }
    }
    return
  }
  await shell.openExternal(url)
}

const esc = (t: string): string => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/**
 * The page the browser tab shows after the provider sends it back to SahilBot: "Connected to <App>"
 * or what went wrong and what to do. Self-contained (no scripts, no outside requests), in SahilBot's
 * own look (the renderer's design tokens: colors, type, radius; light and dark).
 */
export function callbackPage(ok: boolean, o: { app?: string; detail?: string; hint?: string } = {}): string {
  const app = o.app?.trim() || 'the app'
  const title = ok ? `Connected to ${app}` : `Couldn’t connect ${o.app?.trim() || ''}`.trim()
  const lede = ok ? 'You can close this tab and go back to SahilBot.' : (o.hint ?? 'Go back to SahilBot and press Connect to try again.')
  const icon = ok
    ? '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
    : '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 7v6"/><path d="M12 17h.01"/></svg>'
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${esc(title)} · SahilBot</title>
<style>
:root{--bg:#fff;--card:#fff;--line:#e7e7e5;--text:#121212;--text-2:#5e5e5e;--text-3:#9a9a9a;--soft:#f4f3ef;--accent:#ff6a1a;--ok:#30a46c;--danger:#e5484d;--font:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif;--shadow:0 1px 2px rgba(0,0,0,.04),0 4px 16px rgba(0,0,0,.06);color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--card:#1f1f1e;--line:#2c2c2a;--text:#ededec;--text-2:#a8a8a6;--text-3:#6f6f6d;--soft:#232322;--shadow:0 1px 2px rgba(0,0,0,.3),0 4px 16px rgba(0,0,0,.35);color-scheme:dark}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 var(--font);display:grid;place-items:center;padding:24px;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:22px;box-shadow:var(--shadow);padding:32px 28px 26px;text-align:center}
.mark{width:52px;height:52px;border-radius:16px;display:grid;place-items:center;margin:0 auto 18px;color:#fff;background:${ok ? 'var(--ok)' : 'var(--danger)'}}
h1{font-size:21px;line-height:1.25;margin:0 0 8px;font-weight:650;letter-spacing:-.01em}
p{margin:0;color:var(--text-2)}
.detail{margin-top:16px;padding:10px 12px;border-radius:12px;background:var(--soft);color:var(--text-2);font-size:13px;text-align:left;word-break:break-word}
.brand{margin-top:22px;display:flex;align-items:center;justify-content:center;gap:7px;color:var(--text-3);font-size:12.5px}
.brand i{width:9px;height:9px;border-radius:3px;background:var(--accent);display:inline-block}
</style></head>
<body><main data-result="${ok ? 'connected' : 'error'}">
<div class="mark">${icon}</div>
<h1>${esc(title)}</h1>
<p>${esc(lede)}</p>
${!ok && o.detail ? `<div class="detail">${esc(o.detail.slice(0, 300))}</div>` : ''}
<div class="brand"><i></i>SahilBot</div>
</main></body></html>`
}

/** What to do after a provider sent back an error instead of a code (shown on the callback page). */
function callbackHint(err: string | null, stateBad: boolean): string {
  if (stateBad) return 'This sign-in link was out of date. Go back to SahilBot and press Connect again.'
  if (err === 'access_denied') return 'Sign-in was cancelled or access wasn\'t allowed. Go back to SahilBot and press Connect to try again.'
  if (err === 'invalid_scope') return 'The app refused the permissions SahilBot asked for. Go back to SahilBot: it shows what to change.'
  if (err && /client|redirect/i.test(err)) return 'The app didn\'t accept SahilBot\'s sign-in settings. Go back to SahilBot: it shows what to fix.'
  return 'Go back to SahilBot and press Connect to try again.'
}

export class Oauth implements OAuthClientProvider {
  private port = 0
  private servers: Server[] = []
  private waiter: { resolve: (code: string) => void; reject: (e: Error) => void } | null = null
  /** A callback that arrived before waitForCode (fast consent pages). */
  private early: { code?: string; error?: Error } | null = null
  private stateValue = randomUUID()
  private staticClient?: { client_id: string; client_secret?: string }
  private fixedRedirect?: string
  private interactive: boolean
  private scopeOverride?: string
  private open: (url: string) => Promise<unknown>
  private appName?: string
  private onSignedIn?: () => void
  /** Leave out the RFC 8707 resource indicator (a server that answered invalid_target). */
  noResource = false

  constructor(private id: string, private secrets: Secrets, opts: OauthOptions | { client_id: string; client_secret?: string } = {}, interactive?: boolean) {
    // Older call shape: (id, secrets, staticClient?, interactive?).
    const o: OauthOptions = 'client_id' in opts ? { staticClient: opts, interactive } : { ...opts, interactive: opts.interactive ?? interactive }
    this.staticClient = o.staticClient
    this.fixedRedirect = o.fixedRedirect
    this.interactive = o.interactive ?? true
    this.scopeOverride = o.scope
    this.open = o.open ?? ((u) => openSignIn(u))
    this.appName = o.appName
    this.onSignedIn = o.onSignedIn
    this.noResource = this.read<boolean>('noResource') ?? false
  }

  /**
   * After a connect: a later 401 (health check, tool call) must never pop a browser window up on its
   * own. It turns into "needs sign-in again" instead, and Reconnect signs in.
   */
  background(): void { this.interactive = false }
  /** This connector has signed in successfully before (so a refused sign-in now means it expired or was revoked). */
  signedInBefore(): boolean { return !!this.read('signedIn') }

  private key(k: string): string { return `mcp:${this.id}:${k}` }
  private read<T>(k: string): T | undefined {
    const v = this.secrets.get(this.key(k))
    try { return v ? (JSON.parse(v) as T) : undefined } catch { return undefined }
  }
  private write(k: string, v: unknown): void { this.secrets.set(this.key(k), v === undefined ? null : JSON.stringify(v)) }

  /** Remembers that this server rejects resource indicators, for the next sign-in. */
  dropResource(): void { this.noResource = true; this.write('noResource', true) }

  private handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    // Only the fixed callback path counts; anything else (favicon, prefetch) is ignored.
    if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return }
    const code = u.searchParams.get('code')
    const err = u.searchParams.get('error')
    if (!code && !err) { res.writeHead(404); res.end(); return } // prefetch or reload
    const desc = u.searchParams.get('error_description') ?? undefined
    // CSRF (RFC 6749 §10.12): a code counts only with this sign-in's own state. An error without one
    // is still reported as that error; a wrong state never is.
    const state = u.searchParams.get('state')
    const stateBad = code ? state !== this.stateValue : !!state && state !== this.stateValue
    const ok = !err && !stateBad
    res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' })
    res.end(callbackPage(ok, { app: this.appName, detail: stateBad ? undefined : desc ?? err ?? undefined, hint: callbackHint(err, stateBad) }))
    // Back to SahilBot: the browser tab has done its job.
    if (ok) { try { this.onSignedIn?.() } catch { /* focus is best effort */ } }
    const out: { code?: string; error?: Error } = stateBad
      ? { error: new Error('Sign-in state mismatch') }
      : err ? { error: new Error(`Sign-in failed: ${err}${desc ? ` (${desc.slice(0, 200)})` : ''}`) } : { code: code! }
    if (!this.waiter) { this.early = out; return }
    if (out.error) this.waiter.reject(out.error)
    else this.waiter.resolve(out.code!)
  }

  private bind(server: Server, port: number, host: string): Promise<boolean> {
    return new Promise((ok) => {
      const fail = (): void => { server.off('listening', done); ok(false) }
      const done = (): void => { server.off('error', fail); ok(true) }
      server.once('error', fail).once('listening', done).listen(port, host)
    })
  }

  /** Binds the fixed redirect port on 127.0.0.1 (and ::1, for "localhost" redirect URLs). */
  private async bindFixed(): Promise<void> {
    if (this.servers.length) return
    const u = new URL(this.fixedRedirect!)
    const port = Number(u.port)
    const v4 = createServer(this.handler)
    if (!(await this.bind(v4, port, '127.0.0.1'))) {
      throw new Error(`SahilBot couldn't open its sign-in port ${port} (another sign-in may still be waiting). Finish or close it, then press Connect again.`)
    }
    this.servers.push(v4)
    if (u.hostname === 'localhost') {
      const v6 = createServer(this.handler)
      if (await this.bind(v6, port, '::1')) this.servers.push(v6)
    }
    this.port = port
  }

  /** A loopback listener on 127.0.0.1 receives the redirect (RFC 8252). Fixed redirects bind when the browser opens. */
  async listen(): Promise<void> {
    if (this.fixedRedirect) { this.port = Number(new URL(this.fixedRedirect).port); return }
    if (this.servers.length) return
    const server = createServer(this.handler)
    // The registered client's redirect_uris name this port, so keep it across connects.
    const saved = this.read<number>('port') ?? portOf(this.read<{ redirect_uris?: string[] }>('client')?.redirect_uris?.[0])
    if (!saved || !(await this.bind(server, saved, '127.0.0.1'))) {
      if (!(await this.bind(server, 0, '127.0.0.1'))) throw new Error('Could not open a local port for sign-in')
      // A client registered for another port would be rejected (redirect_uri mismatch): register again.
      if (saved) this.write('client', undefined)
    }
    this.servers.push(server)
    this.port = (server.address() as AddressInfo).port
    if (this.port !== saved) this.write('port', this.port)
  }

  close(): void {
    for (const s of this.servers) s.close()
    this.servers = []
  }

  waitForCode(ms = 300_000): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.early) { const e = this.early; this.early = null; if (e.error) reject(e.error); else resolve(e.code!); return }
      const t = setTimeout(() => reject(new Error('Sign-in timed out after 5 minutes')), ms)
      this.waiter = { resolve: (c) => { clearTimeout(t); resolve(c) }, reject: (e) => { clearTimeout(t); reject(e) } }
    })
  }

  get redirectUrl(): string { return this.fixedRedirect ?? `http://127.0.0.1:${this.port}/callback` }
  get clientMetadata() {
    return {
      client_name: 'SahilBot',
      redirect_uris: this.fixedRedirect ? [this.fixedRedirect] : [this.redirectUrl, `http://localhost:${this.port}/callback`],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.scopeOverride ? { scope: this.scopeOverride } : {})
    }
  }
  state(): string { return this.stateValue }
  clientInformation() { return this.staticClient ?? this.read<any>('client') }
  saveClientInformation(info: unknown): void {
    // A pre-registered client is never replaced by the SDK's issuer-stamped copy.
    if (this.staticClient) return
    this.write('client', info)
    this.write('port', this.port)
  }
  tokens() { return this.read<any>('tokens') }
  saveTokens(t: unknown): void { this.write('tokens', t); this.write('signedIn', true) }

  /**
   * RFC 8707: send the server's resource indicator verbatim (a pathless one keeps its exact form),
   * or none for a server that rejected it. A resource on another origin is refused.
   */
  async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
    if (this.noResource || !resource) return undefined
    const server = new URL(String(serverUrl))
    let r: URL
    try { r = new URL(resource) } catch { return undefined }
    if (r.origin !== server.origin) throw new Error(`The server's sign-in metadata names another site (${r.origin}); SahilBot won't send your sign-in there.`)
    return resource as unknown as URL
  }

  // Background connects (at launch) never open the browser; the connector shows "needs sign-in" instead.
  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.interactive) return
    if (this.scopeOverride) url.searchParams.set('scope', this.scopeOverride)
    if (this.fixedRedirect) await this.bindFixed()
    await this.open(url.toString())
  }
  saveCodeVerifier(v: string): void { this.write('verifier', v) }
  codeVerifier(): string { return this.read<string>('verifier') ?? '' }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'client') this.write('client', undefined)
    if (scope === 'all' || scope === 'tokens') this.write('tokens', undefined)
    if (scope === 'all' || scope === 'verifier') this.write('verifier', undefined)
    if (scope === 'all') { this.write('port', undefined); this.write('noResource', undefined); this.write('signedIn', undefined) }
  }
  hasTokens(): boolean { return !!this.read('tokens') }
}

/**
 * Plain words for sign-in failures, with the fix. `setup` is the app's one-time setup guide when it
 * has one; `redirect` is the URL a pre-registered client must use.
 */
export function explainAuthError(message: string, ctx: { name: string; url?: string; hasSetup?: boolean; staticClient?: boolean; redirect?: string; builtin?: boolean }): string {
  const m = String(message ?? '')
  const host = (() => { try { return new URL(ctx.url ?? '').host } catch { return ctx.name } })()
  const redirect = ctx.redirect ?? setupRedirect()
  // SahilBot's own app registration was refused: nothing the user typed is wrong; their own app is the way round it.
  if (ctx.builtin && /redirect_uri|redirect url|redirect uri|invalid_client|unauthorized_client|client.*(not found|unknown|invalid)|invalid_scope/i.test(m)) {
    return `${ctx.name} didn't accept SahilBot's own ${ctx.name} app right now (${/invalid_scope/i.test(m) ? 'permissions' : /redirect/i.test(m) ? 'redirect URL' : 'client'}). Press Connect to try again; if it keeps happening, open Connect apps → ${ctx.name} → "Use your own app".`
  }
  if (/does not support dynamic client registration|registration.*(not (supported|allowed|enabled))|invalid_client_metadata|invalid_redirect_uri|unapproved_software_statement|(registration|register).*\b(40[0-5])\b/i.test(m) && !ctx.staticClient) {
    return ctx.hasSetup
      ? `${ctx.name} needs a one-time setup: open Connect apps → ${ctx.name} and follow the steps (you create a small OAuth app there and paste its client ID).`
      : `This app needs a one-time setup: ${host} doesn't let apps register themselves for sign-in. Create an OAuth app in its developer settings with the redirect URL ${redirect}, then add it under Connect apps → Custom server → "OAuth client" with that app's client ID (and secret, if it gives one).`
  }
  if (/does not support code challenge method S256/i.test(m)) return `${ctx.name}'s sign-in doesn't support PKCE (S256), which SahilBot requires to keep the sign-in safe. Ask the provider for an API key and add it as a header under Custom server.`
  if (/redirect_uri|redirect url|redirect uri/i.test(m)) return `${ctx.name} rejected the redirect URL. In your ${ctx.name} app settings it has to be exactly ${redirect} (no trailing slash), then press Connect again.`
  if (/invalid_client|unauthorized_client|client.*(not found|unknown|invalid)/i.test(m) && ctx.staticClient) return `${ctx.name} didn't accept the client ID${/secret/i.test(m) ? ' or secret' : ''}. Check you copied them from the right app (Connect apps → ${ctx.name} → Change setup).`
  if (/invalid_scope/i.test(m)) return `${ctx.name} refused the permissions SahilBot asked for (invalid_scope).${ctx.staticClient ? ` Add the scopes listed in the setup steps to your ${ctx.name} app, then connect again.` : ''}`
  if (/access_denied/i.test(m)) return `Sign-in was cancelled or ${ctx.name} denied access. Press Connect to try again.`
  if (/state mismatch/i.test(m)) return 'The sign-in link was out of date. Press Connect again.'
  if (/^Sign-in timed out/i.test(m)) return `Sign-in to ${ctx.name} didn't finish in the browser within 5 minutes. Press Connect to open it again.`
  return m
}

export class Connectors {
  private live = new Map<string, Live>()
  private status = new Map<string, ConnectorStatus>()
  /** Pending automatic reconnects and how many tries each has had. */
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private attempts = new Map<string, number>()
  private healthTimer: ReturnType<typeof setInterval> | null = null

  constructor(private db: Db, private secrets: Secrets, private registry: ToolRegistry, private changed: () => void, private opts: {
    /** Opens a sign-in page (default openSignIn: the user's browser; captured in hidden test runs). */
    openExternal?: (url: string) => Promise<unknown>
    /** SahilBot's own app registrations (resources/oauth-clients.json, see oauth-clients.ts). */
    oauthClients?: BuiltinClients
    /** A provider sent the browser back with a code: bring SahilBot to the front. */
    onSignedIn?: (name: string) => void
    /** Verifying native API keys (tests pass a fake; default: fetch). */
    fetch?: ResendFetch
  } = {}) {}

  /** The built-in client for a catalog app (its own, or Google's shared one), if SahilBot ships one. */
  builtin(preset: Pick<ConnectorPreset, 'id' | 'auth'> | string | undefined): BuiltinClient | undefined {
    const p = typeof preset === 'string' ? PRESETS.find((x) => x.id === preset) : preset
    return builtinFor(this.opts.oauthClients ?? {}, p)
  }

  /** A catalog entry as the UI sees it: `builtinClient` marks apps that connect with SahilBot's own app registration. */
  private decorate(p: ConnectorPreset): ConnectorPreset {
    return this.builtin(p) ? { ...p, builtinClient: true } : p
  }

  /** The catalog for Connect apps and in-chat cards (built-in clients flagged; secrets never leave main). */
  presets(): ConnectorPreset[] {
    return PRESETS.map((p) => this.decorate(p))
  }

  /** Connects with one click right now: one-click in the catalog, or the user already set up their own app or key. */
  private ready(p: ConnectorPreset): boolean {
    if (isOneClick(p)) return true
    const cfg = this.list().find((c) => c.preset === p.id)
    if (p.auth === 'oauth-static') return !!cfg?.clientId
    if (p.auth === 'google') return !!(cfg?.clientId || this.googleClient())
    if (isNativeKeyApp(p.id)) return !!this.secrets.get(NATIVE_KEY_APPS[p.id].secret)
    if (p.auth === 'apikey') return !!(cfg && this.secrets.get(keySecret(cfg.id)))
    return false
  }

  list(): ConnectorConfig[] {
    return this.db.getSetting<ConnectorConfig[]>('connectors') ?? []
  }

  /** Catalog entries that match a request and aren't connected yet (for in-chat connect cards): by name first, then by what they do ("seo" → Semrush). */
  suggest(query: string, o: { fullName?: boolean } = {}): ConnectorPreset[] {
    const q = query.toLowerCase()
    const connected = new Set(this.list().filter((c) => this.status.get(c.id)?.state === 'connected').map((c) => c.preset))
    const words = q.split(/[^a-z0-9.]+/).filter((w) => w.length > 2)
    const open = this.presets().filter((p) => p.id !== 'custom' && !connected.has(p.id) && p.auth !== 'browser' && p.auth !== 'app' && !(isNativeKeyApp(p.id) && this.ready(p)))
    const readyNow = new Map(open.map((p) => [p.id, this.ready(p)]))
    // Only apps the request names in full AND asks to use ("my google calendar", "add it to notion"): for a
    // find_tools search that also matched built-in tools, so "calendar" still means the built-in one, "browser"
    // isn't Browserbase, and researching an app ("notion vs obsidian pricing") never asks to connect it.
    if (o.fullName) return open.filter((p) => usesApp(q, p.name)).sort((a, b) => Number(readyNow.get(b.id)) - Number(readyNow.get(a.id)))
    // Everyday words don't pick apps by name either ("data" isn't a request for Datadog or Crustdata).
    const byName = open.filter((p) => words.some((w) => !SUGGEST_STOP.has(w) && (p.name.toLowerCase().includes(w) || p.id.startsWith(w))))
    const byUse = open.filter((p) => !byName.includes(p) && words.some((w) => !SUGGEST_STOP.has(w) && p.description.toLowerCase().split(/[^a-z0-9]+/).includes(w)))
    // Apps that connect in one click right now first within each group: the in-chat card connects them at once.
    const ready = (xs: ConnectorPreset[]): ConnectorPreset[] => [...xs.filter((p) => readyNow.get(p.id)), ...xs.filter((p) => !readyNow.get(p.id))]
    return [...ready(byName), ...ready(byUse)]
  }

  /**
   * One-click connect for a catalog entry: OAuth opens the provider's page in the user's browser. Apps
   * without self-registration use SahilBot's built-in client, else the user's own (their one-time
   * setup, or "Set up Google once" for Google apps).
   */
  async connectPreset(id: string): Promise<ConnectorStatus> {
    const p = PRESETS.find((x) => x.id === id)
    if (p && isNativeKeyApp(p.id)) {
      if (!this.ready(p)) throw new Error(apiKeyNeeded(p))
      return this.nativeStatus(p.id)
    }
    if (!p || p.auth === 'browser' || p.auth === 'app' || !p.url) throw new Error('This connector needs setup in Connect apps.')
    if (p.unavailable) throw new Error(p.unavailable)
    const existing = this.list().find((c) => c.preset === id)
    const builtin = this.builtin(p)
    if (p.auth === 'google' && !builtin && !existing?.clientId && !this.googleClient()) throw new Error(GOOGLE_SETUP_NEEDED)
    if (p.auth === 'oauth-static' && !builtin && !existing?.clientId) throw new Error(setupNeeded(p))
    if (p.auth === 'apikey' && !(existing && this.secrets.get(keySecret(existing.id)))) throw new Error(apiKeyNeeded(p))
    const cfg = existing ?? this.save({ name: p.name, kind: 'remote', url: p.url, preset: p.id, enabled: true })
    return this.connect(cfg.id, true)
  }

  // ---------------------------------------------------------------- Google OAuth client (shared by Gmail, Calendar, Drive)

  /** The saved Google client (the ID only; the secret stays in the Keychain). */
  googleClient(): { clientId: string; hasSecret: boolean } | null {
    const raw = this.secrets.get(GOOGLE_CLIENT_KEY)
    if (!raw) return null
    try {
      const v = JSON.parse(raw) as { clientId?: string; clientSecret?: string }
      return v.clientId ? { clientId: v.clientId, hasSecret: !!v.clientSecret } : null
    } catch { return null }
  }

  /** Saves the Google client once for every Google app; already-added Google connectors pick it up on their next connect. */
  setGoogleClient(clientId: string, clientSecret?: string): { clientId: string; hasSecret: boolean } {
    const problem = validateGoogleClient(clientId, clientSecret)
    if (problem) throw new Error(problem)
    const prev = this.googleClient()
    const id = clientId.trim()
    this.secrets.set(GOOGLE_CLIENT_KEY, JSON.stringify({ clientId: id, clientSecret: clientSecret!.trim() }))
    // A different client can't use the old one's tokens: Google connectors without their own client sign in again.
    if (prev && prev.clientId !== id) this.resetGoogleSignIns()
    this.changed()
    return { clientId: id, hasSecret: true }
  }

  /** Forgets the user's own Google client: Google apps go back to SahilBot's built-in one (if it ships one) and sign in again. */
  clearGoogleClient(): void {
    const had = !!this.googleClient()
    this.secrets.set(GOOGLE_CLIENT_KEY, null)
    if (had) this.resetGoogleSignIns()
    this.changed()
  }

  /** Google connectors without their own client: their tokens belonged to the old shared client. */
  private resetGoogleSignIns(): void {
    for (const c of this.list()) if (GOOGLE_PRESETS.includes(c.preset ?? '') && !c.clientId) new Oauth(c.id, this.secrets).invalidateCredentials('all')
  }

  /**
   * "Use SahilBot's app" for an app the user had set up with their own OAuth app: their client ID and
   * secret are forgotten and it signs in again with the built-in client.
   */
  useBuiltinClient(id: string): ConnectorConfig {
    const c = this.list().find((x) => x.id === id)
    if (!c) throw new Error('Unknown connector')
    const p = PRESETS.find((x) => x.id === c.preset)
    if (!p || !this.builtin(p)) throw new Error(`SahilBot doesn't have its own ${c.name} app yet, so ${c.name} needs yours.`)
    const { clientId: _old, ...rest } = c
    void _old
    return this.save(rest)
  }

  /** Forgets the API key of an app that also signs in with OAuth ("Use an API key instead", undone), or a native app's key. */
  clearApiKey(id: string): void {
    if (isNativeKeyApp(id)) { this.secrets.set(NATIVE_KEY_APPS[id].secret, null); this.changed(); return }
    this.secrets.set(keySecret(id), null)
    this.changed()
  }

  // ---------------------------------------------------------------- API-key apps

  /**
   * Saves the user's key for an API-key catalog app (Keychain only), adds the app if it isn't yet,
   * and connects. A key the server refuses isn't kept, so background reconnects don't keep sending it.
   */
  async setApiKey(presetId: string, raw: string): Promise<ConnectorStatus> {
    const p = PRESETS.find((x) => x.id === presetId)
    // An apikey app, or a one-click app whose vendor documents a key too ("Use an API key instead").
    if (!p || (p.auth !== 'apikey' && p.auth !== 'oauth') || !p.apiKey) throw new Error('This app doesn\'t sign in with an API key.')
    const key = normalizeApiKey(raw, p.apiKey)
    const problem = validateApiKey(key, p)
    if (problem) throw new Error(problem)
    // A native app: verify with one cheap read, then keep the key (a refused one is never saved).
    if (isNativeKeyApp(p.id)) {
      const app = NATIVE_KEY_APPS[p.id]
      const v = await app.verify(key, this.opts.fetch)
      if (!v.ok) return { id: p.id, state: 'error', tools: 0, error: redactSecret(v.error, key) }
      this.secrets.set(app.secret, key)
      this.changed()
      return this.nativeStatus(p.id)
    }
    const cfg = this.list().find((c) => c.preset === presetId) ?? this.save({ name: p.name, kind: 'remote', url: p.url, preset: p.id, enabled: true })
    this.secrets.set(keySecret(cfg.id), key)
    const st = await this.connect(cfg.id, false)
    if (st.state !== 'connected' && /didn't accept the API key/.test(st.error ?? '')) {
      this.secrets.set(keySecret(cfg.id), null)
      this.changed()
    }
    return st
  }

  /**
   * "Paste key": the key on the Mac's clipboard (read in main only when the user clicks), checked against the
   * app's key shape, then saved and verified like a pasted one. The clipboard's text never leaves main.
   */
  async pasteApiKey(presetId: string, readClipboard: () => string | Promise<string>): Promise<ConnectorStatus> {
    const p = PRESETS.find((x) => x.id === presetId)
    if (!p?.apiKey) throw new Error('This app doesn\'t sign in with an API key.')
    const key = keyFromClipboard(await readClipboard(), p)
    if (!key) throw new Error(`The clipboard doesn't hold a ${p.name} API key${p.apiKey.placeholder ? ` (they look like ${p.apiKey.placeholder})` : ''}. Copy the key on ${p.name}'s page, then press Paste key again.`)
    return this.setApiKey(presetId, key)
  }

  /** A native API-key app as a connector status (it has no server to list tools from). */
  private nativeStatus(id: string): ConnectorStatus {
    const tools = NATIVE_KEY_APPS[id].tools
    return { id, state: 'connected', tools: tools.length, toolNames: tools }
  }

  /** Connectors with an API key saved (ids only: keys never leave main); native apps by their preset id. */
  keyIds(): string[] {
    return [
      ...this.list().filter((c) => !!this.secrets.get(keySecret(c.id))).map((c) => c.id),
      ...Object.entries(NATIVE_KEY_APPS).filter(([, a]) => !!this.secrets.get(a.secret)).map(([id]) => id)
    ]
  }

  private sharedGoogle(): { clientId: string; clientSecret?: string } | null {
    try {
      const v = JSON.parse(this.secrets.get(GOOGLE_CLIENT_KEY) ?? 'null') as { clientId?: string; clientSecret?: string } | null
      return v?.clientId ? { clientId: v.clientId, clientSecret: v.clientSecret } : null
    } catch { return null }
  }

  statuses(): ConnectorStatus[] {
    return this.list().map((c) => this.status.get(c.id) ?? { id: c.id, state: c.enabled ? 'disconnected' : 'off', tools: 0 })
  }

  private setStatus(s: ConnectorStatus): void {
    this.status.set(s.id, s)
    this.changed()
  }

  save(input: Omit<ConnectorConfig, 'id'> & { id?: string }): ConnectorConfig {
    // Local catalog entries (Xcode, Figma desktop) always run exactly their allowed command or address.
    const c = pinLocal(input)
    if (c.kind === 'remote' && !/^https?:\/\//.test(c.url ?? '')) throw new Error('Enter the server URL (https://…).')
    const preset = PRESETS.find((p) => p.id === c.preset)
    // Apps without self-registration need a client: SahilBot's built-in one, or the user's own.
    if (preset?.auth === 'google' && !c.clientId && !this.googleClient() && !this.builtin(preset)) throw new Error(GOOGLE_SETUP_NEEDED)
    if (preset?.auth === 'oauth-static' && !c.clientId?.trim() && !this.builtin(preset)) throw new Error(setupNeeded(preset))
    if (c.clientId !== undefined && !/^[\x21-\x7e]{4,300}$/.test(c.clientId.trim())) throw new Error('That client ID looks wrong (it has spaces or odd characters). Copy it again.')
    if (c.kind === 'stdio' && !c.command?.trim()) throw new Error('Enter the command that starts the server.')
    const all = this.list()
    const full: ConnectorConfig = { ...c, ...(c.clientId !== undefined ? { clientId: c.clientId.trim() } : {}), id: c.id ?? `${slug(c.name)}-${randomUUID().slice(0, 4)}`, enabled: c.enabled ?? true } as ConnectorConfig
    // A different client can't use the old one's tokens: sign in again with the new one.
    const prev = all.find((x) => x.id === full.id)
    if (prev && (prev.clientId ?? '') !== (full.clientId ?? '')) {
      new Oauth(full.id, this.secrets).invalidateCredentials('all')
      // The old client's secret goes too (a new one, if any, is saved right after this).
      this.secrets.set(`mcp:${full.id}:clientSecret`, null)
    }
    this.db.setSetting('connectors', [...all.filter((x) => x.id !== full.id), full])
    return full
  }

  /** Switches one server tool on or off; a live connection picks it up without reconnecting. */
  setToolEnabled(id: string, tool: string, on: boolean): ConnectorConfig {
    const c = this.list().find((x) => x.id === id)
    if (!c) throw new Error('Unknown connector')
    const off = new Set(c.disabledTools ?? [])
    if (on) off.delete(tool)
    else off.add(tool)
    const next: ConnectorConfig = { ...c, disabledTools: [...off].sort() }
    if (!next.disabledTools!.length) delete next.disabledTools
    this.db.setSetting('connectors', this.list().map((x) => (x.id === id ? next : x)))
    const l = this.live.get(id)
    if (l) {
      const t = l.all.find((x) => x.name === tool)
      // The agent name for exactly this server tool (never a look-alike's: send-email vs send_email).
      const name = l.names.get(tool)
      // A tool the live server doesn't offer: the stored setting applies on the next connect.
      if (name && !on) {
        this.registry.unregister((d) => d.name === name)
        l.tools = l.tools.filter((n) => n !== name)
      } else if (name && t && !l.tools.includes(name)) {
        this.registry.register(this.toToolDef(next, l.client, t, name))
        l.tools.push(name)
      }
      const st = this.status.get(id)
      if (st) this.status.set(id, { ...st, tools: l.tools.length })
    }
    this.changed()
    return next
  }

  /**
   * Agent tool names the user switched off, across connectors. Recovery of misspelled tool calls uses
   * this so a call to a disabled tool is never "corrected" into a look-alike that's still on.
   */
  disabledToolNames(): Set<string> {
    const out = new Set<string>()
    for (const c of this.list()) {
      const names = this.live.get(c.id)?.names
      for (const t of c.disabledTools ?? []) out.add(names?.get(t) ?? toolName(c.name, t))
    }
    return out
  }

  async remove(id: string): Promise<void> {
    await this.disconnect(id)
    new Oauth(id, this.secrets).invalidateCredentials('all')
    this.secrets.set(keySecret(id), null)
    this.db.setSetting('connectors', this.list().filter((c) => c.id !== id))
    this.status.delete(id)
    this.changed()
  }

  /** Closes the connection and stops any automatic reconnect. */
  async disconnect(id: string): Promise<void> {
    await this.teardown(id)
    this.attempts.delete(id)
    this.setStatus({ id, state: 'disconnected', tools: 0 })
  }

  /** Drops the live connection (its tools leave the registry) and any pending reconnect. */
  private async teardown(id: string): Promise<void> {
    const timer = this.timers.get(id)
    if (timer) { clearTimeout(timer); this.timers.delete(id) }
    const l = this.live.get(id)
    if (l) {
      // Out of the map first, so the client's onclose doesn't read this as a dropped connection.
      this.live.delete(id)
      this.registry.unregister((t) => l.tools.includes(t.name))
      await l.client.close().catch(() => undefined)
    }
  }

  async connectAll(): Promise<void> {
    await Promise.all(this.list().filter((c) => c.enabled).map((c) => this.connect(c.id, false).catch(() => undefined)))
  }

  /**
   * Connects; with interactive=true a remote server that needs auth opens the browser to sign in.
   * A connection that fails for network reasons (offline at launch, server hiccup) retries with backoff.
   */
  async connect(id: string, interactive = true, fromRetry = false): Promise<ConnectorStatus> {
    const c = this.list().find((x) => x.id === id)
    if (!c) throw new Error('Unknown connector')
    await this.teardown(id)
    if (!fromRetry) this.attempts.delete(id)
    this.setStatus({ id, state: 'connecting', tools: 0 })
    const client = new Client({ name: 'SahilBot', version: '0.1.0' })
    const preset = PRESETS.find((p) => p.id === c.preset)
    // A catalog app whose server can't be used right now: say why, and don't keep retrying.
    if (preset?.unavailable && c.kind === 'remote' && c.url === preset.url) {
      await client.close().catch(() => undefined)
      this.attempts.delete(id)
      this.setStatus({ id, state: 'error', tools: 0, error: preset.unavailable, reason: 'unavailable' })
      return this.status.get(id)!
    }
    let auth: Oauth | undefined
    try {
      if (c.kind === 'stdio') {
        // A local catalog entry only ever starts its own allowlisted command (a hand-edited config is refused).
        const local = c.preset && isLocalPreset({ id: c.preset }) ? LOCAL_SERVERS[c.preset] : undefined
        if (local && (local.kind !== 'stdio' || c.command !== local.command || JSON.stringify(c.args ?? []) !== JSON.stringify(local.args))) throw new Error(`${c.name}'s command was changed, so SahilBot won't run it. Remove the app and connect it again.`)
        const env = Object.fromEntries(Object.entries({ ...process.env, ...(c.env ?? {}) }).filter(([k, v]) => v !== undefined && !SAFE_ENV_BLOCK.test(k))) as Record<string, string>
        await client.connect(new StdioClientTransport({ command: c.command!, args: c.args ?? [], env, stderr: 'ignore' }))
      } else if (preset?.apiKey && (preset.auth === 'apikey' || this.secrets.get(keySecret(id)))) {
        // The user's own key (an apikey app, or "Use an API key instead" on a one-click app), added to
        // this connection's requests only (never to c.url).
        const key = this.secrets.get(keySecret(id))
        if (!key) throw new Error(apiKeyNeeded(preset))
        // The key only ever goes to the app's own server: a saved URL edited to point anywhere else is refused.
        if (!sameOrigin(c.url, preset.url)) throw new Error(`${preset.name}'s address was changed, so SahilBot won't send your ${preset.name} key to it. Remove the app and connect it again.`)
        const req = apiKeyRequest(c.url!, preset.apiKey, key)
        const requestInit = { headers: req.headers }
        try {
          await client.connect(new StreamableHTTPClientTransport(req.url, { requestInit }))
        } catch (e) {
          if (/\b(401|403)\b|unauthori[sz]ed|forbidden/i.test((e as Error).message)) throw e
          // Older servers only speak SSE (the SDK sends requestInit headers on its event stream too).
          await client.connect(new SSEClientTransport(req.url, { requestInit }))
        }
      } else {
        const local = c.preset && isLocalPreset({ id: c.preset }) ? LOCAL_SERVERS[c.preset] : undefined
        if (local && (local.kind !== 'remote' || c.url !== local.url)) throw new Error(`${c.name}'s address was changed, so SahilBot won't connect to it. Remove the app and connect it again.`)
        // Which OAuth client signs in, first that applies: this connector's own (its one-time setup),
        // the user's shared Google client ("Use your own app" for Google), SahilBot's built-in client
        // (resources/oauth-clients.json), or none (the server registers SahilBot itself, DCR).
        const isGoogle = preset?.auth === 'google'
        const shared = isGoogle ? this.sharedGoogle() : null
        const builtin = !c.clientId && !shared && c.url === preset?.url ? this.builtin(preset) : undefined
        const clientId = c.clientId ?? shared?.clientId ?? builtin?.clientId
        const secret = c.clientId ? this.secrets.get(`mcp:${id}:clientSecret`) ?? undefined : shared ? shared.clientSecret : builtin?.clientSecret
        if (isGoogle && !clientId) throw new Error(GOOGLE_SETUP_NEEDED)
        if (preset?.auth === 'oauth-static' && !clientId) throw new Error(setupNeeded(preset))
        // A pre-registered client signs in on the exact redirect URL it was registered with. The user's
        // Google Desktop client (and a built-in "loopback" one) takes any loopback port instead.
        const fixedRedirect = builtin ? (builtin.redirect === 'loopback' ? undefined : builtin.redirect) : clientId && !isGoogle ? redirectFor(c.preset) : undefined
        // Tokens belong to the client that got them: a different client now (the user switched to their
        // own app, or back to SahilBot's) signs in again instead of refreshing with the wrong one.
        const ref = clientId ?? 'dcr'
        const refKey = `mcp:${id}:clientRef`
        const prevRef = this.secrets.get(refKey)
        if (prevRef && prevRef !== ref) new Oauth(id, this.secrets).invalidateCredentials('all')
        if (prevRef !== ref) this.secrets.set(refKey, ref)
        auth = new Oauth(id, this.secrets, {
          staticClient: clientId ? { client_id: clientId, ...(secret ? { client_secret: secret } : {}) } : undefined,
          fixedRedirect, interactive, open: this.opts.openExternal, scope: builtin?.scopes, appName: c.name,
          onSignedIn: () => this.opts.onSignedIn?.(c.name)
        })
        const signedInBefore = auth.signedInBefore()
        await auth.listen()
        const url = new URL(c.url!)
        const headers = c.headerName && this.secrets.get(`mcp:${id}:header`) ? { [c.headerName]: this.secrets.get(`mcp:${id}:header`)! } : undefined
        const attempt = async (): Promise<void> => {
          try {
            await client.connect(new StreamableHTTPClientTransport(url, { authProvider: headers ? undefined : auth, requestInit: headers ? { headers } : undefined }))
          } catch (e) {
            if (e instanceof UnauthorizedError) throw e
            // Older servers only speak SSE.
            await client.connect(new SSEClientTransport(url, { authProvider: headers ? undefined : auth, requestInit: headers ? { headers } : undefined }))
          }
        }
        try {
          await attempt()
        } catch (e) {
          if (!(e instanceof UnauthorizedError)) throw e
          if (!interactive) {
            this.attempts.delete(id)
            // Signed in before, refused now (the token expired and couldn't be refreshed, or was revoked).
            this.setStatus({ id, state: 'needs_auth', tools: 0, ...(signedInBefore ? { reason: 'expired' as const, error: expiredText(c.name) } : {}) })
            auth!.close()
            return this.status.get(id)!
          }
          this.setStatus({ id, state: 'signing_in', tools: 0 })
          const code = await auth!.waitForCode()
          const t = new StreamableHTTPClientTransport(url, { authProvider: auth })
          await t.finishAuth(code)
          await attempt()
        } finally {
          auth!.close()
          // From here on, a refused token never opens the browser by itself.
          auth!.background()
        }
      }
      const { tools } = await client.listTools()
      // Tools the user switched off in Connect apps are never offered to the agent.
      const off = new Set(c.disabledTools ?? [])
      const names = toolNames(c.name, tools.map((t) => t.name))
      const defs: ToolDef[] = tools.filter((t) => !off.has(t.name)).map((t) => this.toToolDef(c, client, t, names.get(t.name)!))
      this.registry.register(...defs)
      this.live.set(id, { client, tools: defs.map((d) => d.name), all: tools as ServerTool[], names })
      // A local server that exits, or a stream that closes, reconnects on its own.
      client.onclose = () => { if (this.live.get(id)?.client === client) this.lost(id, 'Connection closed') }
      this.attempts.delete(id)
      const st: ConnectorStatus = { id, state: 'connected', tools: defs.length, toolNames: tools.map((t) => t.name), checkedAt: Date.now() }
      this.setStatus(st)
      return st
    } catch (e) {
      await client.close().catch(() => undefined)
      // Nothing secret survives into status text or errors (keys, header values, tokens in URLs).
      const raw = redactSecret((e as Error).message, this.secrets.get(keySecret(id)), this.secrets.get(`mcp:${id}:header`))
      // RFC 8707: a server that rejects resource indicators gets one more sign-in without them.
      if (auth && !auth.noResource && /invalid_target/i.test(raw)) {
        auth.dropResource()
        if (interactive) return this.connect(id, interactive, fromRetry)
      }
      const localHint = c.preset && isLocalPreset({ id: c.preset }) ? LOCAL_SERVERS[c.preset].hint : undefined
      const usedKey = !!preset?.apiKey && (preset.auth === 'apikey' || !!this.secrets.get(keySecret(id)))
      const builtinUsed = !c.clientId && !(preset?.auth === 'google' && this.googleClient()) && c.url === preset?.url ? this.builtin(preset) : undefined
      const msg = localHint ? `${raw.replace(/[.\s]+$/, '')}. ${localHint}`
        : usedKey && preset ? explainKeyError(raw, preset)
        : c.kind === 'remote' ? explainAuthError(raw, { name: c.name, url: c.url, hasSetup: !!preset?.setup, staticClient: !!(c.clientId || preset?.auth === 'google' || builtinUsed), builtin: !!builtinUsed, redirect: c.clientId ? redirectFor(c.preset) : builtinUsed && builtinUsed.redirect !== 'loopback' ? builtinUsed.redirect : undefined })
        : raw
      const reason = connectorReason(msg)
      const st: ConnectorStatus = { id, state: 'error', tools: 0, error: msg.slice(0, 400), ...(reason ? { reason } : {}) }
      this.setStatus(st)
      if (fromRetry || isConnectionError(msg)) this.scheduleReconnect(id, msg)
      return this.status.get(id) ?? st
    }
  }

  // ---------------------------------------------------------------- health and reconnect

  /** A live connection dropped: its tools leave the agent until it's back, and reconnecting starts. */
  private lost(id: string, reason: string): void {
    const l = this.live.get(id)
    if (!l) return
    this.live.delete(id)
    this.registry.unregister((t) => l.tools.includes(t.name))
    void l.client.close().catch(() => undefined)
    this.scheduleReconnect(id, reason)
  }

  private scheduleReconnect(id: string, reason: string): void {
    const c = this.list().find((x) => x.id === id)
    if (!c || !c.enabled || this.timers.has(id)) return
    const attempt = (this.attempts.get(id) ?? 0) + 1
    const why = reason.replace(/\s+/g, ' ').slice(0, 160)
    if (attempt > MAX_RECONNECTS) {
      this.attempts.delete(id)
      this.setStatus({ id, state: 'error', tools: 0, error: `${why} (stopped retrying; press Reconnect)`, ...(connectorReason(why) === 'unavailable' ? { reason: 'unavailable' as const } : {}) })
      return
    }
    this.attempts.set(id, attempt)
    const wait = backoffMs(attempt)
    this.setStatus({ id, state: 'reconnecting', tools: 0, error: why, attempt, retryAt: Date.now() + wait, reason: 'unavailable' })
    const t = setTimeout(() => { this.timers.delete(id); void this.connect(id, false, true).catch(() => undefined) }, wait)
    t.unref?.()
    this.timers.set(id, t)
  }

  /**
   * "Test connection": lists the server's tools and times it. A connector that isn't live tries to
   * connect (without opening the browser); a dropped one starts reconnecting.
   */
  async test(id: string): Promise<ConnectorStatus> {
    const c = this.list().find((x) => x.id === id)
    if (!c) throw new Error('Unknown connector')
    const l = this.live.get(id)
    if (!l) return this.connect(id, false)
    const t0 = Date.now()
    try {
      const { tools } = await l.client.listTools(undefined, { timeout: 20_000 })
      const latencyMs = Date.now() - t0
      const now = tools.map((t) => t.name).sort().join('\n')
      // The server changed its tools: connect again so the agent sees the current set.
      if (now !== l.all.map((t) => t.name).sort().join('\n')) return this.connect(id, false)
      const st: ConnectorStatus = { id, state: 'connected', tools: l.tools.length, toolNames: tools.map((t) => t.name), checkedAt: Date.now(), latencyMs }
      this.setStatus(st)
      return st
    } catch (e) {
      const msg = (e as Error).message
      if (isAuthError(e)) {
        await this.teardown(id)
        this.setStatus({ id, state: 'needs_auth', tools: 0, error: expiredText(c.name), reason: 'expired', checkedAt: Date.now() })
        return this.status.get(id)!
      }
      this.lost(id, msg)
      return this.status.get(id)!
    }
  }

  /** Checks every live connector now and then (each check is one tools/list call). */
  startHealth(everyMs = 5 * 60_000): void {
    if (this.healthTimer) return
    this.healthTimer = setInterval(() => void this.checkAll(), everyMs)
    this.healthTimer.unref?.()
  }

  stopHealth(): void {
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = null
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  async checkAll(): Promise<void> {
    for (const id of [...this.live.keys()]) await this.test(id).catch(() => undefined)
  }

  /**
   * "Check all" in Connect apps: every live app lists its tools again, and switched-on apps that are
   * failing (needs sign-in, error, reconnecting) try once more without opening the browser. Apps the
   * user disconnected stay disconnected; a sign-in in progress is left alone.
   */
  async checkEvery(): Promise<ConnectorStatus[]> {
    const retry = new Set<ConnectorStatus['state']>(['needs_auth', 'error', 'reconnecting'])
    await Promise.all(this.list().filter((c) => c.enabled).map(async (c) => {
      if (this.live.has(c.id)) return this.test(c.id).catch(() => undefined)
      const st = this.status.get(c.id)?.state
      if (st && retry.has(st)) return this.connect(c.id, false).catch(() => undefined)
      return undefined
    }))
    return this.statuses()
  }

  // ---------------------------------------------------------------- calls from SahilBot itself (not the model)

  /**
   * Waits (up to `ms`) while a connector made from this catalog entry is still connecting on its own (at
   * launch, or reconnecting after a drop), so a chat doesn't offer a Connect card for an app that's a moment
   * away from being ready. Returns its tool names once live (empty if it isn't).
   */
  async settle(preset: string, ms = 8000): Promise<string[]> {
    const busy = (): boolean => this.list().some((c) => c.preset === preset && c.enabled && this.status.get(c.id)?.state === 'connecting')
    for (const end = Date.now() + ms; busy() && Date.now() < end;) await new Promise((r) => setTimeout(r, 100))
    return this.presetTools(preset)
  }

  /** The agent tool names a live connector made from this catalog entry offers (empty when it isn't live). */
  presetTools(preset: string): string[] {
    return this.list().filter((c) => c.preset === preset && this.status.get(c.id)?.state === 'connected').flatMap((c) => this.live.get(c.id)?.tools ?? [])
  }

  /** The server's own tool names of a live connector made from this catalog entry (tools the user switched off left out). */
  presetServerTools(preset: string): string[] {
    const c = this.list().find((x) => x.preset === preset && this.live.has(x.id))
    if (!c) return []
    return (this.live.get(c.id)?.all ?? []).map((t) => t.name).filter((n) => !c.disabledTools?.includes(n))
  }

  /** connected (live), needs_auth (set up but not live: its sign-in expired or never finished) or absent. */
  presetState(preset: string): 'connected' | 'needs_auth' | 'absent' {
    const cs = this.list().filter((x) => x.preset === preset)
    if (!cs.length) return 'absent'
    if (cs.some((x) => this.live.has(x.id))) return 'connected'
    // Set up but not live (signed out, expired, or still connecting): it needs the user to sign in again.
    return 'needs_auth'
  }

  /** True when a connector made from this catalog entry is live. */
  presetConnected(preset: string): boolean {
    return this.list().some((c) => c.preset === preset && this.live.has(c.id))
  }

  /**
   * Calls one of a connected app's tools from main (e.g. reading an emailed sign-in code). The text
   * stays in main. Tools the user switched off stay off here too.
   */
  async callPresetTool(preset: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const c = this.list().find((x) => x.preset === preset && this.live.has(x.id))
    if (!c) throw new Error(`${preset} is not connected`)
    if (c.disabledTools?.includes(tool)) throw new Error(`${c.name}'s ${tool} is switched off`)
    const l = this.live.get(c.id)!
    if (!l.all.some((t) => t.name === tool)) throw new Error(`${c.name} has no ${tool} tool`)
    const r = await l.client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: 30_000 })
    const { text } = contentOf(r)
    if (r.isError) throw new Error(text || `${tool} failed`)
    return text
  }

  private toToolDef(c: ConnectorConfig, client: Client, t: ServerTool, name: string): ToolDef {
    const policy = toolPolicy(c.preset, t.name, t.annotations)
    const lost = (reason: string): void => { if (this.live.get(c.id)?.client === client) this.lost(c.id, reason) }
    const expired = (): void => {
      if (this.live.get(c.id)?.client !== client) return
      this.setStatus({ id: c.id, state: 'needs_auth', tools: 0, error: expiredText(c.name), reason: 'expired', checkedAt: Date.now() })
      void this.teardown(c.id).then(() => this.setStatus({ id: c.id, state: 'needs_auth', tools: 0, error: expiredText(c.name), reason: 'expired', checkedAt: Date.now() }))
    }
    // An API-key server's errors may echo the request: keep its key out of what the agent sees.
    const scrub = (m: string): string => (c.kind === 'remote' ? redactSecret(m, this.secrets.get(keySecret(c.id)), this.secrets.get(`mcp:${c.id}:header`)) : m)
    return {
      name,
      label: c.name,
      group: c.name,
      // A connected app's tool: a chat may use it without turning into agent work (registry chatAllowed).
      connector: true,
      effect: policy.effect,
      untrusted: true,
      consequential: (args) => toolPolicy(c.preset, t.name, t.annotations, args).consequential,
      ...(policy.hardStop ? { hardStop: () => policy.hardStop! } : {}),
      describe: (args) => `${c.name}: ${t.annotations?.title ?? t.name.replace(/_/g, ' ')} ${JSON.stringify(args).slice(0, 160)}`,
      description: `[${c.name}] ${(t.description ?? t.name).slice(0, 900)}`,
      parameters: t.inputSchema && Object.keys(t.inputSchema).length ? t.inputSchema : { type: 'object', properties: {} },
      ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
      idempotent: t.annotations?.idempotentHint === true,
      async run(args, ctx) {
        let r: Awaited<ReturnType<Client['callTool']>>
        try {
          r = await client.callTool({ name: t.name, arguments: args as Record<string, unknown> }, undefined, { signal: ctx.signal, timeout: 120_000 })
        } catch (e) {
          const m = scrub((e as Error).message)
          if (!ctx.signal.aborted && isAuthError(e)) {
            expired()
            throw new Error(`${c.name}'s sign-in expired or was revoked. Reconnect here: call connect_app with app "${c.name}" to show its Connect / Sign in tile in this chat; continue after sign-in. Reconcile any uncertain write before repeating it.`)
          }
          if (!ctx.signal.aborted && isConnectionError(m)) {
            lost(m)
            throw new Error(`${c.name} lost its connection (${m.slice(0, 80)}). SahilBot is reconnecting on its own: try again in a minute, or tell the user to check Connect apps.`)
          }
          throw m === (e as Error).message ? e : new Error(m)
        }
        const { text, images } = contentOf(r)
        if (r.isError) { const error = new Error(scrub(text) || `${t.name} failed`); if (isAuthError(error)) expired(); throw error }
        return { text: text || '(no output)', data: (r as { structuredContent?: unknown }).structuredContent, images: images.length ? images : undefined, display: t.annotations?.title ?? t.name.replace(/_/g, ' ') }
      }
    }
  }
}

/** Text and images from an MCP tool result. */
function contentOf(r: object): { text: string; images: string[] } {
  const parts = ((r as { content?: unknown }).content ?? []) as Array<{ type: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string; uri?: string } }>
  const text = parts.map((p) => (p.type === 'text' ? p.text : p.type === 'resource' ? (p.resource?.text ?? p.resource?.uri) : p.type === 'image' ? '[image attached]' : '')).filter(Boolean).join('\n')
  const images = parts.filter((p) => p.type === 'image' && p.data).map((p) => `data:${p.mimeType ?? 'image/png'};base64,${p.data}`)
  return { text, images }
}
