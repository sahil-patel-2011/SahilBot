// "Import memory to SahilBot": the prompt the user copies into another assistant (ChatGPT, Claude,
// Gemini…) so it exports what it knows about them in a shape SahilBot's parser reads well. Shared so
// the dialog can show it without a round trip; the parser lives in src/main/memory-import.ts.

export const IMPORT_SECTIONS = ['instructions', 'identity', 'career', 'projects', 'preferences', 'other'] as const
export type ImportSection = (typeof IMPORT_SECTIONS)[number]

export const IMPORT_SECTION_LABEL: Record<ImportSection, string> = {
  instructions: 'Instructions',
  identity: 'Identity',
  career: 'Career',
  projects: 'Projects',
  preferences: 'Preferences',
  other: 'Other notes'
}

export const MEMORY_IMPORT_PROMPT = `I'm moving to a new AI assistant called SahilBot and want to bring along what you know about me.

Please export everything you have stored or learned about me: saved memories, custom instructions, and details you've picked up from our past conversations. Quote things verbatim wherever you can, and keep the specifics (names, numbers, dates, tools, and any wording I asked you to use) instead of summarizing them away.

Organize the export under these headings, in this order:

1. Instructions: explicit rules I've given you about how to respond or behave (tone, format, things to always or never do).
2. Identity: who I am (name, where I live, background, family, languages, other personal details).
3. Career: my work, roles, employers, education and skills.
4. Projects: one entry per project, covering what it is, its current status, and the key decisions made.
5. Preferences: what I like and dislike, my style, and the tools I choose.
6. Other notes: anything else you know about me that doesn't fit above.

Write each item on its own line, in this format:
[YYYY-MM-DD] - entry
Use the date the information was saved or last came up. If you don't know the date, write [unknown] - entry instead.

Put the entire export inside a single code block so I can copy it in one go. Leave out passwords, API keys, account numbers and any other secrets.

After the code block, tell me whether this export is complete, or whether there is more you couldn't include.`
