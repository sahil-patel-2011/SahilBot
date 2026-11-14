import { shell } from 'electron'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { ConnectorConfig, ConnectorPreset, ConnectorSetup, ConnectorStatus, ToolEffect } from '@shared/types'
import type { ToolRegistry } from './agent/registry'
import type { ToolDef } from './agent/types'
import { CONSEQUENTIAL } from './agent/permissions'
import type { Db } from './db'
import type { Secrets } from './secrets'
import { gmailPolicy, type ToolPolicy } from './mail/gmail'

// MCP connectors: remote servers with OAuth sign-in (browser + loopback callback, tokens in
// the Keychain) and local stdio servers. Each server's tools become agent tools loaded on
// demand through find_tools. Design follows opencode/Cline/OpenClaw MCP OAuth handling (MIT/Apache).

// ---------------------------------------------------------------- catalog
//
// Every remote preset below was verified on 2026-11-14 with read-only HTTPS requests: an MCP
// initialize POST (401 = sign-in required, 200 = open server), then the server's RFC 9728
// /.well-known/oauth-protected-resource and its authorization server's RFC 8414 metadata.
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
  crunchbase: {
    minutes: 10, needsSecret: false, redirectUri: R('127.0.0.1'), idHint: 'issued by Crunchbase', docs: 'https://data.crunchbase.com/docs',
    steps: [
      { title: 'Ask Crunchbase for an OAuth client', text: 'Crunchbase\'s MCP server only signs in apps it already knows (it offers no self-registration). Ask Crunchbase API support or your account manager for an OAuth client for a desktop app, with the redirect URL below.', links: [['Crunchbase API docs', 'https://data.crunchbase.com/docs']] },
      { title: 'Paste the client ID here', text: 'Add the secret too if Crunchbase gave you one.', links: [] }
    ]
  }
} satisfies Record<string, ConnectorSetup>

export const PRESETS: ConnectorPreset[] = [
  { id: 'cursor-app', name: 'Cursor', url: 'app:cursor', color: '#111111', category: 'Built in', domain: 'cursor.com', auth: 'app', description: 'SahilBot opens files in Cursor and can hand coding tasks to Cursor\'s agent.' },
  { id: 'apple-notes', name: 'Notes, Reminders & Calendar', url: 'app:mac_apps', color: '#F5B400', category: 'Built in', domain: 'apple.com', auth: 'app', description: 'Your Mac\'s own apps; macOS asks once to allow access.' },
  { id: 'apple-mail', name: 'Mail (all your accounts)', url: 'app:mail', color: '#1A8CFF', category: 'Built in', domain: 'apple.com', auth: 'app', description: 'Apple Mail on this Mac: Gmail, iCloud, Outlook and more, no sign-in. macOS asks once.' },
  { id: 'gmail-web', name: 'Gmail (no setup)', url: 'https://mail.google.com/', color: '#EA4335', category: 'Built in', domain: 'mail.google.com/mail/', auth: 'browser', description: 'Sign in once in SahilBot\'s browser; SahilBot uses Gmail like you do.' },
  { id: 'gcal-web', name: 'Google Calendar (no setup)', url: 'https://calendar.google.com/', color: '#4285F4', category: 'Built in', domain: 'calendar.google.com/calendar/', auth: 'browser', description: 'Sign in once in SahilBot\'s browser.' },
  { id: 'gdrive-web', name: 'Google Drive (no setup)', url: 'https://drive.google.com/', color: '#0F9D58', category: 'Built in', domain: 'drive.google.com/drive/', auth: 'browser', description: 'Sign in once in SahilBot\'s browser.' },
  { id: 'linkedin-web', name: 'LinkedIn (no setup)', url: 'https://www.linkedin.com/', color: '#0A66C2', category: 'Built in', auth: 'browser', description: 'Any site works this way: sign in once in SahilBot\'s browser.' },
  // Google's MCP servers: one-time Google setup (a Desktop OAuth client shared by all three). Verified 2026-11-11.
  { id: 'gmail', name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1', color: '#EA4335', category: 'Communication', domain: 'mail.google.com/mail/', auth: 'google', description: 'Search, read, label and draft email; sending always asks.' },
  { id: 'gcal', name: 'Google Calendar', url: 'https://calendarmcp.googleapis.com/mcp/v1', color: '#4285F4', category: 'Productivity', domain: 'calendar.google.com/calendar/', auth: 'google', description: 'Events, availability and invites.' },
  { id: 'gdrive', name: 'Google Drive', url: 'https://drivemcp.googleapis.com/mcp/v1', color: '#0F9D58', category: 'Productivity', domain: 'drive.google.com/drive/', auth: 'google', description: 'Find and read Docs, Sheets and files.' },
  // Productivity
  { id: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', color: '#111111', category: 'Productivity', auth: 'oauth', description: 'Pages, databases and comments.' }, // 2026-11-14: 401+PRM, DCR mcp.notion.com/register
  { id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', color: '#5E6AD2', category: 'Productivity', auth: 'oauth', description: 'Issues, projects and cycles.' }, // 2026-11-14: 401+PRM, DCR mcp.linear.app/register
  { id: 'asana', name: 'Asana', url: 'https://mcp.asana.com/v2/mcp', color: '#F06A6A', category: 'Productivity', auth: 'oauth-static', setup: S.asana, description: 'Tasks, projects and portfolios.' }, // 2026-11-14: 401+PRM, AS app.asana.com has no registration_endpoint; Asana docs: V2 needs an "MCP app" (was 'oauth': fixed)
  // Atlassian's current server (v2; v1 answers without RFC 9728 metadata). Also covers Bitbucket and Loom.
  { id: 'atlassian', name: 'Jira & Confluence', url: 'https://mcp.atlassian.com/v2/mcp', color: '#0052CC', category: 'Productivity', domain: 'atlassian.com', auth: 'oauth', description: 'Jira issues, Confluence pages, plus Bitbucket and Loom.' }, // 2026-11-14: 401+PRM /v2/mcp, DCR auth.atlassian.com/…/dcr/register (was /v1/mcp: updated)
  { id: 'monday', name: 'monday.com', url: 'https://mcp.monday.com/mcp', color: '#FF3D57', category: 'Productivity', auth: 'oauth', description: 'Boards, items and updates.' }, // 2026-11-14: 401+PRM, DCR auth.monday.com/oauth_ms/oauth/register
  { id: 'clickup', name: 'ClickUp', url: 'https://mcp.clickup.com/mcp', color: '#7B68EE', category: 'Productivity', auth: 'oauth', description: 'Tasks, docs and spaces.' }, // 2026-11-14: 401+PRM, DCR mcp.clickup.com/oauth/register
  { id: 'airtable', name: 'Airtable', url: 'https://mcp.airtable.com/mcp', color: '#18BFFF', category: 'Productivity', auth: 'oauth', description: 'Bases, tables and records.' }, // 2026-11-14: 401+PRM, DCR airtable.com/oauth2/v1/register
  { id: 'todoist', name: 'Todoist', url: 'https://ai.todoist.net/mcp', color: '#E44332', category: 'Productivity', domain: 'todoist.com', auth: 'oauth', description: 'Tasks, projects and due dates.' }, // NEW 2026-11-14: 401+PRM, DCR todoist.com/oauth/register; Doist's official server (MCP registry)
  { id: 'calendly', name: 'Calendly', url: 'https://mcp.calendly.com/', color: '#006BFF', category: 'Productivity', auth: 'oauth', description: 'Event types, bookings and availability.' }, // NEW 2026-11-14: 401+PRM, DCR calendly.com/oauth/register
  { id: 'box', name: 'Box', url: 'https://mcp.box.com', color: '#0061D5', category: 'Productivity', auth: 'oauth-static', setup: S.box, description: 'Files and folders in Box.' }, // 2026-11-14: 401+PRM, AS api.box.com has no registration_endpoint; Box docs: pre-registered app (was 'oauth': fixed)
  { id: 'dropbox', name: 'Dropbox', url: 'https://mcp.dropbox.com/mcp', color: '#0061FF', category: 'Productivity', auth: 'oauth', description: 'Files and folders in Dropbox.' }, // 2026-11-14: 401+PRM, DCR dropbox.com/oauth2/register
  { id: 'zapier', name: 'Zapier', url: 'https://mcp.zapier.com/api/mcp/mcp', color: '#FF4F00', category: 'Productivity', auth: 'oauth', description: 'Thousands of app actions via your Zaps.' }, // 2026-11-14: 401+PRM, DCR mcp.zapier.com/api/v1/oauth/register
  { id: 'make', name: 'Make', url: 'https://mcp.make.com/', color: '#6D00CC', category: 'Productivity', auth: 'oauth', description: 'Run and manage your Make scenarios.' }, // NEW 2026-11-14: 401+PRM, DCR make.com/oauth/v2/register/mcp
  { id: 'granola', name: 'Granola', url: 'https://mcp.granola.ai/mcp', color: '#1E1E1E', category: 'Productivity', domain: 'granola.ai', auth: 'oauth', description: 'Meeting notes and transcripts.' }, // 2026-11-14: 401+PRM, DCR mcp-auth.granola.ai/oauth2/register
  { id: 'fireflies', name: 'Fireflies', url: 'https://mcp.fireflies.ai/mcp', color: '#E1308A', category: 'Productivity', domain: 'fireflies.ai', auth: 'oauth', description: 'Meeting recordings and summaries.' }, // 2026-11-14: 401+PRM, DCR mcp.fireflies.ai/register
  { id: 'jotform', name: 'Jotform', url: 'https://mcp.jotform.com/', color: '#FF6100', category: 'Productivity', auth: 'oauth', description: 'Forms and submissions.' }, // 2026-11-14: 401+PRM, DCR oauth2.jotform.com/register-public-client
  { id: 'docusign', name: 'Docusign', url: 'https://mcp.docusign.com/mcp', color: '#4C00FF', category: 'Productivity', auth: 'oauth-static', setup: S.docusign, description: 'Agreements and envelopes.' }, // 2026-11-14: 401+PRM, AS has no registration_endpoint; Docusign: bring your own integration key (was 'oauth': fixed)
  // Communication
  { id: 'slack', name: 'Slack', url: 'https://mcp.slack.com/mcp', color: '#4A154B', category: 'Communication', auth: 'oauth-static', setup: S.slack, description: 'Search, read and post in channels.' }, // 2026-11-14: 401+PRM, no registration_endpoint; Slack docs: "We do not support … Dynamic Client Registration" (was 'oauth': fixed)
  { id: 'zoom', name: 'Zoom', url: 'https://mcp.zoom.us/mcp/zoom/streamable', color: '#0B5CFF', category: 'Communication', auth: 'oauth-static', setup: S.zoom, description: 'Meetings, recordings, summaries and Zoom Docs.' }, // NEW 2026-11-14: 401+PRM (zoom.us), AS zoom.us has no registration_endpoint; Zoom docs: manual client registration
  { id: 'intercom', name: 'Intercom', url: 'https://mcp.intercom.com/mcp', color: '#1F8DED', category: 'Communication', auth: 'oauth', description: 'Conversations and help center.' }, // 2026-11-14: 401+PRM, DCR mcp.intercom.com/register
  // Design & media
  { id: 'figma', name: 'Figma', url: 'https://mcp.figma.com/mcp', color: '#A259FF', category: 'Design', auth: 'oauth', description: 'Design files and components.' }, // 2026-11-14: 401+PRM, DCR api.figma.com/v1/oauth/mcp/register
  { id: 'canva', name: 'Canva', url: 'https://mcp.canva.com/mcp', color: '#00C4CC', category: 'Design', auth: 'oauth', description: 'Designs, templates and exports.' }, // 2026-11-14: 401+PRM, DCR mcp.canva.com/register
  { id: 'miro', name: 'Miro', url: 'https://mcp.miro.com/', color: '#FFD02F', category: 'Design', auth: 'oauth', description: 'Boards, stickies and diagrams.' }, // 2026-11-14: 401+PRM, DCR mcp.miro.com/register
  { id: 'gamma', name: 'Gamma', url: 'https://mcp.gamma.app/mcp', color: '#7C3AED', category: 'Design', domain: 'gamma.app', auth: 'oauth', description: 'Generate decks and docs.' }, // 2026-11-14: 401+PRM, DCR auth.gamma.app/oauth/register
  { id: 'heygen', name: 'HeyGen', url: 'https://mcp.heygen.com/mcp/v1/', color: '#7559FF', category: 'Design', domain: 'heygen.com', auth: 'oauth', description: 'AI avatar videos and voice, on your plan\'s credits.' }, // NEW 2026-11-14: 401+PRM /mcp/v1, DCR api2.heygen.com/v1/oauth/register; URL from developers.heygen.com/mcp/overview
  { id: 'hyperframes', name: 'HyperFrames by HeyGen', url: 'https://mcp.heygen.com/mcp/hyperframes', color: '#5B3DF5', category: 'Design', domain: 'heygen.com', auth: 'oauth', description: 'Animated slides and motion-graphics videos made from HTML.' }, // NEW 2026-11-14: 401+PRM /mcp/hyperframes, DCR api2.heygen.com/v1/oauth/register; MCP registry
  { id: 'webflow', name: 'Webflow', url: 'https://mcp.webflow.com/mcp', color: '#4353FF', category: 'Design', auth: 'oauth', description: 'Sites and CMS collections.' }, // 2026-11-14: 401+PRM, DCR mcp.webflow.com/oauth/register
  { id: 'wix', name: 'Wix', url: 'https://mcp.wix.com/mcp', color: '#0C6EFC', category: 'Design', auth: 'oauth', description: 'Sites, stores and bookings.' }, // 2026-11-14: 401+PRM, DCR mcp.wix.com/register
  // Sales & marketing
  { id: 'hubspot', name: 'HubSpot', url: 'https://mcp.hubspot.com/', color: '#FF7A59', category: 'Sales & marketing', auth: 'oauth-static', setup: S.hubspot, description: 'Contacts, deals and companies.' }, // 2026-11-14: 401+PRM, no registration_endpoint; HubSpot docs: MCP auth app (was 'oauth': fixed)
  { id: 'apollo', name: 'Apollo', url: 'https://mcp.apollo.io/mcp', color: '#2E3A59', category: 'Sales & marketing', auth: 'oauth', description: 'Prospects and enrichment.' }, // 2026-11-14: 401+PRM, DCR mcp.apollo.io/…/register_oauth_client
  { id: 'attio', name: 'Attio', url: 'https://mcp.attio.com/mcp', color: '#111827', category: 'Sales & marketing', auth: 'oauth', description: 'CRM records and lists.' }, // 2026-11-14: 401+PRM, DCR app.attio.com/oauth/register
  { id: 'close', name: 'Close', url: 'https://mcp.close.com/mcp', color: '#3A5BF0', category: 'Sales & marketing', auth: 'oauth', description: 'Leads, calls and pipeline.' }, // 2026-11-14: 401+PRM, DCR api.close.com/oauth2/register/
  { id: 'pipedrive', name: 'Pipedrive', url: 'https://mcp.pipedrive.ai/mcp', color: '#017737', category: 'Sales & marketing', domain: 'pipedrive.com', auth: 'oauth', description: 'Deals, people and activities.' }, // 2026-11-14: 401+PRM, DCR oauth.pipedrive.com/oauth/register (was mcp.pipedrive.com/mcp: no OAuth metadata there; updated)
  { id: 'gong', name: 'Gong', url: 'https://mcp.gong.io/mcp', color: '#8039DF', category: 'Sales & marketing', auth: 'oauth', description: 'Call recordings and insights.' }, // 2026-11-14: 401+PRM, DCR app.gong.io/oauth2/register
  { id: 'klaviyo', name: 'Klaviyo', url: 'https://mcp.klaviyo.com/mcp', color: '#232426', category: 'Sales & marketing', auth: 'oauth', description: 'Email and SMS marketing.' }, // 2026-11-14: 401+PRM, DCR mcp.klaviyo.com/register
  { id: 'semrush', name: 'Semrush', url: 'https://mcp.semrush.com/v1/mcp', color: '#FF642D', category: 'Sales & marketing', auth: 'oauth', description: 'SEO, keywords and traffic.' }, // 2026-11-14: 401+PRM, DCR api.semrush.com/…/oauth2/register
  { id: 'ahrefs', name: 'Ahrefs', url: 'https://api.ahrefs.com/mcp/mcp', color: '#FF8800', category: 'Sales & marketing', auth: 'oauth', description: 'Backlinks and keyword research.' }, // 2026-11-14: 401+PRM, DCR api.ahrefs.com/mcp/register
  { id: 'similarweb', name: 'Similarweb', url: 'https://mcp.similarweb.com/mcp', color: '#092540', category: 'Sales & marketing', auth: 'oauth', description: 'Website traffic and market data.' }, // 2026-11-14: 401+PRM, DCR mcp-auth.similarweb.com/register
  { id: 'crunchbase', name: 'Crunchbase', url: 'https://mcp.crunchbase.com/mcp', color: '#146AFF', category: 'Sales & marketing', auth: 'oauth-static', setup: S.crunchbase, description: 'Companies, funding and people.' }, // 2026-11-14: 401+PRM, AS crunchbase.com has no registration_endpoint (client-ID metadata documents only) (was 'oauth': fixed)
  // Finance & commerce
  { id: 'stripe', name: 'Stripe', url: 'https://mcp.stripe.com', color: '#635BFF', category: 'Finance & commerce', auth: 'oauth', description: 'Payments, customers and invoices.' }, // 2026-11-14: 401+PRM, DCR access.stripe.com/mcp/oauth2/register
  { id: 'paypal', name: 'PayPal', url: 'https://mcp.paypal.com/mcp', color: '#003087', category: 'Finance & commerce', auth: 'oauth', description: 'Invoices, orders and disputes.' }, // 2026-11-14: 401+PRM, DCR mcp.paypal.com/register
  { id: 'square', name: 'Square', url: 'https://mcp.squareup.com/mcp', color: '#3E4348', category: 'Finance & commerce', domain: 'squareup.com', auth: 'oauth', description: 'Payments, orders and catalog.' }, // 2026-11-14: 401+PRM /mcp (Streamable HTTP), DCR mcp.squareup.com/register (was /sse: moved to the streamable endpoint)
  { id: 'plaid', name: 'Plaid', url: 'https://mcp.plaid.com/mcp', color: '#111111', category: 'Finance & commerce', auth: 'oauth', description: 'Your Plaid developer dashboard: items, logs and usage.' }, // 2026-11-14: 401+PRM, DCR api.dashboard.plaid.com/oauth/register
  { id: 'xero', name: 'Xero', url: 'https://mcp.xero.com/mcp', color: '#13B5EA', category: 'Finance & commerce', auth: 'oauth-static', setup: S.xero, description: 'Accounting: invoices and contacts.' }, // 2026-11-14: 401+PRM, AS identity.xero.com has no registration_endpoint (was 'oauth': fixed)
  // Code
  { id: 'github', name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', color: '#24292F', category: 'Code', domain: 'github.com', auth: 'oauth-static', setup: S.github, description: 'Repos, issues and pull requests.' }, // 2026-11-14: 401+PRM, AS github.com/login/oauth has no registration_endpoint; GitHub host guide: DCR not supported (was 'oauth': fixed)
  { id: 'sentry', name: 'Sentry', url: 'https://mcp.sentry.dev/mcp', color: '#362D59', category: 'Code', domain: 'sentry.io', auth: 'oauth', description: 'Errors and performance issues.' }, // 2026-11-14: 401+PRM, DCR mcp.sentry.dev/oauth/register
  { id: 'vercel', name: 'Vercel', url: 'https://mcp.vercel.com', color: '#000000', category: 'Code', domain: 'vercel.com', auth: 'oauth', description: 'Deployments, logs and domains.' }, // 2026-11-14: 401+PRM, DCR api.vercel.com/login/oauth/register
  { id: 'netlify', name: 'Netlify', url: 'https://mcp.netlify.com/mcp', color: '#00AD9F', category: 'Code', auth: 'oauth', description: 'Sites and deploys.' }, // 2026-11-14: 401+PRM, DCR mcp.netlify.com/oauth-server/reg
  { id: 'cloudflare', name: 'Cloudflare', url: 'https://mcp.cloudflare.com/mcp', color: '#F38020', category: 'Code', domain: 'cloudflare.com', auth: 'oauth', description: 'The whole Cloudflare API: Workers, DNS, R2, KV, D1 and more.' }, // NEW 2026-11-14: 401+PRM, DCR mcp.cloudflare.com/register (Cloudflare's recommended server; bindings.mcp is deprecated)
  { id: 'cloudflare-observability', name: 'Cloudflare Observability', url: 'https://observability.mcp.cloudflare.com/mcp', color: '#F38020', category: 'Code', domain: 'cloudflare.com', auth: 'oauth', description: 'Workers logs and analytics.' }, // NEW 2026-11-14: 401+PRM, DCR observability.mcp.cloudflare.com/register
  { id: 'cloudflare-docs', name: 'Cloudflare Docs', url: 'https://docs.mcp.cloudflare.com/mcp', color: '#F38020', category: 'Code', domain: 'developers.cloudflare.com', auth: 'none', description: 'Cloudflare developer docs. No sign-in.' }, // NEW 2026-11-14: initialize 200, open
  { id: 'supabase', name: 'Supabase', url: 'https://mcp.supabase.com/mcp', color: '#3ECF8E', category: 'Code', auth: 'oauth', description: 'Databases, auth and storage.' }, // 2026-11-14: 401+PRM, DCR api.supabase.com/platform/oauth/apps/register
  { id: 'neon', name: 'Neon', url: 'https://mcp.neon.tech/mcp', color: '#00E599', category: 'Code', auth: 'oauth', description: 'Serverless Postgres.' }, // 2026-11-14: 401+PRM, DCR mcp.neon.tech/api/register
  { id: 'huggingface', name: 'Hugging Face', url: 'https://huggingface.co/mcp', color: '#FFD21E', category: 'Code', domain: 'huggingface.co', auth: 'oauth', description: 'Models, datasets and Spaces.' }, // 2026-11-14: initialize 200 (anonymous works), DCR huggingface.co/oauth/register
  { id: 'deepwiki', name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', color: '#0F172A', category: 'Code', auth: 'none', description: 'Explains any public GitHub repo. No sign-in.' }, // 2026-11-14: initialize 200, open
  { id: 'context7', name: 'Context7', url: 'https://mcp.context7.com/mcp', color: '#059669', category: 'Code', auth: 'none', description: 'Up-to-date library docs. No sign-in.' }, // 2026-11-14: initialize 200, open
  { id: 'mslearn', name: 'Microsoft Learn', url: 'https://learn.microsoft.com/api/mcp', color: '#0078D4', category: 'Code', domain: 'learn.microsoft.com', auth: 'none', description: 'Official Microsoft docs. No sign-in.' }, // 2026-11-14: initialize 200, open
  // Data & analytics
  { id: 'posthog', name: 'PostHog', url: 'https://mcp.posthog.com/mcp', color: '#F54E00', category: 'Data & analytics', auth: 'oauth', description: 'Product analytics and flags.' }, // 2026-11-14: 401+PRM, DCR oauth.posthog.com/oauth/register/
  { id: 'amplitude', name: 'Amplitude', url: 'https://mcp.amplitude.com/mcp', color: '#1E61F0', category: 'Data & analytics', auth: 'oauth', description: 'Product analytics.' }, // 2026-11-14: 401+PRM, DCR mcp.amplitude.com/register
  { id: 'mixpanel', name: 'Mixpanel', url: 'https://mcp.mixpanel.com/mcp', color: '#7856FF', category: 'Data & analytics', auth: 'oauth', description: 'Events, funnels and dashboards (US data region).' }, // NEW 2026-11-14: 401+PRM, DCR mixpanel.com/oauth/mcp/register/ (EU projects: mcp-eu.mixpanel.com, also DCR, as a custom server)
  { id: 'cloudflare-radar', name: 'Cloudflare Radar', url: 'https://radar.mcp.cloudflare.com/mcp', color: '#F38020', category: 'Data & analytics', domain: 'radar.cloudflare.com', auth: 'oauth', description: 'Internet traffic trends, outages and attacks.' }, // NEW 2026-11-14: 401+PRM, DCR radar.mcp.cloudflare.com/register
  { id: 'vanta', name: 'Vanta', url: 'https://mcp.vanta.com/mcp', color: '#5E2DE5', category: 'Data & analytics', auth: 'oauth', description: 'Compliance tests, controls and evidence.' }, // NEW 2026-11-14: 401+PRM, DCR api.vanta.com/oauth/register
  // Research
  { id: 'exa', name: 'Exa search', url: 'https://mcp.exa.ai/mcp', color: '#1F40ED', category: 'Research', auth: 'none', description: 'High-quality web search and page contents. No sign-in.' }, // 2026-11-14: initialize 200, open
  { id: 'custom', name: 'Custom MCP server', url: '', color: '#7C5CFF', category: 'Other', auth: 'oauth', description: 'Any MCP server: a URL, or a local command.' }
]

/** Signs in with one click: the server registers SahilBot itself (or needs no sign-in). */
export function isOneClick(p: Pick<ConnectorPreset, 'auth'>): boolean {
  return p.auth === 'oauth' || p.auth === 'none'
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

type ServerTool = { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string } }

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
  supabase: [
    [/^(execute_sql|apply_migration|deploy_edge_function|merge_branch|reset_branch|rebase_branch|pause_project|restore_project|create_project|create_branch|confirm_cost)$/i, ASK],
    [/^delete_branch$/i, DESTROY]
  ],
  heygen: [
    // Video generation spends plan credits.
    [/(generate|create|render)/i, ASK]
  ],
  hyperframes: [
    [/^render/i, ASK],
    [/^compose$/i, { effect: 'write_external', consequential: false }]
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

export const GOOGLE_PRESETS = ['gmail', 'gcal', 'gdrive']
const GOOGLE_CLIENT_KEY = 'google:oauthClient'
/** The error for an app that needs its one-time OAuth app first. */
export function setupNeeded(p: Pick<ConnectorPreset, 'name' | 'setup'>): string {
  return `${p.name} needs a one-time setup (about ${p.setup?.minutes ?? 5} minutes): open Connect apps → ${p.name} and follow the steps, then it connects with one click.`
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
}

/** Sign-in result page shown in the browser tab. */
function callbackPage(ok: boolean, detail?: string): string {
  const esc = (t: string): string => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  return `<!doctype html><meta charset=utf-8><title>SahilBot</title><body style="font:16px -apple-system;display:grid;place-items:center;height:90vh"><div style="max-width:520px;text-align:center">${ok ? 'Signed in. You can close this tab and return to SahilBot.' : `Sign-in didn't finish.${detail ? `<br><small style="color:#888">${esc(detail)}</small>` : ''}`}</div>`
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
  /** Leave out the RFC 8707 resource indicator (a server that answered invalid_target). */
  noResource = false

  constructor(private id: string, private secrets: Secrets, opts: OauthOptions | { client_id: string; client_secret?: string } = {}, interactive?: boolean) {
    // Older call shape: (id, secrets, staticClient?, interactive?).
    const o: OauthOptions = 'client_id' in opts ? { staticClient: opts, interactive } : { ...opts, interactive: opts.interactive ?? interactive }
    this.staticClient = o.staticClient
    this.fixedRedirect = o.fixedRedirect
    this.interactive = o.interactive ?? true
    this.scopeOverride = o.scope
    this.noResource = this.read<boolean>('noResource') ?? false
  }

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
    const stateBad = !!u.searchParams.get('state') && u.searchParams.get('state') !== this.stateValue
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(callbackPage(!err && !stateBad, stateBad ? 'The sign-in link was out of date. Press Connect again in SahilBot.' : desc ?? (err ?? undefined)))
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
  saveTokens(t: unknown): void { this.write('tokens', t) }

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
    await shell.openExternal(url.toString())
  }
  saveCodeVerifier(v: string): void { this.write('verifier', v) }
  codeVerifier(): string { return this.read<string>('verifier') ?? '' }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'client') this.write('client', undefined)
    if (scope === 'all' || scope === 'tokens') this.write('tokens', undefined)
    if (scope === 'all' || scope === 'verifier') this.write('verifier', undefined)
    if (scope === 'all') { this.write('port', undefined); this.write('noResource', undefined) }
  }
  hasTokens(): boolean { return !!this.read('tokens') }
}

/**
 * Plain words for sign-in failures, with the fix. `setup` is the app's one-time setup guide when it
 * has one; `redirect` is the URL a pre-registered client must use.
 */
export function explainAuthError(message: string, ctx: { name: string; url?: string; hasSetup?: boolean; staticClient?: boolean; redirect?: string }): string {
  const m = String(message ?? '')
  const host = (() => { try { return new URL(ctx.url ?? '').host } catch { return ctx.name } })()
  const redirect = ctx.redirect ?? setupRedirect()
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
  return m
}

export class Connectors {
  private live = new Map<string, Live>()
  private status = new Map<string, ConnectorStatus>()
  /** Pending automatic reconnects and how many tries each has had. */
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private attempts = new Map<string, number>()
  private healthTimer: ReturnType<typeof setInterval> | null = null

  constructor(private db: Db, private secrets: Secrets, private registry: ToolRegistry, private changed: () => void) {}

  list(): ConnectorConfig[] {
    return this.db.getSetting<ConnectorConfig[]>('connectors') ?? []
  }

  /** Catalog entries that match a request and aren't connected yet (for in-chat connect cards): by name first, then by what they do ("seo" → Semrush). */
  suggest(query: string): ConnectorPreset[] {
    const q = query.toLowerCase()
    const connected = new Set(this.list().filter((c) => this.status.get(c.id)?.state === 'connected').map((c) => c.preset))
    const words = q.split(/[^a-z0-9.]+/).filter((w) => w.length > 2)
    const open = PRESETS.filter((p) => p.id !== 'custom' && !connected.has(p.id) && p.auth !== 'browser' && p.auth !== 'app')
    const byName = open.filter((p) => words.some((w) => p.name.toLowerCase().includes(w) || p.id.startsWith(w)))
    const byUse = open.filter((p) => !byName.includes(p) && words.some((w) => !SUGGEST_STOP.has(w) && p.description.toLowerCase().split(/[^a-z0-9]+/).includes(w)))
    // One-click apps first within each group: the in-chat card can connect them right away.
    const ready = (xs: ConnectorPreset[]): ConnectorPreset[] => [...xs.filter(isOneClick), ...xs.filter((p) => !isOneClick(p))]
    return [...ready(byName), ...ready(byUse)]
  }

  /** One-click connect for a catalog entry (OAuth opens the browser). Google apps use the shared client from "Set up Google once". */
  async connectPreset(id: string): Promise<ConnectorStatus> {
    const p = PRESETS.find((x) => x.id === id)
    if (!p || p.auth === 'browser' || p.auth === 'app' || !p.url) throw new Error('This connector needs setup in Connect apps.')
    if (p.auth === 'google' && !this.googleClient()) throw new Error(GOOGLE_SETUP_NEEDED)
    const existing = this.list().find((c) => c.preset === id)
    if (p.auth === 'oauth-static' && !existing?.clientId) throw new Error(setupNeeded(p))
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
    if (prev && prev.clientId !== id) {
      for (const c of this.list()) if (GOOGLE_PRESETS.includes(c.preset ?? '') && !c.clientId) new Oauth(c.id, this.secrets).invalidateCredentials('all')
    }
    this.changed()
    return { clientId: id, hasSecret: true }
  }

  clearGoogleClient(): void {
    this.secrets.set(GOOGLE_CLIENT_KEY, null)
    this.changed()
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

  save(c: Omit<ConnectorConfig, 'id'> & { id?: string }): ConnectorConfig {
    if (c.kind === 'remote' && !/^https?:\/\//.test(c.url ?? '')) throw new Error('Enter the server URL (https://…).')
    if (PRESETS.find((p) => p.id === c.preset)?.auth === 'google' && !c.clientId && !this.googleClient()) throw new Error(GOOGLE_SETUP_NEEDED)
    const preset = PRESETS.find((p) => p.id === c.preset)
    if (preset?.auth === 'oauth-static' && !c.clientId?.trim()) throw new Error(setupNeeded(preset))
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
    let auth: Oauth | undefined
    try {
      if (c.kind === 'stdio') {
        const env = Object.fromEntries(Object.entries({ ...process.env, ...(c.env ?? {}) }).filter(([k, v]) => v !== undefined && !SAFE_ENV_BLOCK.test(k))) as Record<string, string>
        await client.connect(new StdioClientTransport({ command: c.command!, args: c.args ?? [], env, stderr: 'ignore' }))
      } else {
        // Google apps share the client from "Set up Google once" unless this connector has its own.
        const isGoogle = preset?.auth === 'google'
        const shared = isGoogle ? this.sharedGoogle() : null
        const clientId = c.clientId ?? shared?.clientId
        const secret = this.secrets.get(`mcp:${id}:clientSecret`) ?? (c.clientId ? undefined : shared?.clientSecret)
        if (isGoogle && !clientId) throw new Error(GOOGLE_SETUP_NEEDED)
        if (preset?.auth === 'oauth-static' && !clientId) throw new Error(setupNeeded(preset))
        // A pre-registered client (not Google's Desktop client, which takes any loopback port) signs in on the fixed redirect URL it was registered with.
        const fixedRedirect = clientId && !isGoogle ? redirectFor(c.preset) : undefined
        auth = new Oauth(id, this.secrets, { staticClient: clientId ? { client_id: clientId, ...(secret ? { client_secret: secret } : {}) } : undefined, fixedRedirect, interactive })
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
          if (!interactive) { this.attempts.delete(id); this.setStatus({ id, state: 'needs_auth', tools: 0 }); auth!.close(); return this.status.get(id)! }
          this.setStatus({ id, state: 'signing_in', tools: 0 })
          const code = await auth!.waitForCode()
          const t = new StreamableHTTPClientTransport(url, { authProvider: auth })
          await t.finishAuth(code)
          await attempt()
        } finally {
          auth!.close()
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
      const raw = (e as Error).message
      // RFC 8707: a server that rejects resource indicators gets one more sign-in without them.
      if (auth && !auth.noResource && /invalid_target/i.test(raw)) {
        auth.dropResource()
        if (interactive) return this.connect(id, interactive, fromRetry)
      }
      const msg = c.kind === 'remote' ? explainAuthError(raw, { name: c.name, url: c.url, hasSetup: !!preset?.setup, staticClient: !!(c.clientId || preset?.auth === 'google'), redirect: c.clientId ? redirectFor(c.preset) : undefined }) : raw
      const st: ConnectorStatus = { id, state: 'error', tools: 0, error: msg.slice(0, 400) }
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
      this.setStatus({ id, state: 'error', tools: 0, error: `${why} (stopped retrying; press Reconnect)` })
      return
    }
    this.attempts.set(id, attempt)
    const wait = backoffMs(attempt)
    this.setStatus({ id, state: 'reconnecting', tools: 0, error: why, attempt, retryAt: Date.now() + wait })
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
      if (e instanceof UnauthorizedError || /\b401\b|unauthori[sz]ed|invalid_token|invalid_grant/i.test(msg)) {
        await this.teardown(id)
        this.setStatus({ id, state: 'needs_auth', tools: 0, error: 'Sign-in expired', checkedAt: Date.now() })
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

  // ---------------------------------------------------------------- calls from SahilBot itself (not the model)

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
    return {
      name,
      label: c.name,
      group: c.name,
      effect: policy.effect,
      untrusted: true,
      consequential: (args) => toolPolicy(c.preset, t.name, t.annotations, args).consequential,
      ...(policy.hardStop ? { hardStop: () => policy.hardStop! } : {}),
      describe: (args) => `${c.name}: ${t.annotations?.title ?? t.name.replace(/_/g, ' ')} ${JSON.stringify(args).slice(0, 160)}`,
      description: `[${c.name}] ${(t.description ?? t.name).slice(0, 900)}`,
      parameters: t.inputSchema && Object.keys(t.inputSchema).length ? t.inputSchema : { type: 'object', properties: {} },
      async run(args, ctx) {
        let r: Awaited<ReturnType<Client['callTool']>>
        try {
          r = await client.callTool({ name: t.name, arguments: args as Record<string, unknown> }, undefined, { signal: ctx.signal, timeout: 120_000 })
        } catch (e) {
          const m = (e as Error).message
          if (!ctx.signal.aborted && isConnectionError(m)) {
            lost(m)
            throw new Error(`${c.name} lost its connection (${m.slice(0, 80)}). SahilBot is reconnecting on its own: try again in a minute, or tell the user to check Connect apps.`)
          }
          throw e
        }
        const { text, images } = contentOf(r)
        if (r.isError) throw new Error(text || `${t.name} failed`)
        return { text: text || '(no output)', images: images.length ? images : undefined, display: t.annotations?.title ?? t.name.replace(/_/g, ' ') }
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
