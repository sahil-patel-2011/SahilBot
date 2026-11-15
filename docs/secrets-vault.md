# The secrets vault

SahilBot's vault holds passwords (with optional authenticator keys), payment cards, IDs, secure notes
and addresses. The assistant never reads them. SahilBot types them into a website itself, after the
user approves, and only after a series of checks. This page describes exactly what protects the data
and what doesn't. (The *knowledge* vault of linked notes is a different thing: see vault.md.)

Code: `src/main/secure/` (crypto, core, guards, auth, redaction, backup, migration, IPC),
`src/main/vault.ts` (the API the rest of the app uses), the fill path in `src/main/agent/tools/browser.ts`
and `src/main/browser/manager.ts` (`fillSecretValue`), and Settings → Vault
(`src/renderer/src/components/VaultSettings.tsx`, `VaultAuthDialog.tsx`).

## Encryption

Only `node:crypto` is used; there are no extra dependencies.

```
K1   = 32 random bytes, kept in the macOS Keychain through Electron safeStorage (tied to this app)
K2   = scrypt(master password, 16-byte salt)                       only when a master password is set
KEK  = HKDF-SHA256(K1 || K2, 32-byte vault salt, "sahilbot-vault/kek/v1/<mode>/<vault id>")
MK   = 32 random bytes: the vault master key, stored only as AES-256-GCM(KEK, MK)
DK   = 32 random bytes per item *version*, stored as AES-256-GCM(MK, DK, AAD = vault id + item id)
item = AES-256-GCM(DK, payload JSON, AAD = canonical JSON {format, vault id, item id, type, version, metadata})
```

- **AES-256-GCM everywhere**, 96-bit random nonce for every encryption (a new one on every save) and
  a 128-bit tag. Stored as `version byte || nonce || ciphertext || tag`.
- **Associated data binds each ciphertext to its place.** The item AAD contains the item id, type,
  version and its metadata, which includes the allowed site(s). Moving a ciphertext to another item,
  or editing an item's site, card last-4 or name, makes decryption fail. The data key's AAD contains
  the vault id and item id, so wrapped keys can't be swapped between items either.
- **Envelope encryption.** Every item version has its own data key; data keys are wrapped by the
  vault master key. Changing the master password re-wraps one key and touches no items.
- **Signed manifest.** The header keeps `{item id → version}` with an HMAC-SHA256 (key derived from
  MK with HKDF). On unlock and on every read it is checked: a row that was deleted and put back,
  rolled back to an older version, or added from elsewhere is refused (`TamperError`). If the manifest
  itself was edited, the whole vault is marked as tampered and nothing is filled until the user
  reviews it in Settings → Vault ("I changed it (accept)" re-signs it).
- **Modes.** `kc` (Keychain only), `kc+pw` (Keychain and master password: both are needed) and
  `kc+bio` (an optional second copy of MK for Touch ID unlock while a master password is set).

### Password stretching

The master password (and a backup's password) is stretched with **scrypt**. When a password is set,
SahilBot benchmarks this Mac and picks the strongest cost that takes about 0.5–1 s: it starts at
N = 2^17 (128 MiB) and raises N up to 2^20 while one derivation stays under a second. On an M-series
Mac this lands on **N = 2^18, r = 8, p = 1 (256 MiB), about 0.55 s**. The parameters and salt are
stored in the vault header, so a later change of hardware doesn't lock anyone out.

**Argon2id:** Electron 45's Node (24.x) exposes `crypto.argon2`, but its BoringSSL build throws
`ERR_CRYPTO_ARGON2_NOT_SUPPORTED`. SahilBot probes it once with a tiny derivation; if a future
Electron supports it, new master passwords use Argon2id (64 MiB–1 GiB, 3 passes, 4 lanes, benchmarked
the same way). Today, in the app, it is scrypt. (Unit tests run on plain Node, where Argon2id works and
is tested too.)

### What is not encrypted

Item **metadata** is stored in the clear so SahilBot can list items and match sites while the vault is
locked: the item's name, type, site(s), whether it has an authenticator key, a masked username hint
(`sa•••@example.com`), card brand, last four digits and expiry month/year, an ID's kind and last four,
and an address's city/region/country. Metadata is bound into the AAD, so it can't be changed without
breaking decryption. Usernames, passwords, authenticator keys, full card numbers, security codes,
cardholder names, ID numbers and full addresses are encrypted.

## Unlocking

- **Touch ID** (`systemPreferences.canPromptTouchID` / `promptTouchID`) and/or the **master password**,
  typed into the app's own dialog (main asks; the window only shows the request and sends back what
  was typed). With a master password set, unlocking needs K1 *and* K2. Touch ID is a presence check by
  macOS, not an extra encryption key: with "Touch ID unlock" on and a master password set, a second
  copy of MK is protected by the Keychain only (SahilBot says this in Settings).
- **No master password and no Touch ID**: there is nothing stronger than the user's click, so
  unlocking (and saving an item) opens the vault. Settings shows this plainly and suggests a master
  password.
- **Failed attempts back off**: two free tries, then 1 s, 2 s, 4 s … up to 5 minutes, persisted across
  restarts. (This only slows guessing through the app; against a stolen copy of the data the scrypt
  cost and the Keychain key are the protection.)
- **Auto-lock** after N minutes without use or with the Mac idle (default 15; 1, 5, 15, 30, 60, 240 or
  "only on sleep and quit"), when the Mac sleeps or the screen locks (`powerMonitor`), and on quit.
  Locking wipes MK.
- **Re-authentication** right before a card or ID is filled (Touch ID or the master password; with
  neither available, the Purchase card / approval click is the check), before Reveal, export, removing
  the old copies, and before loosening a setting. Optional for passwords too ("Confirm before typing
  passwords"). One confirmation counts for 60 seconds.
- **Hidden test runs** (`SAHILBOT_HIDDEN=1`) never prompt Touch ID.

## Never exposed

- **The model** only gets names, sites, card brand and last four (`wallet`, error messages). Fill
  results say "Filled the password for "acme". (The value is hidden from you.)".
- **The renderer** gets metadata only. The single exception is **Reveal**, after Touch ID or the master
  password: values are shown for 20 seconds (hidden sooner when the window loses focus), are not
  selectable, can't be copied, and the window is excluded from screenshots and screen recording
  (`setContentProtection`) while they're shown. There is no "copy to clipboard", so nothing lands in
  clipboard history. `tests/unit/vault-ipc.test.ts` calls every vault IPC handler with known secrets
  saved and checks that no reply or error contains one.
- **Logs and the audit log** never get values (callers pass names and hosts; a scrubber masks any saved
  value anyway). Errors from vault IPC handlers are masked too.
- **Crash reports**: SahilBot doesn't run a crash reporter, so nothing is uploaded; vault errors carry
  names and sites, never values.
- **Tool arguments** carrying a saved value are blocked outright (the leak check in permissions.ts).
- **Redaction**: every tool result and tool error goes through `vault.redact` before the model sees it
  (`src/main/secure/redact.ts`, hooked into the agent loop). Passwords, authenticator keys and ID
  numbers become `[hidden by vault]`; card numbers are matched however they're grouped and become
  `•••• 4242`. Values typed into a page in the last 30 minutes stay masked even after the vault locks.
- **Buffers**: keys and decrypted bytes are Buffers and are zeroed after use. JavaScript strings can't
  be zeroed; a value that has to become a string to be typed is dropped right after and left to the
  garbage collector.

## Fill guards

Before a value is typed (`fill_secret` for logins and IDs, `fill_payment` for cards):

1. **Site**: the page's origin is the item's saved origin (exact scheme, host and port), or one of its
   subdomains if the user opted in (never across a public suffix such as github.io). IDs fill only on
   the sites listed with them (none listed: reveal only).
2. **HTTPS**: the page, the field's frame and the form's destination are HTTPS (loopback http on this
   Mac counts as secure, as in browsers). A form that sends to another site, to `javascript:` or over
   http is refused.
3. **Approval**: the user's approval card for this exact call (`fill_secret` is a hard stop in every
   mode), or the user's own standing rule for that login's site ("Sign in on this site without asking":
   its username and password only, on its own site only). Without either, an attended run asks; an
   unattended one is refused. Text on a web page can't approve anything, and a page can't redirect a
   fill to another site, field or tab.
4. **Unlocked**: if locked, the user is asked to unlock (Touch ID or the master password). Unattended
   runs never show the dialog; they stop and say the vault is locked.
5. **The field**, checked in an isolated world (page scripts can't fake it) right before typing: an
   enabled `<input>` of the right kind (`type=password` or `autocomplete=current-password/new-password`
   for passwords; a text/email field that isn't a password or card field for usernames), visible
   (not `display:none`, `visibility:hidden`, transparent, `aria-hidden`, clipped or off-screen), in the
   page's own site, then **focused and verified as the focused element** before CDP `Input.insertText`
   types the value. The tab and site are checked again just before typing.
6. **Cards**: the full number (and the security code, if the user chose to keep it; off by default, so
   SahilBot asks the user to type it at checkout) go only into the checkout fields of the merchant
   whose Purchase card the user approved, on a secure page, during that approved step, plus
   re-authentication. The browser's card guard still blocks the number from leaving to any other host.

Each fill, block and failure is written to the audit log.

## Audit log

Settings → Vault → Activity: unlocks, failed unlocks, locks (and why), fills, blocked fills, reveals,
re-authentications, exports, imports, item changes, master password changes, migration and tamper
checks, with time, item name, site and outcome. Never values. The last 5,000 entries are kept.

## Backup

- **Encrypted export** (`.sbvault`): the same envelope format, with a fresh export key wrapped under the
  backup password alone (scrypt, benchmarked), so it can be restored on another Mac without this
  Mac's Keychain. Written with owner-only permissions. Needs the vault unlocked and a re-authentication.
- **Import**: every item is decrypted and checked before anything is written (a wrong password or a
  changed file imports nothing); items already saved are skipped.
- **CSV import** from Chrome, Safari, 1Password, Bitwarden, LastPass, Firefox or Dashlane exports
  (`url` and `password` columns, plus name, username, totp and notes when present). SahilBot then tells
  the user to delete the CSV and empty the Trash.

## Migration from the old format

Before this version each item was one safeStorage string (`secret:vault:<name>`, `secret:card:<id>`,
`secret:address:<id>`) with plain indexes in settings. On start, SahilBot copies them into the vault
in **one transaction**: each copy is decrypted again and compared field by field; any mismatch or
error rolls the whole transaction back and the old data stays as it was (and is retried next start).
Entries the Keychain can no longer open are reported in Settings. **Nothing old is deleted**: the old
copies stay as the rollback copy until the user chooses "Remove old copies" (which re-checks that every
one decrypts in the new vault first). "Write a rollback copy" writes the current logins, cards and
addresses back in the old format (read back to verify) for going back to an older SahilBot.

## Threat model

**Protects against**
- Someone with a copy of SahilBot's data folder (a backup, a stolen disk image) but not this Mac's
  Keychain: they can't decrypt anything. With a master password they'd need the Keychain *and* to guess
  the password at ~0.5 s and 256 MiB per guess.
- Another app reading the database: the Keychain item belongs to SahilBot (macOS asks before another
  app can use it), and values are encrypted under it.
- The assistant, a prompt injection on a web page, a malicious bot or connected app: values never go
  into the model's context, can't be sent in a tool call, are typed only on their own site after the
  user's approval, and are masked if a page echoes them.
- A phishing page or a lookalike domain, an http page, a hidden decoy field, a form that posts to
  another site, a tab or page swap during approval.
- Swapped, edited, rolled-back or injected vault rows (AES-GCM tags, AAD and the signed manifest).
- Leaving the Mac unattended: auto-lock on idle, sleep and the lock screen.

**Can't protect against**
- **Malware running as the user while the vault is unlocked**: it can read SahilBot's memory, the
  pages SahilBot types into, or drive the app. While locked it can still ask the Keychain for K1 (macOS
  may prompt) and, without a master password, open the vault.
- Without a master password, anyone who can log into the Mac account and open SahilBot (and pass Touch
  ID if it's on) can unlock it.
- Someone who knows the Mac login and the master password.
- A website that is itself compromised, or a malicious browser extension-like script on the right
  site: SahilBot types the value into that site's real field, as the user asked.
- Weak master passwords: the KDF slows guessing, it can't make "password1" safe.
- A forgotten master password together with a lost Keychain item: the vault can't be recovered; keep
  an encrypted backup.
- Shoulder surfing during Reveal, and values the user copies by hand.

## Tests

- `tests/unit/vault-crypto.test.ts`: AES-GCM round trips, flipped bits, wrong AAD, swapped ciphertexts
  and data keys between items, edited sites, rolled-back and re-inserted rows, tampered manifest, master
  password with exponential backoff, Keychain missing, auto-lock, recent-fill masking, export/import.
- `tests/unit/vault-store.test.ts`: migration (verify, idempotent, failure mid-way rolls back, unreadable
  entries, purge, rollback copy), metadata-only listings, redaction, cards, backups through the API, CSV.
- `tests/unit/vault-fill.test.ts`: field and page checks, wrong origin (nothing decrypted), http, hidden
  field, no approval, injected page text, standing rule, locked vault (unlock dialog), IDs with
  re-authentication, card fills.
- `tests/unit/vault-ipc.test.ts`: every vault IPC handler's replies and errors scanned for known secrets;
  Reveal needs authentication and protects the window.
- `tests/accept/vault.test.ts` (hidden Electron): save a login, the agent signs in on the test site by
  reference, no model request contains the password, then lock: the next fill shows the unlock dialog,
  types nothing when cancelled, and goes through after unlocking.
