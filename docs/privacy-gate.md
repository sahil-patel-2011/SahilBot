# Hybrid compute and the Privacy Gate

Generally available since 26.11.21.

Hybrid compute lets a chat use cloud models for planning, research and reasoning while personal details stay on the Mac. It follows the design of Perplexity's hybrid compute on Mac ([announcement](https://www.perplexity.ai/hub/blog/introducing-hybrid-compute-on-mac), [PII-TRACE](https://www.perplexity.ai/hub/blog/pii-trace-detecting-personal-data-before-it-leaves-the-device)).

## Turning it on

**Settings → Privacy & Security → Hybrid compute.** It's off until the user turns it on.

| | Memory | Free disk |
|---|---|---|
| Minimum | 32 GB | 50 GB |
| Best: the strongest local models at full quality | 64 GB | 150 GB |

It needs Apple Silicon. The switch says what this Mac has and stays off if the Mac is below the minimum. Turning it on downloads PII-Tracer (about 1.2 GB). The gate then checks requests in any chat that has both a local model and a cloud model set up.

## What the gate does

Before every cloud request in a chat, SahilBot checks on this Mac everything the cloud model hasn't been checked for yet: the user's messages, tool results and earlier replies. The checker is [PII-Tracer](https://huggingface.co/perplexity-ai/PII-Tracer), Perplexity's open 0.6B detector (MIT). It tags names, email addresses, phone numbers, addresses, private links, personal dates, account and ID numbers, secrets and other personal details. A document check also flags whole personal records: bank and card statements, internet, phone and utility bills, pay stubs, tax forms, medical records and ID documents.

When it finds something new, the chat pauses on a card. **View items** lists each detail; untick anything that isn't personal. Then pick one:

1. **Process on my Mac** (recommended when a local model is set up): the task moves to the strongest local model and carries on there with the same context.
2. **Split: cloud plans, Mac keeps the details**: the cloud model sees stand-ins like `[PERSON_1]` and `[EMAIL_1]`, and a note in place of any flagged document. It can ask the local model about them with the `ask_on_mac` tool. Whatever it writes, including tool calls, gets the real values back on this Mac before it runs or is shown.
3. **Share anyway**: sends the content as it is. Passwords, keys, card, account and ID numbers stay masked unless unticked.
4. **Skip content** (Esc): the message or tool result is withheld from cloud models.

**When it finds personal details** (Settings → Hybrid compute) is either:

- **Ask me** (the default): the card above.
- **Protect automatically**: the gate makes the safe choice without pausing. Cloud models get stand-ins. A personal record, such as a bank statement, moves to the model on the Mac when there is one. A note in the chat says what was protected.

**Not personal, everywhere.** A detail you untick on the card is remembered for every chat and never asked about again. Passwords, keys and account numbers are never remembered this way. **Forget** in Settings clears the list.

**Today.** Settings shows what the gate did today: the requests and parts checked, how often it asked, what it protected automatically, what the local model cleared as not personal, and any failed checks.

**Self-test.** After the download, PII-Tracer checks a made-up sample. **Test** runs the check again any time. If its server crashes mid-check (for example after sleep), it restarts and checks once more. If the check still fails, nothing unchecked is sent.

**Don't ask again for this chat** applies the same choice to later finds in the chat. Every choice is remembered per detail, so each one is asked about once per chat. With every choice except Share anyway, cloud models see stand-ins for those details from then on.

## What stays usable

- **The vault.** Cloud models can still use saved logins and cards: the vault never shows a saved value to any model, so its output isn't checked.
- **Auto routing.** While the gate is on, Auto's brain only uses local readers, so a cloud model never reads a request before the gate does.
- **Summaries.** Compaction summaries use a local model when there is one. Otherwise the chat's cloud model gets the masked transcript.

## Limits

- PII-Tracer can miss details or flag ones that aren't personal. "View items" is there to correct it.
- Images aren't checked.
- If the check itself fails, the request isn't sent: the run stops with the reason.
- Perplexity's Decider classifier isn't used. v1.3 needs PyTorch on an NVIDIA GPU, and the only GGUF build (v1.2 Flash, 5.2 GB) uses a readout format stock llama.cpp doesn't run. Auto routing and PII-Tracer's sensitivity cover that role.

## Implementation

- `src/main/privacy/tracer.ts`: download (pinned llama.cpp `b12596` and Hugging Face commit, each file checked against its SHA-256), a private `llama-server` on `127.0.0.1` with pooling off, and the heads plus constrained BIOES Viterbi from Perplexity's `example_client.py`, ported to TypeScript.
- `src/main/privacy/gate.ts`: findings, the user's answers, masking (including tool-call arguments and Claude's blocks, leaving signed thinking blocks alone) and restoring, including stand-ins split across stream chunks.
- `src/main/privacy/documents.ts`: the document check.
- `src/main/agent/loop.ts` `privacyGate()`: the check before each cloud step, and the move to a local model.
- `src/main/agent/tools/ask-on-mac.ts`: split mode's question to the local model; its answer is checked and masked before it goes back.
