---
name: shell-scripting
description: Write or fix bash and zsh scripts that are safe and portable - strict mode, quoting, traps, shellcheck, macOS BSD vs GNU tool differences.
source: you
uses: 0
category: Coding
triggers: bash script, zsh script, shellcheck, set -euo pipefail, shebang, shell quoting, trap exit, mktemp, sed -i macos, xargs -0, find -print0, getopts, unbound variable, bad substitution, bsd vs gnu
---

## When
Any .sh/.bash/.zsh file, Makefile recipe logic, CI step scripts or a one-liner that grew. If it passes ~100 lines or needs real data structures, suggest python-script instead.

## Steps
1. Choose the shell: #!/usr/bin/env bash for scripts (zsh is the macOS login shell, but scripts should be explicit). macOS ships bash 3.2: no declare -A, mapfile/readarray, ${var,,} or &>> unless the script requires Homebrew bash. Check with bash --version.
2. Start with set -euo pipefail. Optionally IFS=$'\n\t'.
3. Write functions with local variables and a main "$@" at the bottom.
4. Lint with shellcheck script.sh and fix every warning (disable a check only with a comment why). bash -n script.sh for syntax; shfmt -d for format if used.
5. Test with a dry run first, then on a scratch directory, then for real. Trace with bash -x script.sh.

## Rules
- Quote every expansion: "$var", "$(cmd)", "${arr[@]}". Unquoted variables split on spaces and glob.
- "$@" forwards arguments intact; $* and unquoted $@ break filenames with spaces.
- Arrays for argument lists: args=(-v --out "$dir"); cmd "${args[@]}". Never build commands in strings and eval.
- [[ ]] in bash/zsh ( [[ -f $f && $n -gt 0 ]] ); [ ] with quotes in POSIX sh. Arithmetic in (( )).
- $(...) not backticks. printf '%s\n' over echo for arbitrary data.
- Required vars: : "${API_URL:?set API_URL}". Defaults: ${PORT:-8080}.
- Never rm -rf "$dir/" when dir might be empty; write rm -rf -- "${dir:?}/" and keep targets inside a known root.
- Temp files: tmp=$(mktemp -d); trap 'rm -rf -- "$tmp"' EXIT. Traps also restore state (cd, stash) on error.
- Errors go to stderr (>&2) with a nonzero exit; usage() on bad arguments; parse flags with getopts or a while/case loop.

## set -e caveats
It does not fire inside if/while conditions, left of && or ||, or in functions called from those. local x=$(cmd) hides cmd's failure; declare then assign. Check critical commands explicitly: cmd || die "cmd failed".

## Filenames
find . -name '*.log' -print0 | xargs -0 rm -- ; or while IFS= read -r -d '' f; do ...; done < <(find . -print0). Never parse ls. Use -- before filenames that might start with a dash.

## macOS BSD vs GNU
- sed -i: BSD needs sed -i '' 's/a/b/' f, GNU sed -i 's/a/b/' f. Portable: sed -i.bak 's/a/b/' f && rm f.bak, or perl -pi -e.
- date: BSD date -v-1d +%F vs GNU date -d yesterday +%F. stat -f %z (BSD) vs stat -c %s (GNU).
- readlink -f and realpath are missing on older macOS; use cd "$(dirname "$0")" && pwd -P for the script dir.
- grep -P, xargs -r, sort -V, timeout are GNU-only (brew install coreutils gnu-sed gives gsed, gdate, gtimeout). Test on the target OS.

## Idempotence and dry runs
Scripts should be safe to rerun: mkdir -p, ln -sfn, cp -n, grep -q before appending to a config, check before create. Add a -n/--dry-run flag that prints instead of executes for anything destructive.

## Verify
shellcheck clean, bash -n passes, a dry run shows the intended actions, a run on a scratch copy produces the expected files and exit code 0 (echo $?).

## Example
```bash
#!/usr/bin/env bash
set -euo pipefail
DRY=0; [[ ${1:-} == -n ]] && { DRY=1; shift; }
run() { if (( DRY )); then printf 'would run:'; printf ' %q' "$@"; echo; else "$@"; fi; }
src=${1:?usage: sync.sh [-n] SRC DEST}; dest=${2:?usage: sync.sh [-n] SRC DEST}
tmp=$(mktemp -d); trap 'rm -rf -- "$tmp"' EXIT
run rsync -a --delete -- "$src/" "$dest/"
```
