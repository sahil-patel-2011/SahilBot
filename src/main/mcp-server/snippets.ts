import type { McpNewClient } from '@shared/types'
import { shQuote } from './shim'

// Ready-to-paste configs shown once with a new app's token.

export function snippets(url: string, token: string, shimPath: string | null): McpNewClient['snippets'] {
  const cursor = JSON.stringify({ mcpServers: { sahilbot: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)
  const claudeCode = `claude mcp add --transport http sahilbot ${url} --header "Authorization: Bearer ${token}"`
  const claudeDesktop = JSON.stringify({ mcpServers: { sahilbot: { command: shimPath ?? 'sahilbot-mcp', env: { SAHILBOT_MCP_TOKEN: token } } } }, null, 2)
  const call = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_brain', arguments: { question: 'Where did we leave it with our biggest client?' } } })
  const curl = `curl -s ${url} \\\n  -H "Authorization: Bearer ${token}" \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: application/json, text/event-stream" \\\n  -d ${shQuote(call)}`
  // Codex CLI (~/.codex/config.toml) launches MCP servers as commands, like Claude Desktop.
  const codex = `[mcp_servers.sahilbot]\ncommand = ${JSON.stringify(shimPath ?? 'sahilbot-mcp')}\nenv = { SAHILBOT_MCP_TOKEN = ${JSON.stringify(token)} }`
  // ChatGPT's connectors (Developer mode) are called from OpenAI's servers, which can't reach a server
  // that only listens on this Mac. Said plainly instead of a config that wouldn't work.
  const chatgpt = 'ChatGPT can’t use this yet: its connectors (Developer mode) are called from OpenAI’s servers and need a public HTTPS address, and SahilBot’s MCP server only listens on this Mac (127.0.0.1) so your brain never leaves it. Use Claude Desktop, Claude Code, Cursor, Codex CLI or another MCP app that runs on this Mac. Your teammates can ask your brain from their phones with Team access instead (Settings → General → Phone access → Team).'
  return { cursor, claudeCode, claudeDesktop, curl, codex, chatgpt }
}
