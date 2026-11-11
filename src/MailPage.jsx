import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, ArrowDownAZ, ArrowDownUp, ArrowLeft, Bold, CheckCircle2, ChevronDown,
  Code, Copy, CornerUpLeft, Download, FileText, Filter, Inbox, Info, Italic, Link2,
  List, ListOrdered, Loader2, Lock, Mail, MailOpen, Paperclip, Pin, PinOff,
  RefreshCw, Search, Send, Settings, ShieldAlert, ShieldCheck, Smile, Trash2,
  Type, UserPlus, Users, X,
} from 'lucide-react';
import ExplorerReference from './ExplorerReference.jsx';
import {
  searchMessages, sortMessages, groupByDay, groupThreads, formatDayLabel, formatRowTime,
} from './mail-search.js';
import './MailPage.css';
import { renderMailBody, isSafeLinkUrl, normalizeLinkUrl } from './mail-format.js';
import { mailBodyToHtml } from './mail-format.js';
import { htmlToMailBody, rangeFromOffsets, globalOffsetsFromRange } from './mail-compose.js';

const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 8000;
const SERVICE_FEE_SATS = 1000;
// The recipient anchor, paid to the recipient's own address so the message
// shows up in their address history. The user can raise it in the compose
// window so the recipient holds enough BSV to reply.
// const RECIPIENT_ANCHOR_SATS = 3;
// The WHOLE mail - body plus every attachment - must stay under 50 MB. There
// is no separate per-file ceiling and no cap on the number of files, because
// the constraint that matters is the size of the email, not how many files are
// in it.
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;
// The default RECIPIENT PAYMENT. It is the anchor that makes the message
// discoverable in the recipient's address history. The sender can raise it so
// the recipient holds enough BSV to answer.
const DEFAULT_ANCHOR_SATS = 3;
// The floor and the ceiling the main process enforces on that payment.
const MIN_ANCHOR_SATS = 3;
const MAX_ANCHOR_SATS = 10000000;

// A draft id is a 32-byte random hex id, the same shape as a message id.
function randomDraftId() {
  const bytes = new Uint8Array(32);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

// Converts an ArrayBuffer to base64 without blowing the call stack on large
// files (a naive loop over bytes with btoa does).
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

// Same formatting as formatBytes, but without the trailing ".0" on whole
// units - used for the limit text.
function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${value / (1024 * 1024)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(value % 1024 ? 1 : 0)} KB`;
  return `${value} bytes`;
}

const shortAddress = address => address ? `${address.slice(0, 8)}…${address.slice(-6)}` : 'Unknown wallet';

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function formatFullTimestamp(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return 'Unknown time';
  return date.toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function statusLabel(status) {
  if (status === 'confirmed') return 'Confirmed';
  if (status === 'undecryptable') return 'Cannot decrypt';
  return 'Pending';
}

function keyFingerprint(publicKeyHex) {
  if (typeof publicKeyHex !== 'string' || publicKeyHex.length < 16) return '—';
  return `${publicKeyHex.slice(0, 8)}…${publicKeyHex.slice(-8)}`;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Contact card
// ---------------------------------------------------------------------------

function ContactCard({ contact, onRemove, onToggleTrust, disabled }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await window.lbsx.copyText(contact.publicKeyHex);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  const trusted = contact.trusted === true;
  return <div className="ml-contact-row">
    <div className="ml-contact-avatar">{trusted
      ? <ShieldCheck size={15} className="ml-contact-avatar-trusted" />
      : (contact.label || contact.address).slice(0, 1).toUpperCase()}</div>
    <div className="ml-contact-main">
      <b>
        {contact.label || shortAddress(contact.address)}
        {trusted && <ShieldCheck size={12} className="ml-verified-badge" aria-label="Trusted contact" />}
      </b>
      <span className="ml-contact-address">{contact.address}</span>
      <button type="button" className="ml-key-fingerprint" onClick={copy} title="Copy public key">
        <Lock size={11} /> key {keyFingerprint(contact.publicKeyHex)}
        {copied ? <CheckCircle2 size={11} className="ml-copied" /> : <Copy size={11} />}
      </button>
    </div>
    <button
      type="button"
      className={`ml-icon-button ml-trust-button ${trusted ? 'active' : ''}`}
      onClick={() => onToggleTrust(contact)}
      disabled={disabled}
      title={trusted
        ? 'Remove the trusted mark from this contact'
        : 'Trust this contact — you have confirmed their identity'}
      aria-label={trusted ? 'Untrust contact' : 'Trust contact'}
      aria-pressed={trusted}
    >
      <ShieldCheck size={14} />
    </button>
    <button type="button" className="ml-icon-button ml-danger" onClick={() => onRemove(contact.address)} disabled={disabled} title="Remove contact" aria-label="Remove contact">
      <Trash2 size={14} />
    </button>
  </div>;
}

// ---------------------------------------------------------------------------
// Compose panel
// ---------------------------------------------------------------------------

function ComposePanel({ contacts, ownCard, onSend, onSaveDraft, sending, onCancel, initialRecipient, initialPublicKeyHex, initialSubject, initialBody, initialThreadRootId, initialDraftId, initialAttachments }) {
  const [recipient, setRecipient] = useState(initialRecipient || '');
  const [subject, setSubject] = useState(initialSubject || '');
  const [body, setBody] = useState(initialBody || '');
  const [publicKeyHex, setPublicKeyHex] = useState(initialPublicKeyHex || '');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [attachments, setAttachments] = useState(initialAttachments || []);
  // The RECIPIENT PAYMENT. It is dynamic: the default 3 sats is the anchor
  // that makes the message discoverable in the recipient's address history,
  // but the sender can pay more so the recipient holds enough BSV to answer -
  // their own service fee, their network fee and the anchor for their reply.
  const [anchorSats, setAnchorSats] = useState(DEFAULT_ANCHOR_SATS);
  // The live cost estimate. It is asked of the MAIN process so the number
  // shown is the same arithmetic the send path uses.
  const [cost, setCost] = useState(null);
  // The thread this mail belongs to. A reply keeps the thread it continues.
  const threadRootId = initialThreadRootId || '';
  // The draft id, so saving again updates the SAME draft instead of making a
  // second one.
  //
  // It must be STABLE for the life of this panel. Generating a fresh id on
  // every click of "Save as draft" creates a new draft each time, which is
  // how two copies of the same draft end up in the list. When the panel is
  // opened from an existing draft the id comes with it; otherwise one is
  // minted once, here, and reused for every save.
  const [draftId] = useState(() => initialDraftId || randomDraftId());

  const selected = contacts.find(contact => contact.address === recipient) || null;
  const knownContact = Boolean(selected);

  // The attachment bytes, which drive the network fee.
  const attachmentBytes = attachments.reduce((sum, item) => sum + (item.byteLength || 0), 0);

  // The LIVE COST ESTIMATE. It is asked of the main process so the number
  // shown here is the SAME arithmetic the send path uses - the estimate can
  // never drift from what is actually charged.
  useEffect(() => {
    let active = true;
    window.lbsx.estimateMailCost({ anchorSats, attachmentBytes })
      .then(result => { if (active) setCost(result); })
      .catch(() => { if (active) setCost(null); });
    return () => { active = false; };
  }, [anchorSats, attachmentBytes]);

  const pickContact = contact => {
    setRecipient(contact.address);
    setPublicKeyHex(contact.publicKeyHex);
    setError('');
  };

  const copyOwnCard = async () => {
    try {
      await window.lbsx.copyText(JSON.stringify(ownCard, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  // Attachments are read here in the renderer and handed to the main process
  // as base64. They are encrypted before anything is broadcast.
  //
  // The budget is on the WHOLE mail: the body plus every attachment must
  // stay under 50 MB. There is no separate per-file limit and no cap on how
  // many files may be attached.
  const addAttachments = async event => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    setError('');
    const next = [...attachments];
    let total = next.reduce((sum, item) => sum + (item.byteLength || 0), 0);
    for (const file of files) {
      if (!file.size) continue;
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(`"${file.name}" is larger than ${formatSize(MAX_ATTACHMENT_BYTES)}.`);
        continue;
      }
      if (total + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
        setError(`The mail and its attachments together must stay under ${formatSize(MAX_TOTAL_ATTACHMENT_BYTES)}.`);
        break;
      }
      const buffer = await file.arrayBuffer();
      next.push({
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        byteLength: file.size,
        dataBase64: bufferToBase64(buffer),
      });
      total += file.size;
    }
    setAttachments(next);
  };

  const removeAttachment = index => {
    setAttachments(attachments.filter((_, position) => position !== index));
  };

  const submit = async () => {
    setError('');
    if (!recipient) { setError('Choose a recipient before sending.'); return; }
    // The RECIPIENT KEY is resolved from the SELECTED CONTACT, not only from
    // the separately-held state.
    //
    // The key input renders `selected.publicKeyHex` when a contact is chosen,
    // so the field can look perfectly correct while the held state is empty -
    // which is exactly what happened when the contact list was still loading
    // and the dropdown was used before it arrived. Resolving the key at send
    // time means the key that is SHOWN is the key that is USED.
    const resolvedKey = (selected?.publicKeyHex || publicKeyHex || '').trim().toLowerCase();
    if (!resolvedKey) { setError('The recipient public key is required to encrypt this mail.'); return; }
    if (!body.trim() && !attachments.length) { setError('Write a message before sending.'); return; }
    try {
      await onSend({
        recipient,
        recipientPublicKeyHex: resolvedKey,
        subject,
        body,
        // The thread this mail continues. A new mail starts its own thread.
        threadRootId: threadRootId || undefined,
        // The RECIPIENT PAYMENT, so the recipient holds enough BSV to answer.
        anchorSats,
        attachments: attachments.map(({ fileName, mimeType, dataBase64 }) => ({
          fileName, mimeType, dataBase64,
        })),
      });
      setSubject('');
      setBody('');
      setAttachments([]);
    } catch (sendError) {
      setError(sendError.message || 'The mail could not be sent.');
    }
  };

  // Saves the message as a LOCAL draft. Nothing is broadcast and nothing is
  // written to the chain - the draft lives in the encrypted wallet data on
  // this device.
  const saveDraft = async () => {
    setError('');
    if (!recipient) { setError('Choose a recipient before saving a draft.'); return; }
    if (!body.trim() && !attachments.length) { setError('Write a message before saving a draft.'); return; }
    await onSaveDraft({
      // The SAME id every time, so saving again updates this draft instead of
      // creating a second copy of it.
      draftId,
      recipient,
      recipientPublicKeyHex: publicKeyHex,
      subject,
      body,
      attachments: attachments.map(({ fileName, mimeType, byteLength, dataBase64 }) => ({
        fileName, mimeType, byteLength, dataBase64,
      })),
      threadRootId,
    });
  };

  const byteLength = new TextEncoder().encode(body).length;
  const overLimit = byteLength > MAX_BODY_LENGTH;

  // The editor toolbar. These insert plain-text markers around the selection
  // - the mail body is rendered as text, not HTML, so the markers are the
  // honest way to express emphasis in a message that must survive being
  // encrypted, stored on chain and read by someone else's wallet.
  //
  // The EDITOR is a contenteditable region that shows the result of those
  // markers as real formatting. The state is still the marker text; the
  // editor is only a view of it.
  const editorRef = useRef(null);
  const [emojiOpen, setEmojiOpen] = useState(false);

  // The LINK DIALOG. The text to display and the web address, applied as one
  // action - the same shape as Gmail's link popup.
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkText, setLinkText] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [linkError, setLinkError] = useState('');
  // The link the user CLICKED in the editor, and the element it is. The
  // little bar under the editor lets them change the address or remove the
  // link - the same thing Gmail does when a link in a draft is clicked.
  const [activeLink, setActiveLink] = useState(null);
  const activeLinkRef = useRef(null);
  // The selection the link will replace, captured when the dialog opened.
  const linkSelection = useRef(null);
  // The live range, used when the editor's markup has NOT been re-rendered.
  const linkRange = useRef(null);

  // The CARET, kept across the toolbar clicks.
  //
  // Clicking a toolbar button takes the focus away from the editor, and the
  // browser then forgets where the caret was. The emoji was being inserted
  // at the very start of the message because of this. The selection is
  // saved when the editor loses focus and restored when it is needed again.
  const savedRange = useRef(null);

  // Keeps the editor's markup in step with the marker text.
  //
  // The editor is rendered FROM the text, and the text is read back FROM the
  // editor. Writing the markup back on every change would move the caret and
  // fight the user, so the markup is only rewritten when the text has
  // changed for a reason OTHER than the user's typing - which is exactly
  // when a format button has been used.
  // Writes the current text into the editor as formatted markup.
  //
  // The markup is written to the element DIRECTLY rather than through
  // `dangerouslySetInnerHTML`. React's escape hatch is an HTML injection
  // surface, and the body of a mail is attacker-controlled text - so it is
  // never handed to React as markup. The html is built from the escaped text
  // by `mailBodyToHtml`, and it is written here instead.
  const syncEditor = useCallback(text => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.innerHTML = mailBodyToHtml(text);
  }, []);

  // The text that was last read FROM the editor.
  //
  // The editor is the source of truth while the user is typing in it, so the
  // markup is only rewritten when the text changes from somewhere ELSE - a
  // reply that quotes the previous message, a draft that was opened, or the
  // body being cleared after a send.
  //
  // Without this the editor was rewritten on every keystroke, which reset the
  // caret to the start and made every word come out backwards: "hello" was
  // typed as "olleh", because each letter was inserted at position zero.
  // It starts as null so the first effect run fills the editor - otherwise
  // the editor would be empty even though the message has a body, which is
  // what a reply that quotes the previous message or an opened draft does.
  const editorText = useRef(null);

  // Takes the text out of the editor and into the state, and records that the
  // text came FROM the editor so it is not written back into it.
  const takeTextFromEditor = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return null;
    const text = htmlToMailBody(editor);
    editorText.current = text;
    setBody(text);
    return text;
  }, []);

  // Reads the editor's content back into the marker text.
  const handleEditorInput = useCallback(() => {
    takeTextFromEditor();
  }, [takeTextFromEditor]);

  // Remembers where the caret is.
  //
  // Clicking a toolbar button takes the focus out of the editor, and the
  // browser then forgets the selection. The emoji was being inserted at the
  // very start of the message because of this.
  const handleEditorBlur = useCallback(() => {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && editorRef.current?.contains(selection.anchorNode)) {
      savedRange.current = selection.getRangeAt(0).cloneRange();
    }
  }, []);

  // The editor's markup follows the text when the text changes from
  // OUTSIDE the editor.
  useEffect(() => {
    if (body === editorText.current) return;
    editorText.current = body;
    syncEditor(body);
  }, [body, syncEditor]);

  // Runs a DOCUMENT COMMAND on the editor, which is how the browser's own
  // bold, italic and list actions work. The command changes the markup, and
  // the markup is then read back into the marker text.
  const runCommand = (command, value = null) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    document.execCommand(command, false, value);
    takeTextFromEditor();
  };

  // Applies a format to the selection, or to the whole message when nothing
  // is selected.
  //
  // With a selection, the browser's own command is used, so the formatting is
  // exactly what the user highlighted. With no selection the command is
  // applied to the whole message, which is how a mail client behaves when you
  // hit bold with nothing highlighted.
  const formatSelection = (command, value = null) => {
    const editor = editorRef.current;
    if (!editor) return;
    const selection = window.getSelection();
    const hasSelection = selection && !selection.isCollapsed
      && editor.contains(selection.anchorNode);
    if (hasSelection) {
      runCommand(command, value);
      return;
    }
    // No selection: apply to the whole message.
    const whole = editorRef.current;
    const range = document.createRange();
    range.selectNodeContents(whole);
    const saved = window.getSelection().getRangeAt(0);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    runCommand(command, value);
    // Put the caret back where it was.
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(saved);
  };

  // The list commands. `insertUnorderedList` and `insertOrderedList` are the
  // browser's own, and they number the items correctly.
  const formatList = ordered => formatSelection(ordered ? 'insertOrderedList' : 'insertUnorderedList');

  // Wraps the selection in an INLINE element - used for the code style.
  //
  // The browser has no command for an inline code span, so the element is
  // built by hand around the selected text. With no selection the whole
  // message is wrapped, which is what the other buttons do too.
  const formatInline = (tagName) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const selection = window.getSelection();
    const hasSelection = selection && !selection.isCollapsed
      && editor.contains(selection.anchorNode);
    const range = hasSelection
      ? selection.getRangeAt(0)
      : (() => { const whole = document.createRange(); whole.selectNodeContents(editor); return whole; })();
    const text = range.toString();
    if (!text) return;
    // The text is split on the line breaks and EACH LINE is wrapped on its
    // own. A code span cannot cross a line - the renderer matches a code
    // span within one line, so a span that covered two lines never matched
    // and left the message showing raw backticks.
    const wrapper = document.createElement(tagName);
    if (text.includes('\n')) {
      // A multi-line selection is wrapped line by line, with the line
      // breaks kept between the wrappers.
      const parts = text.split('\n');
      wrapper.appendChild(document.createTextNode(parts[0]));
      for (let index = 1; index < parts.length; index += 1) {
        wrapper.appendChild(document.createElement('br'));
        const line = document.createElement(tagName);
        line.textContent = parts[index];
        wrapper.appendChild(line);
      }
    } else {
      wrapper.textContent = text;
    }
    range.deleteContents();
    range.insertNode(wrapper);
    // The caret goes after the new element.
    const after = document.createRange();
    after.setStartAfter(wrapper);
    after.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(after);
    takeTextFromEditor();
  };

  // Inserts a link around the selection, or at the caret.
  //
  // The link is made by hand rather than by the browser's `createLink`,
  // because the browser's command puts the whole URL in and the user needs
  // to be able to TYPE the rest of it.
  //
  // The DIALOG is the Gmail pattern: the user is asked for the text to
  // display and the web address, and the link is only made when they apply
  // it. A link button that silently drops a half-typed url into the message
  // is not usable - the user cannot see or correct the address.
  const openLinkDialog = () => {
    const editor = editorRef.current;
    if (!editor) return;
    // The CHARACTER OFFSETS of the selection are captured, not the range
    // itself.
    //
    // Clicking the toolbar button takes the focus out of the editor and the
    // browser forgets the selection - but a saved DOM RANGE is not enough
    // either, because the editor's markup is re-rendered and the range's
    // boundary nodes are detached by the time the user clicks Apply. The
    // link was then inserted at the end of the message instead of replacing
    // the selected text. The offsets survive a re-render.
    const selection = window.getSelection();
    const hasSelection = selection && !selection.isCollapsed
      && editor.contains(selection.anchorNode);
    // The SAVED range is the fallback: clicking the toolbar button can move
    // the focus out of the editor, and the browser then reports no selection
    // even though the user had selected something.
    const saved = savedRange.current;
    const hasSaved = saved && editor.contains(saved.startContainer);
    const range = hasSelection ? selection.getRangeAt(0) : (hasSaved ? saved : null);
    if (range) {
      // The range is kept for the case where the markup has NOT been
      // re-rendered, and the global offsets are kept for the case where it
      // has - the range's boundary nodes are detached after a re-render.
      linkRange.current = range.cloneRange();
      linkSelection.current = globalOffsetsFromRange(editor, range);
    }
    if (!linkSelection.current) {
      linkSelection.current = { start: 0, end: 0, text: '' };
    }
    // The selected text is the DEFAULT display text, which is what the user
    // almost always wants.
    setLinkText(range ? range.toString() : (linkSelection.current?.text || ''));
    setLinkUrl('');
    setLinkOpen(true);
    setLinkError('');
  };

  // A CLICK in the editor. When the click lands on a link, the link bar
  // appears under the editor with the address, so the user can change it or
  // remove the link.
  const handleEditorClick = useCallback(event => {
    const editor = editorRef.current;
    if (!editor) return;
    const anchor = event.target?.closest?.('a');
    if (!anchor || !editor.contains(anchor)) {
      setActiveLink(null);
      return;
    }
    // A link is not followed while the message is being written - the user
    // is editing it, not reading it.
    event.preventDefault();
    activeLinkRef.current = anchor;
    setActiveLink({
      href: anchor.getAttribute('href') || '',
      text: anchor.textContent || '',
    });
  }, []);

  // Changes the address of the link the user clicked.
  const changeActiveLink = () => {
    const anchor = activeLinkRef.current;
    if (!anchor) return;
    setLinkText(activeLink?.text || '');
    setLinkUrl(activeLink?.href || '');
    setLinkError('');
    setLinkOpen(true);
  };

  // Removes the link the user clicked, keeping the text.
  const removeActiveLink = () => {
    const anchor = activeLinkRef.current;
    const editor = editorRef.current;
    if (!anchor || !editor) return;
    // The link is replaced by its own text, so the words stay and only the
    // link goes.
    const text = document.createTextNode(anchor.textContent || '');
    anchor.parentNode.replaceChild(text, anchor);
    activeLinkRef.current = null;
    setActiveLink(null);
    takeTextFromEditor();
  };

  // Applies the link dialog.
  const applyLink = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const label = linkText.trim();
    const url = linkUrl.trim();
    if (!label) { setLinkError('Give the link some text.'); return; }
    if (!url) { setLinkError('Give the link an address.'); return; }
    // The URL is normalised and its SCHEME is checked. Only http and https
    // are allowed - a `javascript:` or `file:` url is refused here rather
    // than being written into the message.
    const href = normalizeLinkUrl(url);
    if (!href) { setLinkError('That address is not a web address.'); return; }
    editor.focus();

    // CHANGING a link that was clicked. The address and the display text of
    // the existing link are updated in place, rather than a second link
    // being inserted next to it.
    const existing = activeLinkRef.current;
    if (existing && editor.contains(existing)) {
      existing.setAttribute('href', href);
      existing.textContent = label;
      activeLinkRef.current = null;
      setActiveLink(null);
      takeTextFromEditor();
      setLinkOpen(false);
      setLinkError('');
      return;
    }

    // The text that was selected when the dialog opened is replaced by the
    // link; if nothing was selected, the link is inserted at the caret.
    // The range is taken from the live selection when there is one, from the
    // range saved when the dialog opened when the markup has NOT been
    // re-rendered, and from the saved OFFSETS when it has - the range's
    // boundary nodes are detached after a re-render, but the offsets are not.
    let range = null;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && editor.contains(selection.anchorNode)) {
      range = selection.getRangeAt(0);
    } else if (linkRange.current && editor.contains(linkRange.current.startContainer)) {
      range = linkRange.current;
    } else {
      range = rangeFromOffsets(editor, linkSelection.current);
    }
    const anchor = document.createElement('a');
    anchor.setAttribute('href', href);
    anchor.textContent = label;
    range.deleteContents();
    range.insertNode(anchor);
    // The caret goes after the link, so the user can keep typing.
    const after = document.createRange();
    after.setStartAfter(anchor);
    after.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(after);
    takeTextFromEditor();
    linkSelection.current = null;
    setLinkOpen(false);
    setLinkError('');
  };

  // Inserts text at the caret. The emoji picker uses this.
  //
  // The caret has to be put back first: clicking the emoji button moves the
  // focus out of the editor, so the selection is saved when the editor
  // loses focus and restored here.
  const insertAtCursor = (text) => {
    const editor = editorRef.current;
    if (!editor) { setBody(`${body}${text}`); return; }
    editor.focus();
    const selection = window.getSelection();
    if (savedRange.current) {
      selection.removeAllRanges();
      selection.addRange(savedRange.current);
    }
    document.execCommand('insertText', false, text);
    takeTextFromEditor();
  };

  const EMOJI = ['😀', '👍', '🎉', '🔥', '✅', '🙏', '💪', '🚀', '❤️', '😄', '🤝', '⭐'];

  return <div className="ml-compose">
    <div className="ml-compose-titlebar">
      <h2><Send size={15} /> New message</h2>
      <div className="ml-compose-titlebar-actions">
        <button type="button" className="ml-icon-button" onClick={onCancel} title="Close" aria-label="Close compose"><X size={15} /></button>
      </div>
    </div>

    <div className="ml-compose-rows">
      <div className="ml-compose-row">
        <span className="ml-compose-row-label">To</span>
        {contacts.length === 0 && !initialRecipient ? <span className="ml-compose-empty">Add a contact first — you need their public key to encrypt mail to them.</span> : (
          <select className="ml-compose-input" value={recipient} onChange={event => {
            const contact = contacts.find(row => row.address === event.target.value);
            if (contact) pickContact(contact);
            else {
              // An address that is NOT a saved contact - the user typed one in.
              // The key is cleared because there is no key for it yet, but it
              // is cleared to EMPTY and not to a stale one, and the key field
              // becomes editable so the user can paste the key.
              setRecipient(event.target.value);
              setPublicKeyHex('');
            }
          }}>
            <option value="">Choose a contact…</option>
            {contacts.map(contact => <option key={contact.address} value={contact.address}>
              {contact.label ? `${contact.label} — ${shortAddress(contact.address)}` : shortAddress(contact.address)}
            </option>)}
            {initialRecipient && !contacts.some(contact => contact.address === initialRecipient) && (
              <option value={initialRecipient}>{shortAddress(initialRecipient)}</option>
            )}
          </select>
        )}
      </div>

      {(selected || publicKeyHex) && <div className="ml-compose-row ml-compose-row-key">
        <span className="ml-compose-row-label">Key</span>
        <input
          type="text"
          className="ml-compose-input ml-readonly"
          value={selected ? selected.publicKeyHex : publicKeyHex}
          readOnly={knownContact}
          onChange={event => setPublicKeyHex(event.target.value.trim().toLowerCase())}
        />
      </div>}

      <div className="ml-compose-row">
        <span className="ml-compose-row-label">Subject</span>
        <input
          type="text"
          className="ml-compose-input"
          value={subject}
          maxLength={MAX_SUBJECT_LENGTH}
          placeholder="What is this about?"
          onChange={event => setSubject(event.target.value)}
        />
      </div>
    </div>

    {/* The EDITOR.
        It is a contenteditable region, not a textarea, so the message is shown
        the way the reader will see it - real bold, real italics, real lists -
        instead of the raw `**` and `-` markers that travel inside the
        encrypted envelope.

        The state is still the marker TEXT. The editor is only a view of it:
        the markup is generated from the text, and every keystroke is turned
        back into the marker text. What is sent is exactly what was always
        sent, and the reader renders it exactly as before. */}
    <div className="ml-compose-editor">
      <div
        ref={editorRef}
        className={`ml-compose-rich${overLimit ? ' ml-over-limit' : ''}`}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Message body"
        data-placeholder="Write your encrypted message…"
        onInput={handleEditorInput}
        onBlur={handleEditorBlur}
        onKeyUp={handleEditorBlur}
        onMouseUp={handleEditorBlur}
        onClick={handleEditorClick}
      />

      {/* The LINK BAR. It appears when a link in the message is clicked, and
          it lets the user change the address or remove the link - the same
          thing Gmail does when a link in a draft is clicked. */}
      {activeLink && <div className="ml-link-bar">
        <span className="ml-link-bar-label">Go to link:</span>
        <a
          className="ml-link-bar-url"
          href={isSafeLinkUrl(activeLink.href) ? activeLink.href : undefined}
          target="_blank"
          rel="noreferrer"
          onClick={event => event.preventDefault()}
        >
          {activeLink.href}
        </a>
        <button type="button" className="ml-link-bar-action" onClick={changeActiveLink}>Change</button>
        <span className="ml-link-bar-sep">|</span>
        <button type="button" className="ml-link-bar-action" onClick={removeActiveLink}>Remove</button>
      </div>}
    </div>

    {attachments.length > 0 && <ul className="ml-attach-list ml-compose-attachments">
      {attachments.map((attachment, index) => (
        <li key={`${attachment.fileName}-${index}`}>
          <FileText size={13} />
          <span className="ml-attach-name">{attachment.fileName}</span>
          <span className="ml-attach-size">{formatBytes(attachment.byteLength)}</span>
          <button type="button" onClick={() => removeAttachment(index)} title="Remove">
            <X size={13} />
          </button>
        </li>
      ))}
    </ul>}

    <div className="ml-compose-toolbar">
      <button type="button" className="ml-primary-button ml-compose-send" onClick={submit} disabled={sending || overLimit || (!body.trim() && !attachments.length)}>
        {sending ? <><Loader2 size={14} className="spin" /> Encrypting…</> : <><Lock size={14} /> Encrypt &amp; send</>}
      </button>

      <div className="ml-compose-tools">
        <button type="button" className="ml-tool-button" title="Bold" onClick={() => formatSelection('bold')}><Bold size={15} /></button>
        <button type="button" className="ml-tool-button" title="Italic" onClick={() => formatSelection('italic')}><Italic size={15} /></button>
        <button type="button" className="ml-tool-button" title="Bulleted list" onClick={() => formatList(false)}><List size={15} /></button>
        <button type="button" className="ml-tool-button" title="Numbered list" onClick={() => formatList(true)}><ListOrdered size={15} /></button>
        <button type="button" className="ml-tool-button" title="Code" onClick={() => formatInline('code')}><Code size={15} /></button>
        <button type="button" className="ml-tool-button" title="Insert link" onClick={() => openLinkDialog()}>
          <Link2 size={15} />
        </button>
        <button type="button" className="ml-tool-button" title="Emoji" onClick={() => setEmojiOpen(!emojiOpen)}>
          <Smile size={15} />
        </button>
        <label className="ml-tool-button ml-attach-picker" title="Attach files">
          <Paperclip size={15} />
          <input
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,application/pdf,text/plain,text/csv,application/json,text/html,text/markdown"
            onChange={addAttachments}
          />
        </label>
        {emojiOpen && <div className="ml-emoji-pop">
          {EMOJI.map(emoji => <button type="button" key={emoji} onClick={() => { insertAtCursor(emoji); setEmojiOpen(false); }}>{emoji}</button>)}
        </div>}

        {/* The LINK DIALOG. The text to display and the web address, applied
            as one action - the same shape as Gmail's link popup, and the
            only way the user can see and correct the address before it goes
            into the message. */}
        {linkOpen && <div className="ml-link-pop">
          <label className="ml-link-row">
            <span>Text to display</span>
            <input
              type="text"
              value={linkText}
              placeholder="link text"
              autoFocus
              onChange={event => { setLinkText(event.target.value); setLinkError(''); }}
              onKeyDown={event => {
                if (event.key === 'Enter') { event.preventDefault(); applyLink(); }
                if (event.key === 'Escape') { event.preventDefault(); setLinkOpen(false); }
              }}
            />
          </label>
          <label className="ml-link-row">
            <span>Web address</span>
            <input
              type="text"
              value={linkUrl}
              placeholder="https://"
              onChange={event => { setLinkUrl(event.target.value); setLinkError(''); }}
              onKeyDown={event => {
                if (event.key === 'Enter') { event.preventDefault(); applyLink(); }
                if (event.key === 'Escape') { event.preventDefault(); setLinkOpen(false); }
              }}
            />
          </label>
          {linkError && <p className="ml-link-error">{linkError}</p>}
          <div className="ml-link-actions">
            <button type="button" className="ml-link-apply" onClick={applyLink}>Apply</button>
            <button type="button" className="ml-link-cancel" onClick={() => { setLinkOpen(false); setLinkError(''); }}>Cancel</button>
          </div>
        </div>}
      </div>

      <div className="ml-compose-tools-right">
        <span className={`ml-compose-count ${overLimit ? 'ml-hint-warn' : ''}`}>
          {byteLength.toLocaleString()} / {MAX_BODY_LENGTH.toLocaleString()}
        </span>
        <button type="button" className="ml-tool-button ml-tool-button-wide" title="Save as draft" onClick={saveDraft} disabled={sending}>
          <FileText size={14} /> <span>Save as draft</span>
        </button>
        <button type="button" className="ml-tool-button" title="Discard" onClick={onCancel} disabled={sending}>
          <Trash2 size={15} />
        </button>
      </div>
    </div>

    {/* The COST. The recipient payment is adjustable - pay more so the
        recipient holds enough BSV to answer - and the total is the live
        estimate from the main process, with every fee broken out. */}
    <div className="ml-cost">
      <div className="ml-cost-row">
        <label className="ml-cost-anchor">
          <span>To recipient</span>
          <input
            type="number"
            min={MIN_ANCHOR_SATS}
            max={MAX_ANCHOR_SATS}
            step="1"
            value={anchorSats}
            onChange={event => {
              const next = Number(event.target.value);
              setAnchorSats(Number.isFinite(next) ? Math.max(MIN_ANCHOR_SATS, Math.min(MAX_ANCHOR_SATS, Math.floor(next))) : MIN_ANCHOR_SATS);
            }}
          />
          <em>sats</em>
        </label>
        <div className="ml-cost-breakdown">
          <span><b>{anchorSats.toLocaleString()}</b> to recipient</span>
          <span><b>{SERVICE_FEE_SATS.toLocaleString()}</b> service fee</span>
          <span><b>{(cost?.networkFeeSats ?? 0).toLocaleString()}</b> network</span>
          <span className="ml-cost-total">
            Total <b>{(cost?.totalSats ?? 0).toLocaleString()}</b> sats
          </span>
        </div>
      </div>
      <p className="ml-cost-hint">
        Paying more than the 3 sat anchor leaves the recipient with BSV to cover their own
        service fee, network fee and the anchor for their reply.
      </p>
    </div>

    {error && <div className="ml-error"><AlertCircle size={14} /> {error}</div>}

    {ownCard && <div className="ml-own-card">
      <span>Your key — share it so others can mail you</span>
      <button type="button" onClick={copyOwnCard} title="Copy your contact card">
        <code>{shortAddress(ownCard.address)}</code> key {keyFingerprint(ownCard.publicKeyHex)}
        {copied ? <CheckCircle2 size={12} className="ml-copied" /> : <Copy size={12} />}
      </button>
    </div>}
  </div>;
}

// ---------------------------------------------------------------------------
// Mail row - Gmail style: sender | subject + snippet | date
// ---------------------------------------------------------------------------

function MailRow({ thread, selected, onSelect, contactLabel, isSpam, isPinned, isTrusted }) {
  // A row is a THREAD, not a single message.
  //
  // The SUBJECT comes from the thread's FIRST message, so a conversation
  // reads by the title it started with.
  //
  // The SENDER comes from the thread's NEWEST message, because that is the
  // one the user is dealing with right now. In the Sent tab that is the
  // message they sent, so it reads "To Jordan"; in the Inbox it is the
  // message they received, so it reads "Jordan".
  const first = thread.messages[0];
  const latest = thread.messages[thread.messages.length - 1];
  const unread = thread.unreadCount > 0;
  const counterpart = latest.direction === 'sent' ? latest.recipientAddress : latest.senderAddress;
  const counterpartName = contactLabel
    || (latest.direction === 'sent' ? `To ${shortAddress(counterpart)}` : shortAddress(counterpart));
  // NO body preview in the list. The subject is the whole point of the row -
  // showing the body leaks the message contents into a scannable list and
  // makes the row hard to scan. The body opens when the message is selected.
  const showRecipient = latest.direction === 'sent';

  return <button type="button" className={`ml-row ${selected ? 'selected' : ''} ${unread ? 'unread' : ''}`} onClick={() => onSelect(thread)}>
    <span className="ml-row-marker" aria-hidden="true">
      {isPinned ? <Pin size={12} className="ml-row-pin" />
        : latest.status === 'undecryptable' ? <AlertCircle size={13} className="ml-row-warn" />
          : unread ? <span className="ml-unread-dot" />
            : <MailOpen size={13} className="ml-row-read-icon" />}
    </span>
    <span className="ml-row-sender" title={counterpart}>
      {showRecipient && <span className="ml-row-to">To </span>}
      <span className="ml-row-name">{counterpartName}</span>
      {isTrusted && <ShieldCheck size={11} className="ml-verified-badge" aria-label="Trusted contact" />}
    </span>
    <span className="ml-row-content" title={thread.subject || ''}>
      <span className="ml-row-subject">{thread.subject || '(no subject)'}</span>
      {latest.status === 'undecryptable' && <span className="ml-row-tag ml-row-tag-warn">Cannot decrypt</span>}
      {latest.status === 'pending' && <span className="ml-row-tag ml-row-tag-pending">Pending</span>}
      {isSpam && <span className="ml-row-tag ml-row-tag-spam">Spam</span>}
      {thread.messageCount > 1 && (
        <span className="ml-row-replies" title={`${thread.messageCount} messages in this conversation`}>
          {thread.messageCount}
        </span>
      )}
    </span>
    <span className="ml-row-date" title={formatFullTimestamp(thread.latestTimestamp)}>{formatRowTime(thread.latestTimestamp)}</span>
  </button>;
}

// ---------------------------------------------------------------------------
// Message detail
// ---------------------------------------------------------------------------

function AttachmentList({ message }) {
  const refs = message.attachmentRefs || [];
  const [state, setState] = useState({});
  const [confirmUpload, setConfirmUpload] = useState(null);

  if (!refs.length) return null;

  // Scans the attachment with VirusTotal.
  //
  // The main process decrypts the file and checks its SHA-256 against
  // VirusTotal FIRST. If the file is already known, nothing is uploaded and
  // the file never leaves the device. Only an unknown file is uploaded, and
  // only after the user agrees.
  const scanAttachment = async (ref, allowUpload) => {
    setState({ ...state, [ref.vout]: { busy: true } });
    try {
      const result = allowUpload
        ? await window.lbsx.scanMailAttachment({
          txid: message.txid,
          vout: ref.vout,
          senderAddress: message.senderAddress,
          recipientAddress: message.recipientAddress,
          messageId: message.messageId,
          fileName: ref.name,
          mimeType: ref.mimeType,
          byteLength: ref.byteLength,
          allowUpload: true,
        })
        : await window.lbsx.checkMailAttachment({
          txid: message.txid,
          vout: ref.vout,
          senderAddress: message.senderAddress,
          recipientAddress: message.recipientAddress,
          messageId: message.messageId,
          fileName: ref.name,
          mimeType: ref.mimeType,
          byteLength: ref.byteLength,
        });
      setState({ ...state, [ref.vout]: { scan: result } });
      return result;
    } catch (error) {
      setState({ ...state, [ref.vout]: { error: error.message || 'The scan could not be completed.' } });
      return null;
    }
  };

  // The first scan never uploads. If the file is unknown, the user is asked
  // whether to send it to VirusTotal for analysis.
  const startScan = async ref => {
    const result = await scanAttachment(ref, false);
    // The upload is only offered when the file is genuinely unknown to
    // VirusTotal. If the lookup failed, or the file is already known, there
    // is nothing to upload and no consent prompt is shown.
    if (result && result.needsUpload) setConfirmUpload(ref);
  };

  const saveAttachment = async ref => {
    setState({ ...state, [ref.vout]: { ...(state[ref.vout] || {}), busy: true } });
    try {
      const result = await window.lbsx.saveMailAttachment({
        txid: message.txid,
        vout: ref.vout,
        senderAddress: message.senderAddress,
        recipientAddress: message.recipientAddress,
        messageId: message.messageId,
        fileName: ref.name,
        mimeType: ref.mimeType,
        byteLength: ref.byteLength,
      });
      setState({
        ...state,
        [ref.vout]: {
          ...(state[ref.vout] || {}),
          busy: false,
          savedTo: result?.saved ? result.filePath : null,
        },
      });
    } catch (error) {
      setState({ ...state, [ref.vout]: { error: error.message || 'The attachment could not be saved.' } });
    }
  };

  const verdictLabel = scan => {
    if (!scan) return null;
    if (scan.pending) return 'Analysis in progress';
    if (scan.needsUpload) return 'Not yet scanned';
    if (scan.verdict === 'malicious') return `${scan.malicious} engine(s) flagged this`;
    if (scan.verdict === 'suspicious') return `${scan.suspicious} engine(s) flagged this`;
    if (scan.verdict === 'clean') return `No threats from ${scan.engines} engines`;
    return 'No result';
  };

  const verdictClass = scan => {
    if (!scan) return '';
    if (scan.verdict === 'malicious') return ' ml-scan-danger';
    if (scan.verdict === 'suspicious') return ' ml-scan-warn';
    if (scan.verdict === 'clean') return ' ml-scan-ok';
    return '';
  };

  return <div className="ml-attachments">
    <div className="ml-attachments-head">
      <Paperclip size={14} />
      <span>{refs.length} attachment{refs.length === 1 ? '' : 's'}</span>
      <span className="ml-attachments-note">Attachments are not previewed. Scan before saving.</span>
    </div>
    <ul className="ml-attach-list ml-attach-list-detail">
      {refs.map(ref => {
        const status = state[ref.vout] || {};
        const scan = status.scan;
        return <li key={ref.vout} className="ml-attach-item">
          <div className="ml-attach-row">
            <FileText size={14} />
            <span className="ml-attach-name">{ref.name}</span>
            <span className="ml-attach-size">{formatBytes(ref.byteLength)}</span>
            <span className="ml-attach-actions">
              <button type="button" onClick={() => startScan(ref)} disabled={status.busy}>
                {status.busy ? <Loader2 size={12} className="spin" /> : <ShieldCheck size={12} />}
                Virus Scan
              </button>
              <button type="button" onClick={() => saveAttachment(ref)} disabled={status.busy}>
                <Download size={12} /> Save
              </button>
            </span>
          </div>
          {status.error && <div className="ml-attach-error">{status.error}</div>}
          {scan && !status.error && (
            <div className={`ml-scan-result${verdictClass(scan)}`}>
              <span className="ml-scan-verdict">{verdictLabel(scan)}</span>
              {scan.uploaded && <span className="ml-scan-note">Uploaded to VirusTotal</span>}
              {!scan.uploaded && scan.alreadyKnown && <span className="ml-scan-note">Already known - nothing was uploaded</span>}
              {!scan.uploaded && !scan.alreadyKnown && !scan.needsUpload && (
                <span className="ml-scan-note">Hash checked only - the file stayed on this device</span>
              )}
              {scan.names?.length > 0 && (
                <span className="ml-scan-names">
                  {scan.names.slice(0, 4).map(entry => `${entry.name}: ${entry.result}`).join(' · ')}
                  {scan.names.length > 4 ? ` · +${scan.names.length - 4} more` : ''}
                </span>
              )}
              {/* The permalink comes from a third-party API response, so its
                  scheme is checked before it is put into the DOM. */}
              {scan.permalink && isSafeLinkUrl(scan.permalink) && (
                <a className="ml-scan-link" href={scan.permalink} target="_blank" rel="noreferrer noopener">
                  VirusTotal report
                </a>
              )}
            </div>
          )}
          {status.savedTo && <div className="ml-attach-saved">Saved to {status.savedTo}</div>}
        </li>;
      })}
    </ul>
    {confirmUpload && (
      <div className="ml-upload-confirm">
        <AlertCircle size={14} />
        <div>
          <b>VirusTotal has never seen this file.</b>
          <p>
            Scanning it means sending the decrypted file to VirusTotal, which
            keeps it publicly and permanently. Your addresses, the sender and
            the message are not sent - only the file itself.
          </p>
          <div className="ml-upload-confirm-actions">
            <button
              type="button"
              className="ml-secondary-button"
              onClick={() => setConfirmUpload(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="ml-primary-button"
              onClick={() => { const ref = confirmUpload; setConfirmUpload(null); scanAttachment(ref, true); }}
            >
              Send for scanning
            </button>
          </div>
        </div>
      </div>
    )}
  </div>;
}

// Renders the formatted mail body.
function MailBody({ text }) {
  const blocks = useMemo(() => renderMailBody(text), [text]);
  return <div className="ml-body">
    {blocks.map((block, index) => {
      if (block.type === 'ul') {
        // An ORDERED list is a real <ol>, so the reader sees the numbers.
        const Tag = block.ordered ? 'ol' : 'ul';
        return <Tag key={index} className="ml-body-list">
          {block.items.map((parts, itemIndex) => <li key={itemIndex}>
            {parts.map((part, partIndex) => {
              if (part.type === 'text') return <span key={partIndex}>{part.text}</span>;
              if (part.type === 'code') return <code key={partIndex} className="ml-body-code">{part.text}</code>;
              if (part.type === 'link') {
                // A link's target comes from the SENDER of the mail, so its
                // scheme is checked before it reaches the DOM. Only http and
                // https are rendered as links; anything else is shown as
                // plain text, because a link that cannot be opened safely is
                // not a link.
                if (!isSafeLinkUrl(part.href)) return <span key={partIndex}>{part.text}</span>;
                return <a key={partIndex} className="ml-body-link" href={part.href} target="_blank" rel="noreferrer">{part.text}</a>;
              }
              if (part.type === 'bold') return <strong key={partIndex}>{part.text}</strong>;
              if (part.type === 'italic') return <em key={partIndex}>{part.text}</em>;
              if (part.type === 'strike') return <s key={partIndex}>{part.text}</s>;
              return null;
            })}
          </li>)}
        </Tag>;
      }
      if (!block.parts.length) return <div key={index} className="ml-body-gap" />;
      return <p key={index} className="ml-body-p">
        {block.parts.map((part, partIndex) => {
          if (part.type === 'text') return <span key={partIndex}>{part.text}</span>;
          if (part.type === 'code') return <code key={partIndex} className="ml-body-code">{part.text}</code>;
          if (part.type === 'link') {
            // The scheme is checked here for the same reason as above - the
            // target comes from the sender of the mail.
            if (!isSafeLinkUrl(part.href)) return <span key={partIndex}>{part.text}</span>;
            return <a key={partIndex} className="ml-body-link" href={part.href} target="_blank" rel="noreferrer">{part.text}</a>;
          }
          if (part.type === 'bold') return <strong key={partIndex}>{part.text}</strong>;
          if (part.type === 'italic') return <em key={partIndex}>{part.text}</em>;
          if (part.type === 'strike') return <s key={partIndex}>{part.text}</s>;
          return null;
        })}
      </p>;
    })}
  </div>;
}

function MessageDetail({ message, thread, onReply, onBack, onToggleRead, onDelete, onMarkSpam, onUnmarkSpam, onTogglePin, isSpam, isPinned, isTrusted, canReply, contactLabel }) {
  const counterpart = message.direction === 'sent' ? message.recipientAddress : message.senderAddress;
  // The sender's initial, so the header reads like a conversation rather than
  // a table row. Falls back to the first character of the address.
  const initial = (contactLabel || counterpart || '?').trim().charAt(0).toUpperCase();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  // The CONVERSATION. Every message in the thread, oldest first, so the
  // exchange reads top to bottom: the first message, then each response in
  // turn, with the newest one last.
  const conversation = thread?.messages?.length ? thread.messages : [message];
  const isThread = conversation.length > 1;

  // Close the menu on an outside click or Escape, so it never floats there.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointerDown = event => {
      if (menuRef.current && !menuRef.current.contains(event.target)) setMenuOpen(false);
    };
    const onKeyDown = event => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const runMenuAction = action => {
    setMenuOpen(false);
    action();
  };

  return <div className="ml-detail">
    <div className="ml-detail-topbar">
      <button type="button" className="ml-back-button" onClick={onBack}><ArrowLeft size={14} /> Back</button>
      <div className="ml-detail-menu-wrap" ref={menuRef}>
        <button
          type="button"
          className="ml-icon-button ml-menu-trigger"
          onClick={() => setMenuOpen(open => !open)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Message options"
          title="Message options"
        >
          <Settings size={15} />
        </button>
        {menuOpen && <div className="ml-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => runMenuAction(onTogglePin)}
          >
            {isPinned ? <PinOff size={13} /> : <Pin size={13} />}
            {isPinned ? 'Unpin' : 'Pin'}
          </button>
          <button type="button" role="menuitem" onClick={() => runMenuAction(() => onToggleRead(message))}>
            <MailOpen size={13} />
            {message.readAt ? 'Mark as unread' : 'Mark as read'}
          </button>
          {message.direction === 'received' && (isSpam
            ? <button type="button" role="menuitem" onClick={() => runMenuAction(onUnmarkSpam)}>
              <ShieldCheck size={13} />
              Unmark as spam
            </button>
            : <button type="button" role="menuitem" onClick={() => runMenuAction(onMarkSpam)}>
              <AlertCircle size={13} />
              Mark as spam
            </button>)}
          <div className="ml-menu-separator" />
          <button type="button" role="menuitem" className="ml-menu-danger" onClick={() => runMenuAction(onDelete)}>
            <Trash2 size={13} />
            Delete
          </button>
        </div>}
      </div>
    </div>
    <div className="ml-detail-head">
      <div className="ml-detail-identity">
        <span className="ml-avatar" aria-hidden="true">{initial}</span>
        <div className="ml-detail-identity-text">
          <h2>{message.subject || '(no subject)'}</h2>
          <div className="ml-detail-meta">
            <span className={`ml-status ml-status-${message.status}`}>{statusLabel(message.status)}</span>
            <span className="ml-detail-party">
              {message.direction === 'sent' ? 'To' : 'From'}
              <b title={counterpart}>
                {contactLabel || shortAddress(counterpart)}
                {isTrusted && <ShieldCheck size={11} className="ml-verified-badge" aria-label="Trusted contact" />}
              </b>
            </span>
            <span>{formatFullTimestamp(message.timestamp)}</span>
            {isPinned && <span className="ml-detail-pinned"><Pin size={10} /> Pinned</span>}
          </div>
        </div>
      </div>
    </div>

    {isSpam && <div className="ml-spam-banner">
      <AlertCircle size={15} />
      <div>
        <b>This sender is marked as spam.</b>
        <p>All of their mail is filed under the Spam tab. Unmarking them restores every message they sent.</p>
      </div>
    </div>}

    {/* The CONVERSATION. Each message is shown oldest first, with its own
        sender, timestamp and body, so a thread reads as one exchange rather
        than as a pile of separate mails. */}
    <div className="ml-conversation">
      {conversation.map((entry, index) => {
        const entryCounterpart = entry.direction === 'sent' ? entry.recipientAddress : entry.senderAddress;
        const entryInitial = (contactLabel || entryCounterpart || '?').trim().charAt(0).toUpperCase();
        return <article key={entry.messageId} className={`ml-conversation-entry ${entry.direction === 'sent' ? 'is-mine' : ''}`}>
          {isThread && <div className="ml-conversation-head">
            <span className="ml-avatar ml-avatar-small" aria-hidden="true">{entryInitial}</span>
            <div className="ml-conversation-meta">
              <b>
                {entry.direction === 'sent' ? 'To' : 'From'}
                {' '}
                {contactLabel || shortAddress(entryCounterpart)}
              </b>
              <span>{formatFullTimestamp(entry.timestamp)}</span>
              <span className={`ml-status ml-status-${entry.status}`}>{statusLabel(entry.status)}</span>
            </div>
          </div>}
          {entry.status === 'undecryptable' ? <div className="ml-undecryptable">
            <AlertCircle size={15} />
            <div>
              <b>This message could not be decrypted.</b>
              <p>{entry.error || 'The payload did not authenticate for this wallet.'}</p>
              <small>The message may have been addressed to a different key, or the payload was altered.</small>
            </div>
          </div> : <MailBody text={entry.body} />}
          {entry.attachmentCount > 0 && <AttachmentList message={entry} />}
          {/* Every message in a conversation is its own transaction, so it
              carries its own transaction id - right under the message it
              belongs to, not in a shared footer for the whole thread. */}
          {entry.txid && <div className="ml-conversation-txid">
            <span className="ml-detail-txid-label">Transaction</span>
            <ExplorerReference value={entry.txid} kind="txid" linkLabel={entry.txid} />
          </div>}
          {index < conversation.length - 1 && <div className="ml-conversation-divider" aria-hidden="true" />}
        </article>;
      })}
    </div>

    <div className="ml-detail-foot">
      {/* The transaction id belongs to EACH message, so it sits under the
          message it belongs to. The footer only carries the reply action. */}
      {message.direction === 'received' ? (
        canReply
          ? <button type="button" className="ml-primary-button" onClick={onReply}>
            <CornerUpLeft size={13} /> Reply
          </button>
          : <span className="ml-reply-unavailable" title="The sender's public key could not be recovered from this transaction.">
            Reply key unavailable
          </span>
      ) : (
        // A SENT mail can be continued too. The reply goes back to the
        // RECIPIENT of the message, which is how a "part 2" continues the
        // same discussion on both sides.
        canReply
          ? <button type="button" className="ml-primary-button" onClick={onReply}>
            <CornerUpLeft size={13} /> Reply
          </button>
          : <span className="ml-reply-unavailable" title="The recipient's public key could not be recovered from this transaction.">
            Reply key unavailable
          </span>
      )}
    </div>
  </div>;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const SORTS = [
  { id: 'newest', label: 'Newest first', icon: ArrowDownUp },
  { id: 'oldest', label: 'Oldest first', icon: ArrowDownUp },
  { id: 'sender', label: 'By sender', icon: ArrowDownAZ },
];

export default function MailPage({ wallet, snapshot, contacts, ownCard, drafts, syncing, error, onSync, onSent, onContactsChanged, onDraftsChanged }) {
  const [view, setView] = useState('list');
  const [selectedId, setSelectedId] = useState(null);
  // The THREAD the user is reading, by its root message id. The list shows
  // one row per conversation, and opening it shows the whole exchange.
  const [selectedThreadId, setSelectedThreadId] = useState(null);
  const [composing, setComposing] = useState(false);
  const [sending, setSending] = useState(false);
  const [tab, setTab] = useState('inbox');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('newest');
  const [showSort, setShowSort] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showAddContact, setShowAddContact] = useState(false);
  const [newContactLabel, setNewContactLabel] = useState('');
  const [newContactAddress, setNewContactAddress] = useState('');
  const [contactError, setContactError] = useState('');
  const [notice, setNotice] = useState('');
  // A NOTICE that clears itself.
  //
  // The notice is a confirmation, not a message. A confirmation that stays on
  // screen forever becomes part of the page, and the user has to dismiss it
  // by hand. It fades on its own after a few seconds.
  const noticeTimer = useRef(null);
  const showNotice = useCallback(text => {
    setNotice(text);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 6000);
  }, []);
  useEffect(() => () => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
  }, []);
  const searchRef = useRef(null);

  const messages = snapshot?.messages || [];

  // The spam flag is per sender public key. A message is spam when its
  // sender's key is on the list, so unmarking a sender restores every
  // message from them at once.
  const spamKeys = useMemo(
    () => new Set((snapshot?.spamSenders || []).map(sender => sender.publicKeyHex)),
    [snapshot?.spamSenders],
  );

  const isSpam = useCallback(
    message => Boolean(message.senderPublicKeyHex) && spamKeys.has(message.senderPublicKeyHex),
    [spamKeys],
  );

  // Every message in the mailbox, grouped into conversations.
  //
  // A thread SPANS both directions: when you reply to a message, your reply
  // lands in Sent while the original stays in the Inbox, but they are one
  // conversation. So the threads are built from ALL the messages and each
  // tab then shows the threads that touch it.
  const allThreads = useMemo(() => groupThreads(messages), [messages]);

  const inbox = useMemo(
    () => allThreads.filter(thread => thread.messages.some(message => message.direction === 'received')),
    [allThreads],
  );

  const sent = useMemo(
    () => allThreads.filter(thread => thread.messages.some(message => message.direction === 'sent')),
    [allThreads],
  );

  // Every message from a spam-flagged sender, regardless of when it arrived.
  const spam = useMemo(
    () => allThreads.filter(thread => thread.messages.some(message => isSpam(message))),
    [allThreads],
  );

  // The unread count for a tab is the number of UNREAD MESSAGES in its
  // threads, not the number of threads - a conversation with three unread
  // replies is three unread messages.
  const countUnread = useCallback(
    threads => threads.reduce(
      (sum, thread) => sum + thread.messages.filter(message => !message.readAt).length,
      0,
    ),
    [],
  );

  const inboxUnread = useMemo(() => countUnread(inbox), [inbox, countUnread]);
  const sentUnread = useMemo(() => countUnread(sent), [sent, countUnread]);
  const spamUnread = useMemo(() => countUnread(spam), [spam, countUnread]);

  // A pinned message stays at the top of its list, so it cannot be scrolled
  // away from. The pinned ids arrive newest-pin-first, and that order is
  // preserved among the pinned group.
  const pinnedIds = useMemo(
    () => snapshot?.pinnedMessageIds || [],
    [snapshot?.pinnedMessageIds],
  );

  const isPinned = useCallback(
    message => pinnedIds.includes(message.messageId),
    [pinnedIds],
  );

  // The THREADS shown in the list for the active tab.
  //
  // A thread spans both directions, so the Inbox shows the conversations
  // that have something received in them and the Sent tab shows the ones
  // that have something sent in them. The SAME conversation can appear in
  // both, and opening it shows the whole exchange.
  //
  // Searching filters the MESSAGES inside each thread, and a thread is kept
  // when any of its messages match - so a search for a word in an old reply
  // still finds the conversation it belongs to.
  const visibleThreads = useMemo(() => {
    if (tab === 'contacts' || tab === 'drafts') return [];
    const base = tab === 'inbox' ? inbox : tab === 'spam' ? spam : sent;

    // Searching filters the MESSAGES inside each thread, and a thread is
    // kept when any of its messages match - so a search for a word in an old
    // reply still finds the conversation it belongs to.
    let threads = base;
    if (query.trim()) {
      threads = [];
      for (const thread of base) {
        const matches = searchMessages(thread.messages, query);
        if (!matches.length) continue;
        threads.push({ ...thread, messages: matches });
      }
    }

    // The sort applies to the THREAD, by its newest message.
    const sorted = threads.slice().sort((a, b) => {
      if (sort === 'oldest') {
        return String(a.latestTimestamp || '').localeCompare(String(b.latestTimestamp || ''));
      }
      if (sort === 'sender') {
        const left = String(a.senderAddress || '').toLowerCase();
        const right = String(b.senderAddress || '').toLowerCase();
        return left.localeCompare(right) || String(b.latestTimestamp || '').localeCompare(String(a.latestTimestamp || ''));
      }
      return String(b.latestTimestamp || '').localeCompare(String(a.latestTimestamp || ''));
    });

    // Pinning is a local reorder on top of whatever sort is active: a thread
    // with ANY pinned message in it stays at the top.
    const pinned = [];
    const rest = [];
    for (const thread of sorted) {
      (thread.messages.some(message => pinnedIds.includes(message.messageId)) ? pinned : rest).push(thread);
    }
    return pinned.length ? [...pinned, ...rest] : rest;
  }, [inbox, sent, spam, tab, query, sort, pinnedIds]);

  // The count shown next to the active tab, so the search summary can
  // compare a filtered list against the right total. It counts MESSAGES,
  // because that is what the user is searching through.
  const tabTotal = tab === 'inbox'
    ? inbox.reduce((sum, thread) => sum + thread.messages.length, 0)
    : tab === 'spam'
      ? spam.reduce((sum, thread) => sum + thread.messages.length, 0)
      : tab === 'contacts' || tab === 'drafts'
        ? 0
        : sent.reduce((sum, thread) => sum + thread.messages.length, 0);

  // Group into day buckets, Gmail style. The bucket is decided by the
  // thread's NEWEST message, so a conversation with a fresh reply moves to
  // today's section.
  const groups = useMemo(() => {
    const buckets = [];
    for (const thread of visibleThreads) {
      const label = formatDayLabel(thread.latestTimestamp);
      const last = buckets[buckets.length - 1];
      if (last && last.label === label) last.threads.push(thread);
      else buckets.push({ label, threads: [thread] });
    }
    return buckets;
  }, [visibleThreads]);

  // The selected THREAD. The detail pane shows the whole conversation, so
  // the selection is the thread, not one message.
  const selectedThread = useMemo(() => {
    if (!selectedThreadId) return null;
    return allThreads.find(thread => thread.threadRootId === selectedThreadId) || null;
  }, [allThreads, selectedThreadId]);

  // The message the detail pane's header and actions act on: the NEWEST
  // message of the thread, because that is the current state of the
  // conversation.
  const selected = useMemo(() => {
    if (selectedThread) return selectedThread.messages[selectedThread.messages.length - 1] || null;
    return messages.find(message => message.messageId === selectedId) || null;
  }, [messages, selectedId, selectedThread]);

  const contactLabels = useMemo(() => {
    const map = new Map();
    for (const contact of contacts || []) {
      map.set(contact.address, contact.label || shortAddress(contact.address));
    }
    return map;
  }, [contacts]);

  // The TRUSTED contact public keys. A trusted contact shows a verified badge
  // beside their name in every list - Inbox, Sent and Spam alike - because the
  // trust is stored per key, not per tab.
  const trustedKeys = useMemo(
    () => new Set(
      (contacts || [])
        .filter(contact => contact.trusted === true)
        .map(contact => contact.publicKeyHex),
    ),
    [contacts],
  );

  // A message is from a trusted counterparty when the PUBLIC KEY that owns it
  // is one the user has vouched for.
  //
  // The key on a message depends on its direction: for a received message the
  // counterparty is the sender, so the key is `senderPublicKeyHex`; for a sent
  // message the counterparty is the RECIPIENT, so the key is
  // `recipientPublicKeyHex`. Checking only one of them is why the badge never
  // appeared in the Sent tab.
  const isTrustedSender = useCallback(
    (message) => {
      if (!message) return false;
      const key = message.direction === 'sent'
        ? message.recipientPublicKeyHex
        : message.senderPublicKeyHex;
      return Boolean(key) && trustedKeys.has(key);
    },
    [trustedKeys],
  );

  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null);
  }, [selectedId, selected]);

  // Mark a message as read when it is opened.
  // Opens a THREAD. Every message in it is marked read, because the user has
  // now seen the whole conversation.
  const openMessage = useCallback(async thread => {
    setSelectedThreadId(thread.threadRootId);
    setSelectedId(thread.messages[thread.messages.length - 1]?.messageId || null);
    setView('detail');
    const unread = thread.messages.filter(entry => !entry.readAt);
    if (!unread.length) return;
    try {
      for (const entry of unread) {
        await window.lbsx.markMailRead({ messageId: entry.messageId, read: true });
      }
      if (onSent) await onSent();
    } catch {
      // A read-state failure must not stop the message from opening.
    }
  }, [onSent]);

  const toggleRead = useCallback(async message => {
    try {
      await window.lbsx.markMailRead({ messageId: message.messageId, read: !message.readAt });
      if (onSent) await onSent();
    } catch (toggleError) {
      showNotice(toggleError.message || 'The read state could not be changed.');
    }
  }, [onSent]);

  // Deletes a message from the local mailbox.
  //
  // The message is still on chain - that part is permanent and cannot be
  // undone. This removes it from this wallet's mailbox so it stops showing
  // up, and the next sync will not bring it back.
  const deleteMessage = useCallback(async message => {
    try {
      await window.lbsx.deleteMailMessage({ messageId: message.messageId });
      setSelectedId(null);
      setSelectedThreadId(null);
      setView('list');
      showNotice('Message deleted from your mailbox. The transaction still exists on chain.');
      if (onSent) await onSent();
    } catch (deleteError) {
      showNotice(deleteError.message || 'The message could not be deleted.');
    }
  }, [onSent]);

  // Flags the sender's public key as spam.
  //
  // The key is the identity, so this covers every address that key controls,
  // and every message they have already sent as well as every future one.
  const markAsSpam = useCallback(async message => {
    const publicKeyHex = String(message.senderPublicKeyHex || '').trim();
    if (!publicKeyHex) {
      showNotice('This sender\'s public key could not be recovered, so they cannot be marked as spam.');
      return;
    }
    try {
      await window.lbsx.markMailSenderSpam({
        publicKeyHex,
        senderAddress: message.senderAddress,
      });
      setSelectedId(null);
      setSelectedThreadId(null);
      setView('list');
      showNotice('Sender marked as spam. Their mail is now filed under Spam.');
      if (onSent) await onSent();
    } catch (spamError) {
      showNotice(spamError.message || 'The sender could not be marked as spam.');
    }
  }, [onSent]);

  // Removes the spam flag. Every message from that sender returns to the inbox.
  const unmarkAsSpam = useCallback(async message => {
    const publicKeyHex = String(message.senderPublicKeyHex || '').trim();
    if (!publicKeyHex) {
      showNotice('This sender\'s public key could not be recovered.');
      return;
    }
    try {
      await window.lbsx.unmarkMailSenderSpam({ publicKeyHex });
      setSelectedId(null);
      setSelectedThreadId(null);
      setView('list');
      showNotice('Sender unmarked. Their mail has been restored to the inbox.');
      if (onSent) await onSent();
    } catch (unspamError) {
      showNotice(unspamError.message || 'The sender could not be unmarked.');
    }
  }, [onSent]);

  // Pins or unpins a message.
  //
  // The pin is local: it keeps the message at the top of its list on this
  // device. Nothing about the message changes on chain.
  const togglePin = useCallback(async message => {
    const pinned = !pinnedIds.includes(message.messageId);
    try {
      await window.lbsx.pinMailMessage({ messageId: message.messageId, pinned });
      showNotice(pinned ? 'Message pinned to the top of the list.' : 'Message unpinned.');
      if (onSent) await onSent();
    } catch (pinError) {
      showNotice(pinError.message || 'The message could not be pinned.');
    }
  }, [onSent, pinnedIds]);

  // Marks or unmarks a contact as trusted.
  //
  // "Trusted" is the user's own local vouch for the contact - it says "I have
  // confirmed this is really them". It is stored per public key, so it also
  // shows on every mail row from that sender.
  const toggleTrust = useCallback(async contact => {
    const trusted = contact.trusted !== true;
    try {
      await window.lbsx.trustMailContact({ publicKeyHex: contact.publicKeyHex, trusted });
      showNotice(trusted
        ? `${contact.label || shortAddress(contact.address)} is now trusted.`
        : `${contact.label || shortAddress(contact.address)} is no longer trusted.`);
      if (onContactsChanged) await onContactsChanged();
      if (onSent) await onSent();
    } catch (trustError) {
      showNotice(trustError.message || 'The contact could not be updated.');
    }
  }, [onContactsChanged, onSent]);

  const send = useCallback(async payload => {
    setSending(true);
    try {
      const result = await window.lbsx.sendMail(payload);
      setComposing(false);
      showNotice('Mail encrypted and broadcast. It appears in the recipient inbox once confirmed.');
      if (onSent) await onSent();
      return result;
    } finally {
      setSending(false);
    }
  }, [onSent]);

  // Saves the compose panel's content as a LOCAL draft.
  //
  // A draft is never broadcast - it lives in the encrypted wallet data on
  // this device, so nothing about it reaches the chain and nobody else can
  // read it. The thread is carried so a draft written as a reply still
  // continues the same conversation when it is finally sent.
  const saveAsDraft = useCallback(async draft => {
    try {
      await window.lbsx.saveMailDraft({
        draftId: draft.draftId,
        recipient: draft.recipient,
        recipientPublicKeyHex: draft.recipientPublicKeyHex,
        subject: draft.subject,
        body: draft.body,
        attachments: draft.attachments,
        threadRootId: draft.threadRootId,
        updatedAt: new Date().toISOString(),
      });
      // The compose window STAYS OPEN. Closing it here would unmount the
      // panel, and the next save would mint a fresh draft id - which is how
      // the same draft ends up saved twice. Keeping it open means the id
      // stays stable and every save updates the SAME draft, and it lets the
      // user keep editing after saving.
      showNotice('Draft saved on this device. It was not sent, and nothing was written to the chain.');
      if (onDraftsChanged) await onDraftsChanged();
    } catch (draftError) {
      showNotice(draftError.message || 'The draft could not be saved.');
    }
  }, [onDraftsChanged]);

  // Opens a saved draft back in the compose window, so the user can finish
  // it and send it. The draft's thread is carried, so a draft written as a
  // reply still continues the same conversation.
  const openDraft = useCallback((draft) => {
    setReplyDraft({
      draftId: draft.draftId,
      recipient: draft.recipient,
      publicKeyHex: draft.recipientPublicKeyHex,
      subject: draft.subject,
      body: draft.body,
      canReply: Boolean(draft.recipientPublicKeyHex),
      threadRootId: draft.threadRootId || '',
      attachments: draft.attachments || [],
    });
    setComposing(true);
    setView('list');
  }, []);

  // Discards a saved draft.
  const removeDraft = useCallback(async (draftId) => {
    try {
      await window.lbsx.deleteMailDraft(draftId);
      showNotice('Draft discarded.');
      if (onDraftsChanged) await onDraftsChanged();
    } catch (draftError) {
      showNotice(draftError.message || 'The draft could not be discarded.');
    }
  }, [onDraftsChanged]);

  const addContact = async () => {
    setContactError('');
    try {
      // No public key is sent: the backend derives it from the address.
      await window.lbsx.saveMailContact({
        address: newContactAddress.trim(),
        label: newContactLabel.trim(),
      });
      setNewContactLabel('');
      setNewContactAddress('');
      setShowAddContact(false);
      // The contact list lives in the main process, so the page re-reads it.
      if (onContactsChanged) await onContactsChanged();
    } catch (addError) {
      setContactError(addError.message || 'The contact could not be saved.');
    }
  };

  const removeContact = async address => {
    setContactError('');
    try {
      await window.lbsx.removeMailContact(address);
      if (onContactsChanged) await onContactsChanged();
    } catch (removeError) {
      setContactError(removeError.message || 'The contact could not be removed.');
    }
  };

  const [replyDraft, setReplyDraft] = useState(null);

  const startReply = (target) => {
    // A reply continues the CONVERSATION, so it must carry the thread root of
    // the message being replied to. That is what makes both sides group the
    // messages into the same thread.
    const threadRootId = target.threadRootId || target.messageId;

    // A reply to a RECEIVED message goes back to its sender. A reply to a
    // SENT message goes back to its RECIPIENT - that is how a user continues
    // a discussion they started, and it is what puts "part 2" into the same
    // conversation on the other side.
    const isSent = target.direction === 'sent';
    const counterpartAddress = isSent ? target.recipientAddress : target.senderAddress;
    // The key needed to encrypt the reply: the sender's key for a received
    // message, the recipient's key for a sent one. The recipient key is
    // recovered from the transaction that funded the mail, so the reply goes
    // back to the same party.
    const counterpartKey = isSent
      ? target.recipientPublicKeyHex
        || (contacts || []).find(contact => contact.address === target.recipientAddress)?.publicKeyHex
        || ''
      : target.senderPublicKeyHex
        || (contacts || []).find(contact => contact.address === target.senderAddress)?.publicKeyHex
        || '';

    const baseSubject = target.subject || '';
    setReplyDraft({
      recipient: counterpartAddress,
      publicKeyHex: counterpartKey,
      subject: /^re:/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`.trim(),
      body: '',
      canReply: Boolean(counterpartKey),
      threadRootId,
    });
    setView('list');
    setComposing(true);
    setTab(isSent ? 'sent' : 'inbox');
  };

  const clearSearch = () => {
    setQuery('');
    if (searchRef.current) searchRef.current.focus();
  };

  const activeSort = SORTS.find(option => option.id === sort) || SORTS[0];

  return <div className="ml-page">
    <header className="ml-page-heading">
      <div className="ml-page-title">
        <span className="ml-page-icon"><Mail size={17} /></span>
        <h1>Email</h1>
        <span className="ml-encrypted-badge"><ShieldCheck size={11} /> End-to-end encrypted</span>
        <button type="button" className="ml-info-button" onClick={() => setShowInfo(!showInfo)} title="What this feature does and does not hide" aria-label="About encrypted mail">
          <Info size={15} />
        </button>
      </div>
      <p>Private messages between addresses, encrypted to the recipient's public key and anchored on-chain.</p>
    </header>

    {showInfo && <div className="ml-info-panel">
      <div className="ml-info-head">
        <ShieldCheck size={16} />
        <b>What is encrypted</b>
        <button type="button" className="ml-icon-button" onClick={() => setShowInfo(false)} aria-label="Close"><X size={14} /></button>
      </div>
      <ul>
        <li><b>The message body is private.</b> It is encrypted to the recipient's public key with AES-256-GCM. Only the holder of the matching private key can read it — not this wallet's author, not the indexer, not anyone watching the chain.</li>
        <li><b>The metadata is public.</b> Sender, recipient, timestamp, message size and message count are written on-chain and permanently visible to anyone who looks. Treat the size and timing of your mail as public.</li>
        <li><b>There is no forward secrecy.</b> If the recipient's private key is ever compromised, every message ever sent to them can be decrypted from the public chain.</li>
        <li><b>Deleting is local only.</b> Delete removes a message from this wallet's mailbox, but the transaction stays on chain - it is a permanent public record that the mail was sent.</li>
        <li><b>Spam is a local label.</b> Marking a sender as spam files their mail under the Spam tab on this device. It does not block them on chain, and only you can see the label.</li>
      </ul>
      <button type="button" className="ml-secondary-button" onClick={() => setShowInfo(false)}>Got it</button>
    </div>}

    {error && <div className="ml-error ml-error-banner"><AlertCircle size={15} /> {error}</div>}
    {notice && <div className="ml-notice"><CheckCircle2 size={15} /> {notice}</div>}

    <div className="ml-toolbar">
      <div className="ml-toolbar-actions">
        <button type="button" className="ml-secondary-button" onClick={onSync} disabled={syncing}>
          <RefreshCw size={13} className={syncing ? 'spin' : ''} /> Sync
        </button>
        <button type="button" className="ml-primary-button" onClick={() => { setComposing(true); setView('list'); setTab('inbox'); }} disabled={sending}>
          <Send size={13} /> Compose
        </button>
      </div>
    </div>

    {tab !== 'contacts' && <div className="ml-searchbar">
      <Search size={14} className="ml-search-icon" />
      <input
        ref={searchRef}
        type="search"
        value={query}
        placeholder="Search mail — try from:, to:, subject:, is:unread, after:2026-01-01"
        onChange={event => setQuery(event.target.value)}
        aria-label="Search mail"
      />
      {query && <button type="button" className="ml-search-clear" onClick={clearSearch} aria-label="Clear search"><X size={13} /></button>}
      <div className="ml-sort-wrap">
        <button type="button" className="ml-sort-button" onClick={() => setShowSort(!showSort)} title="Sort order">
          <Filter size={13} /> <span>{activeSort.label}</span>
        </button>
        {showSort && <div className="ml-sort-menu">
          {SORTS.map(option => <button type="button" key={option.id} className={sort === option.id ? 'active' : ''} onClick={() => { setSort(option.id); setShowSort(false); }}>
            <option.icon size={13} /> {option.label}
          </button>)}
        </div>}
      </div>
    </div>}

    {query && <div className="ml-search-summary">
      {visibleThreads.length === 1 ? '1 conversation matches' : `${visibleThreads.length} conversations match`}
      {visibleThreads.length !== tabTotal && ` (of ${tabTotal})`}
    </div>}

    {/* The compose window is an OVERLAY on top of the mail page, so the user
        can see the conversation they are replying to while they write. */}
    {composing && <div className="ml-compose-overlay" role="dialog" aria-label="New message">
      <ComposePanel
        contacts={contacts || []}
        ownCard={ownCard}
        onSend={send}
        onSaveDraft={saveAsDraft}
        sending={sending}
        onCancel={() => { setComposing(false); setReplyDraft(null); }}
        initialRecipient={replyDraft?.recipient}
        initialPublicKeyHex={replyDraft?.publicKeyHex}
        initialSubject={replyDraft?.subject}
        initialBody={replyDraft?.body}
        initialThreadRootId={replyDraft?.threadRootId}
        initialDraftId={replyDraft?.draftId}
        initialAttachments={replyDraft?.attachments}
      />
    </div>}

    <div className="ml-layout">
      <nav className="ml-subnav" aria-label="Mail sections">
        <div className="ml-subnav-caption">Mailbox</div>
        <button type="button" className={`ml-subnav-item ${tab === 'inbox' ? 'active' : ''}`} onClick={() => { setTab('inbox'); setView('list'); }}>
          <Inbox size={14} />
          <span>Inbox</span>
          {inboxUnread > 0
            ? <span className="ml-subnav-count ml-count-unread">{inboxUnread}</span>
            : <span className="ml-subnav-count">{inbox.length}</span>}
        </button>
        <button type="button" className={`ml-subnav-item ${tab === 'sent' ? 'active' : ''}`} onClick={() => { setTab('sent'); setView('list'); }}>
          <Send size={14} />
          <span>Sent</span>
          {sentUnread > 0
            ? <span className="ml-subnav-count ml-count-unread">{sentUnread}</span>
            : <span className="ml-subnav-count">{sent.length}</span>}
        </button>
        <button type="button" className={`ml-subnav-item ${tab === 'spam' ? 'active' : ''}`} onClick={() => { setTab('spam'); setView('list'); }}>
          <ShieldAlert size={14} />
          <span>Spam</span>
          {spamUnread > 0
            ? <span className="ml-subnav-count ml-count-unread">{spamUnread}</span>
            : <span className="ml-subnav-count">{spam.length}</span>}
        </button>
        <button type="button" className={`ml-subnav-item ${tab === 'drafts' ? 'active' : ''}`} onClick={() => { setTab('drafts'); setView('list'); }}>
          <FileText size={14} />
          <span>Drafts</span>
          <span className="ml-subnav-count">{(drafts || []).length}</span>
        </button>
        <div className="ml-subnav-caption ml-subnav-caption-gap">People</div>
        <button type="button" className={`ml-subnav-item ${tab === 'contacts' ? 'active' : ''}`} onClick={() => { setTab('contacts'); setView('list'); }}>
          <Users size={14} />
          <span>Contacts</span>
          <span className="ml-subnav-count">{(contacts || []).length}</span>
        </button>
      </nav>

      {tab === 'drafts' ? <section className="ml-list-panel ml-contacts-view">
        <div className="ml-section-head">
          <h2><FileText size={15} /> Drafts</h2>
          <span className="ml-drafts-note">Saved on this device only — never sent.</span>
        </div>

        {(drafts || []).length === 0 ? <div className="ml-empty-hint">
          <FileText size={15} />
          <span>No drafts. Write a message and choose “Save as draft” to keep it here.</span>
        </div> : (drafts || []).map(draft => <article key={draft.draftId} className="ml-draft">
          <div className="ml-draft-head">
            <b>{draft.subject || '(no subject)'}</b>
            <span>{formatFullTimestamp(draft.updatedAt)}</span>
          </div>
          <div className="ml-draft-meta">
            <span>To {shortAddress(draft.recipient)}</span>
            {draft.attachments.length > 0 && (
              <span><Paperclip size={11} /> {draft.attachments.length} attachment{draft.attachments.length === 1 ? '' : 's'}</span>
            )}
            {draft.threadRootId && <span className="ml-draft-thread">Reply</span>}
          </div>
          {draft.body && <p className="ml-draft-body">{draft.body}</p>}
          <div className="ml-draft-actions">
            <button type="button" className="ml-primary-button" onClick={() => openDraft(draft)}>
              <Send size={13} /> Continue
            </button>
            <button type="button" className="ml-secondary-button" onClick={() => removeDraft(draft.draftId)}>
              <Trash2 size={13} /> Discard
            </button>
          </div>
        </article>)}
      </section> : tab === 'contacts' ? <section className="ml-list-panel ml-contacts-view">
        <div className="ml-section-head">
          <h2><Users size={15} /> Contacts</h2>
          <button type="button" className="ml-text-button" onClick={() => setShowAddContact(!showAddContact)}>
            <UserPlus size={13} /> {showAddContact ? 'Close' : 'Add contact'}
          </button>
        </div>

        {showAddContact && <div className="ml-add-contact">
          <label className="ml-field">
            <span>Name <em>optional</em></span>
            <input type="text" value={newContactLabel} maxLength={60} placeholder="Alice" onChange={event => setNewContactLabel(event.target.value)} />
          </label>
          <label className="ml-field">
            <span>Address</span>
            <input type="text" value={newContactAddress} placeholder="1…" onChange={event => setNewContactAddress(event.target.value)} />
          </label>
          <small className="ml-hint">
            Only a name and an address are needed. The public key is looked up on-chain
            and checked against the address before the contact is saved.
          </small>
          {contactError && <div className="ml-error"><AlertCircle size={13} /> {contactError}</div>}
          <div className="ml-compose-actions">
            <button type="button" className="ml-secondary-button" onClick={() => setShowAddContact(false)}>Cancel</button>
            <button type="button" className="ml-primary-button" onClick={addContact}>Save contact</button>
          </div>
        </div>}

        {contactError && !showAddContact && <div className="ml-error"><AlertCircle size={13} /> {contactError}</div>}

        {(contacts || []).length === 0 ? <div className="ml-empty-hint">
          <UserPlus size={15} />
          <span>No contacts yet. Add one with their BSV address to start sending encrypted mail.</span>
        </div> : (contacts || []).map(contact => <ContactCard
          key={contact.address}
          contact={contact}
          onRemove={removeContact}
          onToggleTrust={toggleTrust}
          disabled={syncing}
        />)}

        {ownCard && <div className="ml-share-hint">
          <Lock size={13} />
          <span>Share your own address and public key so someone can send you encrypted mail.</span>
        </div>}
      </section> : <section className="ml-list-panel">
        {visibleThreads.length === 0 && !composing ? <div className="ml-empty">
          <Mail size={26} />
          <b>{query ? 'No matching mail' : tab === 'inbox' ? 'No mail yet' : tab === 'spam' ? 'No spam' : 'Nothing sent yet'}</b>
          <span>{query
            ? 'Try a different search term, or clear the search.'
            : tab === 'inbox'
              ? 'Mail sent to your address will appear here after a sync.'
              : tab === 'spam'
                ? 'Mail from senders you marked as spam is filed here.'
                : 'Encrypted mail you send will be listed here.'}</span>
        </div> : groups.map(group => <div className="ml-day-group" key={group.label}>
          <div className="ml-day-label">{group.label}</div>
          {group.threads.map(thread => {
            // The contact label follows the thread's NEWEST message, matching
            // the sender column: "To Jordan" for a message you sent, "Jordan"
            // for one you received.
            const latest = thread.messages[thread.messages.length - 1];
            return <MailRow
              key={thread.threadRootId}
              thread={thread}
              selected={selectedThread?.threadRootId === thread.threadRootId}
              onSelect={openMessage}
              contactLabel={contactLabels.get(latest.direction === 'sent' ? latest.recipientAddress : latest.senderAddress)}
              isSpam={thread.messages.some(entry => isSpam(entry))}
              isPinned={thread.messages.some(entry => isPinned(entry))}
              isTrusted={isTrustedSender(latest)}
            />;
          })}
        </div>)}
      </section>}

      {tab !== 'contacts' && tab !== 'drafts' && <section className="ml-detail-panel">
        {view === 'detail' && selected
          ? <MessageDetail
            message={selected}
            thread={selectedThread}
            onReply={() => startReply(selected)}
            onBack={() => { setView('list'); setSelectedId(null); setSelectedThreadId(null); }}
            onToggleRead={toggleRead}
            onDelete={() => deleteMessage(selected)}
            onMarkSpam={() => markAsSpam(selected)}
            onUnmarkSpam={() => unmarkAsSpam(selected)}
            onTogglePin={() => togglePin(selected)}
            isSpam={isSpam(selected)}
            isPinned={isPinned(selected)}
            isTrusted={isTrustedSender(selected)}
            contactLabel={contactLabels.get(selected.direction === 'sent'
              ? selected.recipientAddress
              : selected.senderAddress)}
            canReply={selected.direction === 'sent'
              ? Boolean(selected?.recipientPublicKeyHex
                || (contacts || []).some(contact => contact.address === selected?.recipientAddress))
              : Boolean(selected?.senderPublicKeyHex
                || (contacts || []).some(contact => contact.address === selected?.senderAddress))}
          />
          : <div className="ml-empty ml-detail-empty">
            <MailOpen size={26} />
            <b>Select a message</b>
            <span>Choose a message on the left to read it.</span>
          </div>}
      </section>}
    </div>
  </div>;
}
