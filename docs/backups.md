# Backups

SahilBot keeps a copy of everything in a separate place, so losing the data folder, the knowledge vault or
this Mac doesn't lose the user's work. Code: `src/main/backup.ts` (what goes in, the key recovery file),
`src/main/updater.ts` (`backupData`, the daily copy), Settings → Privacy & Security → Backups
(`src/renderer/src/components/BackupSettings.tsx`).

## When
- Once a day while SahilBot is open (the Mac app), before every update, and when the user clicks
  **Back up now**. Setting a recovery password starts one right away.
- The newest 5 backups are kept in `~/Library/Application Support/SahilBot Backups`, the newest 3 in a second
  folder, `~/SahilBot Backups`, and the newest 3 in an **extra folder** if the user picked one (an external drive,
  for example). The extra folder can't be inside SahilBot's data folder or one of the other backup folders.

## What a backup holds
Each backup is a dated folder:
- **The data folder**: the database (a consistent copy while it's open), settings, bot prompts. Caches,
  logs and downloaded models are left out (they come back on their own). API keys in it are sealed with this
  Mac's Keychain, so they only open on this Mac.
- `vault/`: the knowledge vault's notes, with `.history/`. Left out: `.trash/`, symlinks (never followed out of
  the vault), and files over 50 MB. A vault that sits inside the data or backup folder isn't copied twice; a
  backup folder inside the vault is skipped.
- `export/`: `memories.md` (grouped by who sees them, then by category), `decisions.md` (the user's
  decisions, newest first, "context → choice") and `memories.json`. Plain text anyone can open without
  SahilBot. A memory that reads like it holds a password or number is left out.
- `keys.sbrecovery`: only once the user sets a **recovery password**. Every saved API key and connector token,
  encrypted so the keys can be restored on any Mac without this one's Keychain.
- `BACKUP-CONTENTS.txt`: what each part is.

## The recovery file
- The password is stretched with scrypt (parameters benchmarked on this Mac, stored in the file's header with
  the salt), then the keys are sealed with AES-256-GCM. The header (format, version, KDF parameters, date,
  count) is bound into the encryption, so changing any of it makes the file fail to open. Key names and values
  are both inside the encrypted part.
- SahilBot never stores the password. It keeps the derived key as a Keychain-sealed secret so the daily
  backup can write the file without asking. A forgotten password can't be recovered: set a new one, and the
  next backup uses it (older files still need the old one).
- **Restore keys from a backup**: the user picks a `keys.sbrecovery` file and types its password. Keys already
  saved here are kept unless they tick "Replace keys I already have". A wrong password or an edited file says
  so and changes nothing. Values are never sent to the window or the model.
- **Not in the file, on purpose**: the passwords vault's own keys (`vault2:*`). With them, anyone holding a copy
  of the data folder and the recovery password could open saved passwords and cards that are otherwise tied to
  this Mac's Keychain and master password. Saved passwords and cards have their own encrypted backup
  (Privacy & Security → Passwords → Backup; see secrets-vault.md).

## Restoring everything
Quit SahilBot, copy a backup's files (not `vault/`, `export/` or `keys.sbrecovery`) back into the data folder,
copy `vault/` back to the vault folder, and open SahilBot. On a new Mac, the API keys in the database won't open
(they were sealed by the old Mac's Keychain): restore them from `keys.sbrecovery` in Settings → Privacy &
Security → Backups.

On SahilBot Server, a paired browser can't set the recovery password or restore keys; that's done in the Mac app.
