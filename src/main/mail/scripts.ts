// Mail scripts (JavaScript for Automation). Each is a function `(input) => data`, run by runner.ts
// with its shared helpers (Mail, findBox, findBoxAny, locate, row, boxesOf, accountsFor). They take
// JSON in and give JSON back. None of them ever sends mail except SEND.

export const ACCOUNTS = String.raw`(i) => Mail.accounts().map((a) => {
  const o = { name: a.name() };
  try { o.emails = a.emailAddresses() } catch (e) {}
  try { o.enabled = a.enabled() } catch (e) {}
  try { o.type = String(a.accountType()) } catch (e) {}
  return o;
})`

export const MAILBOXES = String.raw`(i) => {
  const out = [];
  for (const a of accountsFor(i.account)) {
    for (const x of boxesOf(a)) {
      let unread = 0; try { unread = x.box.unreadCount() } catch (e) {}
      out.push({ account: a.name(), path: x.path, unread: unread });
      if (out.length >= 400) return out;
    }
  }
  return out;
}`

/** Mail filters what it can itself (sender, subject, read/flag state, dates); recipients and body text are checked here. */
export const SEARCH = String.raw`(i) => {
  let boxes = [];
  if (i.mailbox) {
    for (const a of accountsFor(i.account)) { const b = findBox(a.name(), i.mailbox); if (b) boxes.push(b) }
    if (!boxes.length) throw new Error('No mailbox named "' + i.mailbox + '"' + (i.account ? ' in ' + i.account : '') + '. List them with action "mailboxes".');
  } else if (i.account) {
    const b = findBox(i.account, 'INBOX'); if (!b) throw new Error('No inbox found for ' + i.account); boxes = [b];
  } else boxes = [Mail.inbox];
  const conds = [];
  if (i.unread) conds.push({ readStatus: false });
  if (i.flagged) conds.push({ flaggedStatus: true });
  if (i.from) conds.push({ sender: { _contains: i.from } });
  if (i.subject) conds.push({ subject: { _contains: i.subject } });
  if (i.since) conds.push({ dateReceived: { _greaterThan: new Date(i.since) } });
  if (i.before) conds.push({ dateReceived: { _lessThan: new Date(i.before) } });
  const cands = [];
  for (const b of boxes) {
    const spec = conds.length === 0 ? b.messages : b.messages.whose(conds.length === 1 ? conds[0] : { _and: conds });
    let dates = [];
    try { dates = spec.dateReceived() } catch (e) { dates = [] }
    if (!dates.length) continue;
    const order = dates.map((d, k) => [k, d ? d.getTime() : 0]).sort((x, y) => y[1] - x[1]).slice(0, i.scan);
    const refs = spec();
    for (const [k, t] of order) cands.push([refs[k], t]);
  }
  cands.sort((x, y) => y[1] - x[1]);
  const to = i.to ? i.to.toLowerCase() : null, text = i.text ? i.text.toLowerCase() : null;
  const out = []; let looked = 0;
  for (const [m] of cands) {
    if (out.length >= i.limit || looked >= i.scan) break;
    looked++;
    try {
      if (to) { const rc = [].concat(m.toRecipients.address(), m.ccRecipients.address()).join(' ').toLowerCase(); if (rc.indexOf(to) < 0) continue }
      if (text) { const hay = (m.subject() + ' ' + (m.content() || '')).toLowerCase(); if (hay.indexOf(text) < 0) continue }
      out.push(row(m, i.snippets));
    } catch (e) { /* a message that vanished mid-search */ }
  }
  return { rows: out, scanned: looked, more: cands.length > looked };
}`

export const READ = String.raw`(i) => {
  const { m } = locate(i.id);
  const r = row(m, false);
  let body = ''; try { body = String(m.content() || '') } catch (e) {}
  r.body = body.slice(0, i.maxChars + 1);
  try { r.to = m.toRecipients.address() } catch (e) { r.to = [] }
  try { r.cc = m.ccRecipients.address() } catch (e) { r.cc = [] }
  try { r.replyTo = m.replyTo() } catch (e) {}
  try { r.messageId = m.messageId() } catch (e) {}
  try { r.headers = String(m.allHeaders() || '').slice(0, 20000) } catch (e) {}
  r.attachments = [];
  try { for (const a of m.mailAttachments()) { const o = { name: a.name() }; try { o.size = a.fileSize() } catch (e) {} r.attachments.push(o) } } catch (e) {}
  if (i.markRead) { try { m.readStatus = true } catch (e) {} }
  return r;
}`

/** From and subject for a list of ids (for organize previews); unknown ids come back as missing. */
export const HEADERS = String.raw`(i) => {
  const out = {}, missing = [];
  for (const id of i.ids) {
    try { const { m } = locate(id); out[id] = { from: m.sender(), subject: m.subject() } } catch (e) { missing.push(id) }
  }
  return { headers: out, missing: missing };
}`

/** Applies changes one message at a time; every op reports ok or its error. Delete moves to the account's Trash. */
export const APPLY = String.raw`(i) => {
  const ARCHIVE = ['Archive', 'Archives', '[Gmail]/All Mail', '[Google Mail]/All Mail', 'All Mail'];
  const TRASH = ['Trash', 'Deleted Messages', 'Deleted Items', '[Gmail]/Trash', '[Google Mail]/Trash', '[Gmail]/Bin', '[Google Mail]/Bin', 'Bin'];
  const results = [];
  for (const op of i.ops) {
    try {
      const { m, account } = locate(op.id);
      if (op.action === 'flag') m.flaggedStatus = true;
      else if (op.action === 'unflag') m.flaggedStatus = false;
      else if (op.action === 'mark_read') m.readStatus = true;
      else if (op.action === 'mark_unread') m.readStatus = false;
      else {
        const dest = op.action === 'move' ? findBox(account, op.target) : findBoxAny(account, op.action === 'archive' ? ARCHIVE : TRASH);
        if (!dest) {
          if (op.action === 'delete') { Mail.delete(m) }
          else throw new Error(op.action === 'move' ? 'no mailbox "' + op.target + '" in ' + account : 'no Archive mailbox in ' + account + ' (move it to a mailbox instead)');
        } else {
          try { Mail.move(m, { to: dest }) } catch (e) { m.mailbox = dest }
        }
      }
      results.push({ id: op.id, ok: true });
    } catch (e) { results.push({ id: op.id, ok: false, error: String(e && e.message || e).slice(0, 160) }) }
  }
  return results;
}`

/** Opens a compose window and leaves it as a draft. Never sends. */
export const DRAFT = String.raw`(i) => {
  let msg;
  if (i.replyTo) {
    const { m } = locate(i.replyTo);
    msg = Mail.reply(m, { openingWindow: true, replyToAll: !!i.all });
    if (i.content) msg.content = i.content;
  } else {
    msg = Mail.OutgoingMessage({ subject: i.subject || '', content: i.content || '', visible: true });
    Mail.outgoingMessages.push(msg);
  }
  for (const a of (i.to || [])) msg.toRecipients.push(Mail.ToRecipient({ address: a }));
  for (const a of (i.cc || [])) msg.ccRecipients.push(Mail.CcRecipient({ address: a }));
  if (i.subject && i.replyTo) { try { msg.subject = i.subject } catch (e) {} }
  let saved = false;
  try { msg.save(); saved = true } catch (e) {}
  try { Mail.activate() } catch (e) {}
  return { saved: saved };
}`

/** Sends an email (only after the user approved this exact message). */
export const SEND = String.raw`(i) => {
  let msg;
  if (i.replyTo) {
    const { m } = locate(i.replyTo);
    msg = Mail.reply(m, { openingWindow: false, replyToAll: !!i.all });
    msg.content = i.content;
  } else {
    msg = Mail.OutgoingMessage({ subject: i.subject || '', content: i.content || '', visible: false });
    Mail.outgoingMessages.push(msg);
  }
  for (const a of (i.to || [])) msg.toRecipients.push(Mail.ToRecipient({ address: a }));
  for (const a of (i.cc || [])) msg.ccRecipients.push(Mail.CcRecipient({ address: a }));
  for (const a of (i.bcc || [])) msg.bccRecipients.push(Mail.BccRecipient({ address: a }));
  if (i.subject && i.replyTo) { try { msg.subject = i.subject } catch (e) {} }
  const ok = msg.send();
  return { sent: ok !== false };
}`
