# Phone access

Use SahilBot from your phone: check on your bots, answer their questions and approvals, and chat with SahilBot
or a bot, with notifications when something needs you. Your phone connects straight to your Mac. There's no
account to make, no cloud service in between, and no telemetry. You don't need a Raspberry Pi or a server; for
that, see [server.md](server.md).

## Set it up (about two minutes)

1. On your Mac: **SahilBot → Settings → General → Phone access**, and turn it on. A QR code and a one-time code
   appear. If macOS asks whether SahilBot may accept incoming connections, choose **Allow**.
2. On your phone (on the same Wi-Fi as the Mac), point the camera at the QR code and open the link.
3. The first time, the browser warns that the connection isn't private. Your Mac made its own certificate, so
   no public authority vouches for it. The pairing page shows the start of the certificate's fingerprint, and
   so does your Mac. They must match. To check what the browser received, open the certificate details on the
   warning page. Then continue to the site.
4. Tap **Pair this phone**. SahilBot opens, with the same bots and chats as on the Mac.

The code works once, for 10 minutes. **Pair a phone** makes a new one.

### Notifications and the Home Screen app

To get notifications and an app icon, your phone has to trust your Mac's certificate first. On the pairing
page, tap **Install SahilBot's certificate**.

- **iPhone and iPad:** allow the download. Then go to Settings → General → VPN & Device Management (or
  "Profile Downloaded") → **Install**. If the certificate is listed in Settings → General → About → Certificate
  Trust Settings, turn it on there. Next, open the link again in Safari, tap Share → **Add to Home Screen**, and open SahilBot
  from the Home Screen. It asks for a pairing code once more, because Home Screen apps keep their own sign-in.
  Finally, in SahilBot on the phone, go to Settings → This phone → **Turn on** under Notifications. iOS only
  shows web notifications for apps opened from the Home Screen.
- **Android:** install the certificate in Settings → Security → Encryption & credentials → Install a
  certificate (the exact menu names vary by phone maker). Then open the link in Chrome, choose ⋮ → **Install app**, and go to
  Settings → This phone → **Turn on**.

The certificate is valid only for your Mac's own addresses. It can't vouch for any other site.

You're notified when:

- a bot or chat **needs you**: an approval, a question, a plan to OK
- a **long task finishes** (a minute or more) or hits a problem
- a bot's routine digest is ready (bots with **Notify me** on)

If you're reading that chat on the Mac at that moment, the phone stays quiet.

## Away from home: Tailscale (recommended)

At home, the phone reaches the Mac over your Wi-Fi. When you're away, use
[Tailscale](https://tailscale.com/download). It's free, and it puts your Mac and your phone on a private network
that only your devices can join. Install it on both and sign in to the same account. SahilBot detects it
(Settings → General → Phone access → Tailscale says **Connected**), and the QR code then uses the Mac's Tailscale
address. One link then works at home and away, so pair through Tailscale if you use it.

You never need to forward ports on your router or open anything to the internet. No relay service is involved.

## What works from the phone

| | Phone | Only on the Mac |
|---|---|---|
| Chat with SahilBot and bots, start tasks, Max mode | ✓ | |
| Answer approvals and questions, Needs you, plans | ✓ | |
| Bots, routines, goals, projects, memory, settings | ✓ | |
| Attach photos and files (from the phone) | ✓ | |
| **Purchases and one-time sign-in codes** | Deny only | Approve |
| **Saved passwords, cards, authenticator codes** (the vault) | never sent to the phone | ✓ |
| Built-in browser panel, Teach a task, computer use | | ✓ (links open in the phone's browser) |
| Voice mode and dictation | use your phone keyboard's dictation | ✓ |
| Connecting apps (the sign-in page opens on the Mac), Mac permissions | | ✓ |

The agent still runs on the Mac, with your permissions and approval rules exactly as set there. A purchase or
a one-time code shows on the phone so you know it's waiting, but you approve it at the Mac. From the phone you
can only say no.

SahilBot needs to be running on the Mac (it can stay hidden in the menu bar) and the Mac needs to be awake. A
closed lid on battery puts it to sleep. For long stretches away, plug it in and turn on "Prevent automatic
sleeping on power adapter when the display is off" in System Settings → Battery → Options.

## Security

- **Off by default.** When it's on, SahilBot listens only on the Mac's home-network address (a private
  192.168.x, 10.x or 172.16–31.x address on Wi-Fi or Ethernet) and its Tailscale address. It never listens on
  a public address or on every interface. A connection from any other address is dropped before anything is
  read, even if a router forwards the port.
- **HTTPS always.** The traffic is encrypted with a certificate made on your Mac (ECDSA P-256). The QR code
  carries the certificate's fingerprint so you can check it on the phone.
- **Pairing.** Each phone pairs once with a one-time code: 10 characters, valid for 10 minutes, used once,
  and stored only as a hash. After 5 wrong codes from one address (or 20 in total) in 15 minutes, pairing waits.
  Ten wrong guesses burn every live code. The page can only pair itself: no other site can use a code it saw.
- **Device tokens.** A paired phone holds a random 256-bit token in an `HttpOnly`, `Secure`,
  `SameSite=Strict` cookie. The Mac stores only a SHA-256 hash of it. The list of paired phones and the
  notification keys are encrypted (AES-256-GCM) with a key kept in your **Keychain**.
- **Remove a phone** under Settings → General → Phone access → Remove. It's signed out at once. A phone can also
  sign itself out (Settings → This phone).
- **What a phone may do** is decided on the Mac (`src/main/phone/policy.ts`). Calls that would act on the
  Mac's screen (its browser panel, file dialogs, microphone, System Settings) or reach the vault are refused.
  Purchases and one-time codes are approved only in the Mac's own window. Every request also has to name the Mac
  in its `Host` header, which blocks DNS rebinding. Every change and the WebSocket must come from the page's
  own origin, with a per-phone CSRF token.
- **Notifications are end-to-end encrypted** (Web Push, RFC 8291) to the phone's own keys. Apple's, Google's
  or Mozilla's push service only relays ciphertext. A notification holds a short, lock-screen-safe line,
  never a command, a password or a card number.
- **Access log.** Settings → General → Phone access → Access log records pairings, failed codes, sign-ins,
  sessions, approvals made from a phone, refused calls and removals. It never contains codes, tokens or what
  you typed.

## Troubleshooting

- **The phone can't open the link.** Make sure it's on the same Wi-Fi as the Mac and not on a guest network
  (those often keep devices apart). If the link uses the Mac's name (`name.local`), tap **Phone can't open
  it? Use the address** on the Mac for a link with its IP address. If macOS asked about incoming connections
  and you chose Deny, allow SahilBot in System Settings → Network → Firewall → Options.
- **"Pair this device first"**: the phone was removed, or its cookie was cleared. Pair again with a new code.
- **No notifications on iPhone:** check that the certificate is trusted (Certificate Trust Settings), that
  SahilBot was opened from the Home Screen, and that notifications are on (Settings → This phone).
- **It worked at home but not away:** use Tailscale (above), and pair the phone through the Tailscale link.
- **The port changed:** SahilBot keeps its port (8788) unless another app took it. Then it uses the next free
  one, and phones need the new link.

## For developers

Phone access is SahilBot Server's front door (`src/server`: `http.ts`, `hub.ts`, `auth.ts`, `push.ts`,
`audit.ts`, `tls.ts`) hosted by the Mac app's main process (`src/main/phone`). The phone runs the Mac's own
renderer with the browser bridge (`src/server/web/bridge.ts`, built to `out/web/bridge.js`), so
`window.foreman` is the same API over a WebSocket. Tests: `tests/unit/phone-access.test.ts` covers pairing,
revoke, binding, policy, notifications, the QR encoder and the layout breakpoints, and
`tests/accept/phone-access.test.ts` runs end to end, hidden. Hidden test runs may set
`SAHILBOT_PHONE_TEST_BIND=127.0.0.1`, `SAHILBOT_PHONE_PORT`, `SAHILBOT_PHONE_PUSH_SINK` and
`SAHILBOT_PHONE_LONG_RUN_MS`. Outside hidden runs these are ignored.
