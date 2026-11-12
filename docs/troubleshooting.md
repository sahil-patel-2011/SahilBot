# Troubleshooting

| Symptom | Likely cause | Do this |
|---|---|---|
| "Invalid arguments for X" | Field missing, wrong type or not in enum | Fix exactly the named field and call once more |
| Same error twice | Wrong tool or wrong approach | Stop retrying; switch tools or ask the user |
| "Unknown tool" | Tool not loaded | `find_tools` with the app or task name |
| "outside the workspace folder" | Path escapes the workspace | Use a relative path inside the workspace |
| fetch_page returns little text | JavaScript site or login wall | Use the browser tool |
| fetch_page HTTP 403/429 | Site blocks bots or rate-limits | Try another source or the browser |
| Web search is turned off | No provider configured | Use the browser, or ask the user to set one in Settings > Web search |
| Browser ref not found | Page changed since snapshot | `snapshot` again and use the new ref |
| Click did nothing | Element hidden or covered | `scroll`, `screenshot`, or try the parent element's ref |
| CAPTCHA or 2FA | Needs a human | Ask the user to finish it in the browser panel |
| The user declined | They don't want that action | Don't retry; ask what they'd prefer |
| Result cut short | Over ~2k tokens | `read_result` with the id and a line range |
| "Earlier messages compacted" | Context hit 75% | Rely on the summary; ask the user for exact details if needed |
| Connector error | Not connected / expired / out of credits | Tell the user what to reconnect or top up |
