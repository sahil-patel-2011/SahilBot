// A tiny local MCP server (stdio) standing in for a real connector in tests.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const notes = [{ id: 'n1', title: 'Q4 launch', body: 'Launch date is Dec 1. Owner: Sam.' }]
const server = new McpServer({ name: 'notes', version: '1.0.0' })
server.registerTool('search_notes', { description: 'Search notes by keyword', inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
  async ({ query }) => ({ content: [{ type: 'text', text: JSON.stringify(notes.filter((n) => (n.title + n.body).toLowerCase().includes(query.toLowerCase()))) }] }))
server.registerTool('send_note', { description: 'Send a note to someone', inputSchema: { to: z.string(), text: z.string() } },
  async ({ to, text }) => ({ content: [{ type: 'text', text: `Sent to ${to}: ${text}` }] }))
await server.connect(new StdioServerTransport())
