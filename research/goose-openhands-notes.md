# Goose (aaif-goose/goose, Apache-2.0) and OpenHands (OpenHands/OpenHands + software-agent-sdk, MIT)

Adapted into Foreman: JSON control-char sanitizing before parse (OpenHands agent/utils.py), closing an unterminated
<function=…> (OpenHands _fix_stopword), turn budget shown after half the steps (Goose moim.rs turn_budget),
"don't re-verify completed work" todo framing (Goose todo.rs).

Later candidates: Goose toolshim cascade + second "interpreter" model, permission_judge (forced-tool read-only classifier),
SubdirectoryHintTracker, recipes/delegate (summon.rs), compaction middle-out tool-response removal on summarizer overflow;
OpenHands stuck_detector.py (monologue, A/B alternation), tool-pair-safe condensation boundaries, skills keyword/path triggers,
model-filled security_risk + ConfirmRisky, NonInteractiveMCPOAuth for scheduled runs, paged markdown browser content.
Apache-2.0 ports need the license copy + "changed" notices.
