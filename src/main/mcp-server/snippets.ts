import type { McpNewClient } from '@shared/types'
import { shQuote } from './shim'

// Ready-to-paste configs shown once with a new app's token.

export function snippets(url: string, token: string, shimPath: string | null): McpNewClient['snippets'] {
  const cursor = JSON.stringify({ mcpServers: { sahilbot: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)
  const claudeCode = `claude mcp add --transport http sahilbot ${url} --header "Authorization: Bearer ${token}"`
  const claudeDesktop = JSON.stringify({ mcpServers: { sahilbot: { command: shimPath ?? 'sahilbot-mcp', env: { SAHILBOT_MCP_TOKEN: token } } } }, null, 2)
  const call = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_bot', arguments: { bot: 'SahilBot', message: 'What is on my plate today?', wait_seconds: 60 } } })
  const curl = `curl -s ${url} \\\n  -H "Authorization: Bearer ${token}" \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: application/json, text/event-stream" \\\n  -d ${shQuote(call)}`
  return { cursor, claudeCode, claudeDesktop, curl }
}
