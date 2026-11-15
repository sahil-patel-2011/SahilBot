---
name: python-script
description: Write and run a Python script safely, with its own virtual environment.
source: you
uses: 0
category: Coding
triggers: python script, quick script, one-off script, automate with python, script to, venv for a script
---

1. Put the script in the workspace (or the attached folder). Keep it in one file unless it's big.
2. Dependencies: `python3 -m venv .venv && . .venv/bin/activate && pip install <pkgs>` (installing asks for approval). Prefer the standard library when it's enough.
3. Write the script with a `main()` and clear error messages. Read inputs from arguments or files, never hard-code personal data.
4. Run it on a small sample first, check the output, then the full input.
5. Report the command to run it again and where the outputs are.
