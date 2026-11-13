---
name: frc-code-team-git
description: Git workflow for an FRC programming team: branches per feature, protected main that always builds, event branches and tags, reviews, what to ignore, and recovering at competition.
source: you
uses: 0
category: FRC Programming
---

Use git-workflow for the general mechanics (commits, PRs, gh). This adds what robotics teams need. Pushing, merging and deleting branches need the user's OK.

## Branch model
- `main`: always builds (`./gradlew build` green) and has been driven on a robot or in sim. Protect it on GitHub (PR + one review + CI build).
- Feature branches: `elevator-motion-magic`, `auto-3-piece`. Short-lived; rebase or merge main often.
- Event branches: `event/<eventkey>` (e.g. `event/2026casj`) cut from main before the event; only fixes during the event; merge back after.
- Tags for what actually played: `<eventkey>-qm42` or `<eventkey>-final`, so you can redeploy known-good code in minutes.

## Habits
- Commit before every deploy at events (message: change + why + match), so the robot's code is always reproducible. WPILib can embed the git SHA (gversion or AdvantageKit BuildConstants) — log it as metadata to know what ran in each match.
- Small PRs, one mechanism or feature each; describe how it was tested (sim, robot, unit test).
- Review checklist: frc-code-review-checklist.
- Generated files: commit `src/main/deploy/pathplanner/**` and `choreo/**` paths/autos (they are robot code); don't commit `build/`, `.gradle/`, `bin/`, logs, `*.wpilog`, `*.hoot`, `networktables.json`, `simgui*.json` unless the team wants them.
- Never commit secrets (TBA keys, Wi-Fi passwords).

## .gitignore essentials (WPILib template already has most)
```
build/
.gradle/
bin/
*.wpilog
*.hoot
logs/
.DS_Store
```

## CI (GitHub Actions)
Run `./gradlew build` on every PR with the WPILib container image or `actions/setup-java` (Java 17 for 2026) — catches compile errors and failing tests before they reach the robot. Check the WPILib docs for the current recommended workflow.

## Recovering at competition
- Robot misbehaves after a change: `git log --oneline -5`, `git switch --detach <last-good-tag>`, build, deploy (with the user's OK), then investigate on a branch.
- Lost laptop: any laptop with the repo + offline cache can deploy; keep two ready.
- Merge conflict in constants/autos at an event: prefer the version that played; resolve in the pit with the lead.

Links: https://docs.wpilib.org/en/stable/docs/software/basic-programming/git-getting-started.html · https://docs.github.com/en/actions
