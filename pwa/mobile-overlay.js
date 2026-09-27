/*
 * Mobile overlay for code-server: voice dictation + project switcher.
 *
 * Design constraint learned the hard way: do not touch the workbench's DOM or
 * CSS. VS Code positions its parts with absolute inline styles computed in JS,
 * so hiding or resizing them via CSS desynchronises the layout and paints a
 * blank gray screen. Everything here lives in its own fixed-position container
 * appended to <body>, above the workbench, and never restyles it.
 *
 * The Claude Code panel is a webview iframe with its own document, so its input
 * cannot be written to directly. (Desktop VS Code serves webviews from
 * vscode-cdn.net; code-server serves them from this origin under
 * /stable-<commit>/static/. Either way they are a separate window.) Dictated
 * text is therefore delivered the two ways that work from outside a webview:
 *   1. clipboard — one tap to paste, works everywhere
 *   2. synthetic keystrokes into whatever has focus, for same-origin inputs
 * Both are offered; the UI is explicit about which it used.
 */
(function () {
  'use strict';

  /*
   * Top-level document only.
   *
   * nginx injects this script into every text/html response code-server serves,
   * and the workbench serves its webview container from this same origin
   * (/stable-<commit>/static/out/vs/workbench/contrib/webview/browser/pre/).
   * So the Claude Code panel's iframe was getting the script too, and mounting a
   * second mic and a second project switcher a few pixels off the first pair.
   * The __claudeMobileOverlay flag below cannot catch that: the iframe is a
   * different window, with its own globals.
   *
   * Comparing window references never throws, even cross-origin — only reading
   * properties off a foreign window does. So this is safe in both the
   * same-origin webview code-server actually uses and the vscode-cdn.net one
   * desktop VS Code uses.
   */
  if (window.top !== window.self) return;

  if (window.__claudeMobileOverlay) return;
  window.__claudeMobileOverlay = true;

  /*
   * Which version of this file is on the phone.
   *
   * nginx serves it with `Cache-Control: no-cache`, so a reload always fetches the
   * current one — but the workbench is a page that stays open for days on a phone,
   * and a page open across a deploy keeps running the script it loaded. That is
   * indistinguishable from a feature that does not work, and it has cost a round
   * trip of "it isn't doing anything" / "it is, reload it" more than once. So the
   * date is printed by the install check below, where someone comparing what they
   * see against what was shipped can read it.
   *
   * Bump it when this file changes in a way anyone would look for.
   */
  const OVERLAY_BUILD = '2026-09-27.2';

  // -------------------------------------------- survive a browser refresh
  /*
   * Keep the server-side extension host alive when this page goes away, so a
   * refresh or a device switch doesn't kill the Claude turn in flight.
   *
   * VS Code Web already holds a disconnected extension host for
   * VSCODE_RECONNECTION_GRACE_TIME. What defeated it: on unload the client
   * sends a Disconnect control frame, which means "deliberate, dispose now" —
   * the server logs "The client has disconnected gracefully" and tears the host
   * down about two seconds later, mid-request.
   *
   * The earlier attempt at this rewrote workbench.js to skip that send. It
   * black-screened the editor on mobile, twice, and was reverted. This does the
   * same job from outside: drop the one frame on its way out of the socket, and
   * leave VS Code's own code untouched. If this script fails to load or throws,
   * the editor is exactly stock — the failure mode is "the old bug is back",
   * not "a broken bundle no browser can render".
   *
   * Wire format (out/vs/base/parts/ipc, confirmed against this build): a
   * 13-byte header — type u8, id u32be, ack u32be, dataLength u32be — followed
   * by dataLength bytes. Type 5 is Disconnect and carries no payload. The
   * writer can coalesce several frames into one send(), so walk the buffer and
   * strip only complete zero-length type-5 frames; anything that doesn't parse
   * as a clean frame sequence is passed through untouched rather than guessed
   * at. Dropping a byte of real protocol traffic would break the session far
   * worse than the bug being fixed.
   */
  const DISCONNECT = 5;
  const HEADER = 13;

  function stripDisconnectFrames(buf) {
    let offset = 0;
    const keep = [];
    let stripped = false;

    while (offset < buf.length) {
      if (offset + HEADER > buf.length) return null; // truncated: not ours to edit
      const type = buf[offset];
      const dataLength =
        (buf[offset + 9] << 24) |
        (buf[offset + 10] << 16) |
        (buf[offset + 11] << 8) |
        buf[offset + 12];
      if (dataLength < 0) return null;
      const end = offset + HEADER + dataLength;
      if (end > buf.length) return null; // header disagrees with the buffer
      if (type === DISCONNECT && dataLength === 0) stripped = true;
      else keep.push(buf.subarray(offset, end));
      offset = end;
    }

    if (!stripped) return null; // nothing to do; send the original object
    const total = keep.reduce((n, f) => n + f.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const frame of keep) {
      out.set(frame, at);
      at += frame.length;
    }
    return out;
  }

  try {
    const nativeSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        // Only binary protocol frames are candidates; strings are not.
        if (data && typeof data !== 'string') {
          const view =
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : data.buffer instanceof ArrayBuffer
                ? new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength)
                : null;
          if (view && view.length >= HEADER) {
            const filtered = stripDisconnectFrames(view);
            if (filtered) {
              // Every frame was a Disconnect: send nothing at all.
              if (filtered.length === 0) return;
              return nativeSend.call(this, filtered);
            }
          }
        }
      } catch {
        // Never let this break a send; fall through to the original.
      }
      return nativeSend.call(this, data);
    };
  } catch {
    /* stock behaviour: refresh kills the turn, as before */
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  // ---------------------------------------------------------------- styles
  // Scoped to our own ids/classes only. Nothing here selects .monaco-* or .part.
  const css = `
  /*
   * Docked to the LEFT edge, vertically centred — deliberately not the bottom
   * right, where Claude's own send/stop controls live. A floating button there
   * covered the stop button and made it impossible to interrupt the agent.
   * Also small and semi-transparent until touched, so it never hides content.
   */
  #cmo-fab {
    position: fixed; z-index: 2147483000;
    left: max(6px, env(safe-area-inset-left));
    top: 50%; transform: translateY(-50%);
    display: flex; flex-direction: column; gap: 8px;
    opacity: .45; transition: opacity .15s;
  }
  #cmo-fab:hover, #cmo-fab:focus-within, #cmo-fab.cmo-active { opacity: 1; }
  .cmo-btn {
    width: 40px; height: 40px; border-radius: 50%; border: none;
    display: grid; place-items: center; cursor: pointer;
    background: #d97757; color: #fff;
    box-shadow: 0 2px 8px rgba(0,0,0,.4);
    font-size: 17px; line-height: 1;
    -webkit-tap-highlight-color: transparent; touch-action: manipulation;
  }
  .cmo-btn.cmo-secondary { background: #3a3a38; font-size: 15px; }
  .cmo-btn:active { transform: scale(.93); }
  .cmo-btn.cmo-rec { background: #e05252; animation: cmo-pulse 1.4s infinite; }
  @keyframes cmo-pulse {
    0%,100% { box-shadow: 0 0 0 0 rgba(224,82,82,.55), 0 4px 14px rgba(0,0,0,.45) }
    50%     { box-shadow: 0 0 0 16px rgba(224,82,82,0), 0 4px 14px rgba(0,0,0,.45) }
  }
  /*
   * Speaking has to be visible on the bar, not only in the sheet: the sheet is
   * dismissed by tapping beside it, and the voice carries on afterwards — so this
   * button is the only Stop there is at that point. Same pulse as recording, in
   * the accent colour rather than the recording red.
   */
  .cmo-btn.cmo-speaking { background: #d97757; animation: cmo-speak-pulse 1.6s infinite; }
  @keyframes cmo-speak-pulse {
    0%,100% { box-shadow: 0 0 0 0 rgba(217,119,87,.55), 0 4px 14px rgba(0,0,0,.45) }
    50%     { box-shadow: 0 0 0 14px rgba(217,119,87,0), 0 4px 14px rgba(0,0,0,.45) }
  }

  #cmo-sheet {
    position: fixed; inset: 0; z-index: 2147483001;
    display: none; align-items: flex-end;
    background: rgba(0,0,0,.55);
  }
  #cmo-sheet.cmo-open { display: flex; }
  .cmo-panel {
    width: 100%; background: #1e1e1c; color: #f5f4ef;
    border-radius: 18px 18px 0 0;
    padding: 16px 16px calc(20px + env(safe-area-inset-bottom));
    font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    max-height: 82vh; overflow-y: auto;
    box-shadow: 0 -8px 30px rgba(0,0,0,.5);
  }
  .cmo-title { font-size: 13px; text-transform: uppercase; letter-spacing: .06em;
    color: #a3a099; margin: 0 0 10px; }
  /*
   * Selectable, which nothing on this overlay is by default.
   *
   * The workbench sets user-select: none on its own body — reasonable for an editor, where
   * a drag across the sidebar should not highlight it — and this overlay is appended
   * to that body, so every block on it inherits the rule. The symptom is that a
   * long-press or a drag over Claude's answer selects nothing at all and there is no
   * way to take a line out of it, which is what these sheets are mostly read for.
   *
   * Only the blocks that hold text worth keeping say so. The bar, the chip and the
   * buttons stay unselectable: they live under a thumb, and a long-press that
   * highlights a button label instead of pressing it is the reason the workbench
   * turned this off in the first place.
   */
  .cmo-said, .cmo-ask-block, .cmo-first, .cmo-talk-line {
    -webkit-user-select: text; user-select: text;
  }
  #cmo-text {
    width: 100%; box-sizing: border-box; min-height: 108px;
    background: #272725; color: #f5f4ef;
    border: 1px solid #34342f; border-radius: 12px; padding: 12px;
    /* 16px minimum or iOS zooms the page and never zooms back. */
    font: 16px/1.5 inherit; resize: vertical;
  }
  .cmo-row { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .cmo-action {
    flex: 1 1 auto; min-width: 120px; padding: 13px 14px; border: none;
    border-radius: 12px; background: #d97757; color: #fff;
    font: 600 15px inherit; cursor: pointer;
  }
  .cmo-action.cmo-alt { background: #3a3a38; color: #f5f4ef; }
  /* A control with nothing to act on yet — Mute before the microphone has been
     granted. Dimmed rather than hidden: a row that reflows while a call is connecting
     moves Hang up out from under a thumb already on its way down. */
  .cmo-action[disabled] { opacity: 0.45; }
  .cmo-hint { color: #a3a099; font-size: 12.5px; margin: 10px 0 0; }
  .cmo-hint a { color: #d97757; }
  .cmo-status { color: #d97757; font-size: 13px; margin: 8px 0 0; min-height: 18px; }
  /* Undo, offered in the status line after a reset rather than as a fifth button:
     the row already wraps onto a second line on a phone, and this one is only
     reachable for a few seconds after a tap that threw a paragraph away. */
  .cmo-undo {
    margin-left: 8px; padding: 3px 9px; border: 1px solid #55524c;
    border-radius: 999px; background: transparent; color: #f5f4ef;
    font: 600 12.5px inherit; cursor: pointer;
  }
  /* Room for the chip on its own line, kept after it goes: the offer expires on a
     timer nobody is watching, and the row below must not climb 20px while a thumb
     is already on its way down to Copy & close. */
  .cmo-status.cmo-status-undo { min-height: 44px; }
  .cmo-item {
    display: block; width: 100%; text-align: left; padding: 14px 12px;
    background: none; border: none; border-bottom: 1px solid #34342f;
    color: #f5f4ef; font: 15px inherit; cursor: pointer; text-decoration: none;
  }
  .cmo-item:active { background: #272725; }
  /* A project and its "open in a new tab" control share one row, so the divider
     between projects belongs to the row rather than to either control. */
  .cmo-item-row { display: flex; align-items: stretch; border-bottom: 1px solid #34342f; }
  .cmo-item-row .cmo-item { flex: 1 1 auto; width: auto; border-bottom: none; }
  .cmo-item-new {
    flex: 0 0 auto; display: flex; align-items: center; padding: 0 15px;
    border-left: 1px solid #34342f; color: #a3a099; font-size: 18px;
    text-decoration: none; cursor: pointer;
  }
  .cmo-item-new:active { background: #272725; }
  .cmo-input {
    width: 100%; box-sizing: border-box; margin-bottom: 8px;
    background: #272725; color: #f5f4ef;
    border: 1px solid #34342f; border-radius: 10px; padding: 12px;
    /* 16px minimum or iOS zooms the page and never zooms back. */
    font: 16px/1.4 inherit;
  }
  .cmo-check {
    display: flex; align-items: center; gap: 9px;
    margin: 4px 0 2px; font-size: 14.5px; color: #d7d4cc;
  }
  .cmo-check input { width: 19px; height: 19px; accent-color: #d97757; }
  /*
   * Which voice reads the message. A select, unlike the conversation list below:
   * this is one short label per option and there are a dozen of them, which is
   * what a native picker is for — and on a phone it opens as the platform's own
   * wheel rather than as a list to scroll past.
   */
  .cmo-voice {
    display: flex; align-items: center; gap: 9px;
    margin: 10px 0 0; font-size: 14px; color: #a8a49b;
  }
  .cmo-voice select {
    flex: 1 1 auto; min-width: 0;
    background: #272725; color: #f5f4ef;
    border: 1px solid #34342f; border-radius: 10px; padding: 9px 10px;
    /* 16px minimum or iOS zooms the page and never zooms back. */
    font: 16px/1.3 inherit;
  }

  /*
   * Docked to the TOP, for the same reason the bar is docked to the left: the
   * bottom right is Claude's own send/stop control, and the left edge is the bar.
   * Centred and narrow, so it reads as a notification rather than as chrome, and
   * it is removed from the DOM when it has nothing to say.
   */
  #cmo-chip {
    position: fixed; z-index: 2147483000;
    top: max(6px, env(safe-area-inset-top));
    left: 50%; transform: translateX(-50%);
    max-width: min(92vw, 460px);
    display: flex; align-items: center; gap: 8px;
    padding: 9px 13px; border-radius: 999px; border: none;
    background: rgba(30,30,28,.94); color: #f5f4ef;
    font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    box-shadow: 0 2px 12px rgba(0,0,0,.45);
    cursor: pointer; text-align: left;
    -webkit-tap-highlight-color: transparent; touch-action: manipulation;
  }
  #cmo-chip.cmo-gone { opacity: 0; pointer-events: none; transition: opacity .4s; }
  /* Two lines at most, and the second one only when there is something for it: see
     showChip. A column so the dot stays centred against both of them. */
  .cmo-chip-lines { min-width: 0; display: flex; flex-direction: column; }
  .cmo-chip-text {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .cmo-chip-note {
    display: none;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: #a8a49b; font-size: 11.5px;
  }
  .cmo-chip-note.cmo-on { display: block; }
  .cmo-dot {
    flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%;
    background: #6db26d;
  }
  .cmo-dot.cmo-busy { background: #d97757; animation: cmo-blink 1.2s infinite; }
  /* A question is not work in progress and must not look like it: steady, not
     blinking, and the colour the sheet uses for something waiting on a person. */
  .cmo-dot.cmo-ask { background: #e6a23c; animation: none; }
  @keyframes cmo-blink { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
  /*
   * The question itself, when one is waiting. Shaped like .cmo-said — it is the same
   * kind of thing, something Claude wrote that has to be read — with the option labels
   * under it as a list, because the labels are usually the whole of the decision.
   */
  .cmo-ask-block {
    margin: 10px 0 0; padding: 12px; border-radius: 12px;
    background: #2b2823; color: #f5f4ef; font: 14px/1.5 inherit;
    box-shadow: inset 0 0 0 1px #4a4132; overflow-wrap: anywhere;
  }
  .cmo-ask-head {
    font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
    color: #e6a23c; margin: 0 0 4px;
  }
  .cmo-ask-q { margin: 0; white-space: pre-wrap; }
  .cmo-ask-opts { margin: 8px 0 0; padding-left: 20px; color: #d7d4cc; font-size: 13.5px; }
  .cmo-ask-opts li { margin: 0 0 3px; }
  .cmo-ask-block + .cmo-ask-block { margin-top: 8px; }
  .cmo-said {
    margin: 10px 0 0; padding: 12px; border-radius: 12px;
    background: #272725; color: #f5f4ef;
    font: 14px/1.5 inherit; overflow-wrap: anywhere;
    max-height: 46vh; overflow-y: auto;
  }
  /*
   * Claude's message is markdown, and it is rendered rather than shown as its
   * source — see renderMarkdown. The block elements below carry the spacing, so the
   * container no longer preserves newlines; the paragraphs and list items still do,
   * because a table or a diagram written without a fence has a shape, and losing it
   * is the one thing the plain-text version was already getting right.
   */
  .cmo-said p, .cmo-said li { white-space: pre-wrap; margin: 0 0 8px; }
  .cmo-said ul, .cmo-said ol { margin: 0 0 8px; padding-left: 22px; }
  .cmo-said li { margin: 0 0 4px; }
  .cmo-said > :last-child { margin-bottom: 0; }
  .cmo-said strong { color: #fff; }
  .cmo-said a { color: #d97757; }
  .cmo-said hr { border: none; border-top: 1px solid #34342f; margin: 10px 0; }
  .cmo-md-h { font-weight: 600; color: #fff; margin: 12px 0 6px; white-space: pre-wrap; }
  .cmo-said code {
    background: #1f1f1d; border-radius: 5px; padding: 1px 4px;
    font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  /* A fenced block scrolls sideways rather than wrapping: code you have to push
     along is better than code that wraps, and a wrapped diff is unreadable. */
  .cmo-said pre {
    margin: 0 0 8px; padding: 10px; border-radius: 8px; background: #1f1f1d;
    overflow-x: auto; white-space: pre;
  }
  .cmo-said pre code { background: none; padding: 0; }
  /*
   * A table scrolls sideways as a unit, and its cells do not wrap.
   *
   * Three columns of prose will not fit across a phone, and the two ways out are
   * wrapping every cell — which turns a comparison into a wall and loses the
   * alignment that made it a table — or pushing it along. Pushing it along keeps
   * rows readable, so the wrapper scrolls and the cells stay on one line.
   */
  .cmo-md-table { margin: 0 0 8px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .cmo-said table { border-collapse: collapse; font-size: 12.5px; }
  .cmo-said th, .cmo-said td {
    border: 1px solid #34342f; padding: 4px 8px; text-align: left; white-space: nowrap;
  }
  .cmo-said th { color: #fff; font-weight: 600; background: #1f1f1d; }
  /* A heading for a section part-way down a sheet, where .cmo-title is the sheet's
     own heading and carries the spacing for the top of it. */
  .cmo-section {
    font-size: 13px; text-transform: uppercase; letter-spacing: .06em;
    color: #a3a099; margin: 16px 0 0;
  }
  /*
   * The prompt this conversation began with, shown as what it is: text somebody
   * typed. Deliberately not .cmo-said, which renders markdown — this is not a
   * message to read but a message to copy, so every character of it stays as it was
   * written, newlines included. Capped and scrollable because an opening prompt is
   * sometimes a page long and the sheet has other things below it.
   */
  .cmo-first {
    margin: 6px 0 0; padding: 12px; border-radius: 12px;
    background: #272725; color: #d7d4cc;
    font: 13.5px/1.5 inherit; white-space: pre-wrap; overflow-wrap: anywhere;
    max-height: 26vh; overflow-y: auto;
  }
  /*
   * What the spoken conversation is not — the one line on that sheet that must not be
   * skimmed, so it is not a .cmo-hint. A voice that cannot act is indistinguishable by
   * ear from one that can, and the difference matters the moment somebody says "push
   * that".
   */
  .cmo-warn {
    margin: 0 0 10px; padding: 10px 12px; border-radius: 12px;
    background: #2b211c; border: 1px solid #5a3a2a; color: #e8cfc2;
    font-size: 12.5px; line-height: 1.45;
  }
  /* What was said, both halves of it. Scrollable and kept at the bottom: the newest
     line is the one being spoken. */
  .cmo-talk-log { margin: 8px 0 0; max-height: 34vh; overflow-y: auto; }
  .cmo-talk-line {
    margin: 0 0 6px; font-size: 13.5px; line-height: 1.45;
    white-space: pre-wrap; overflow-wrap: anywhere;
  }
  /* Dimmed while it is still being heard: a half-heard sentence shown as final is how
     you end up certain it said something it did not. */
  .cmo-talk-line.cmo-partial { color: #a3a099; }
  .cmo-talk-line .cmo-who {
    display: inline-block; margin-right: 6px; color: #d97757;
    font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
  }
  /*
   * The other conversations in this project. Rows rather than a select, because
   * each one carries three things — what it is, what it is doing, and how long ago
   * — and because a thumb has to hit it on a phone.
   */
  .cmo-convos { margin: 6px 0 0; max-height: 34vh; overflow-y: auto; }
  .cmo-convo {
    width: 100%; display: grid; gap: 2px 8px;
    grid-template-columns: auto 1fr; align-items: baseline;
    margin: 6px 0 0; padding: 9px 11px; border: none; border-radius: 10px;
    background: #272725; color: #f5f4ef; text-align: left; cursor: pointer;
    font: 13px/1.4 inherit;
  }
  .cmo-convo.cmo-current { background: #34332f; box-shadow: inset 0 0 0 1px #d97757; }
  .cmo-convo-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cmo-convo-meta { grid-column: 2; color: #a8a49b; font-size: 12px; }
  .cmo-convo-back { grid-template-columns: 1fr; color: #a8a49b; }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ------------------------------------------------------------- scaffolding
  const fab = document.createElement('div');
  fab.id = 'cmo-fab';
  fab.innerHTML = `
    <button class="cmo-btn cmo-secondary" id="cmo-layout" aria-label="Fix the layout">&#10038;</button>
    <button class="cmo-btn cmo-secondary" id="cmo-projects" aria-label="Switch project">&#9707;</button>
    <button class="cmo-btn cmo-secondary" id="cmo-status" aria-label="Is Claude working?">&#9673;</button>
    <button class="cmo-btn cmo-secondary" id="cmo-terminal" aria-label="Terminal">&#10095;</button>
    <button class="cmo-btn" id="cmo-mic" aria-label="Dictate">&#127908;</button>`;
  document.body.appendChild(fab);

  /*
   * Held, not looked up by id. The dictation sheet has a `<p id="cmo-status">` of
   * its own, so `document.getElementById('cmo-status')` answers with whichever
   * comes first in document order — the bar, today, by luck of the append order.
   * This button is repainted while speech is playing, and picking the wrong
   * element for that would put a Stop control inside the dictation sheet.
   */
  const statusBtn = fab.querySelector('#cmo-status');

  // The chip is created here but only inserted when there is something to say;
  // an empty pill across the top of the editor is worse than no chip at all.
  const chip = document.createElement('button');
  chip.id = 'cmo-chip';
  chip.type = 'button';
  chip.innerHTML =
    '<span class="cmo-dot"></span>' +
    '<span class="cmo-chip-lines">' +
    '<span class="cmo-chip-text"></span><span class="cmo-chip-note"></span></span>';
  const chipDot = chip.querySelector('.cmo-dot');
  const chipText = chip.querySelector('.cmo-chip-text');
  const chipNote = chip.querySelector('.cmo-chip-note');

  const sheet = document.createElement('div');
  sheet.id = 'cmo-sheet';
  sheet.innerHTML = '<div class="cmo-panel" id="cmo-panel"></div>';
  document.body.appendChild(sheet);

  const panel = sheet.querySelector('#cmo-panel');
  sheet.addEventListener('click', (e) => {
    if (e.target !== sheet) return;
    /*
     * A drag that selects text in the panel and finishes past its edge arrives here
     * as a click on the *backdrop* — the two ends of it share no closer ancestor —
     * and closing on it throws away the selection the drag just made, which is the
     * one thing the drag was for. A plain tap beside the sheet still dismisses it:
     * a pointer going down outside a selection collapses it before this fires.
     */
    if (selectionInPanel()) return;
    closeSheet();
  });

  /**
   * Is somebody part-way through selecting something on the sheet?
   *
   * Asked before anything dismisses or redraws it. A redraw replaces the nodes the
   * selection points at, so the selection goes with them — and this sheet redraws
   * itself every few seconds while it follows a turn, which is exactly when someone
   * is reading the answer they want a line out of.
   */
  function selectionInPanel() {
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed) return false;
    // `contains(null)` is false, which is the answer for a selection with no anchor.
    return panel.contains(selection.anchorNode) || panel.contains(selection.focusNode);
  }

  /*
   * Which sheet is on screen, counted rather than named.
   *
   * Three buttons close the sheet a beat *after* they act, so their confirmation
   * ("Copied — paste into Claude") can be read before it disappears. That delay
   * outlives the sheet it belongs to: tap Copy and then open the status sheet
   * within the same second, and the pending close dismisses the sheet you just
   * opened. Every one of those buttons is on a bar that is always on screen, so
   * that second tap is not a strange thing to do.
   */
  let sheetGeneration = 0;

  /**
   * Put a sheet on screen.
   *
   * `keepTalking` is for the one sheet that is itself a live spoken conversation:
   * every other sheet drawn over this panel hangs up first. That is not tidiness. The
   * talk sheet holds the clock and the Hang up button, so a sheet drawn over it would
   * leave a paid microphone open behind a panel with no visible end to it — and the
   * sheet is dismissed by tapping beside it, which is not a deliberate act.
   */
  function openSheet(html, { keepTalking = false } = {}) {
    if (!keepTalking) endTalk();
    sheetGeneration += 1;
    panel.innerHTML = html;
    sheet.classList.add('cmo-open');
  }
  function closeSheet() {
    sheet.classList.remove('cmo-open');
    stopRecognition();
    // Closing hangs up. Every other way out of a spoken conversation is in the talk
    // section; this is the one that belongs to the sheet, and it covers the tap beside
    // it as well as the Close button.
    endTalk();
    // Dismissing the status sheet is how you stop it following the conversation
    // and reading out what arrives; see followStatusSheet.
    stopSheetPoll();
  }
  /** Close after `ms`, unless a different sheet has been opened by then. */
  function closeSheetLater(ms) {
    const generation = sheetGeneration;
    setTimeout(() => {
      if (generation === sheetGeneration) closeSheet();
    }, ms);
  }

  // ------------------------------------------------------------- dictation
  let recognition = null;
  // Split so a mid-dictation session restart can't re-append old phrases:
  // `committedText` holds finals from ended sessions, `liveText` the current one.
  let committedText = '';
  let liveText = '';

  /*
   * Which dictation the work in flight belongs to.
   *
   * Reset has to be able to say "nothing that was already running may write text
   * into this box again", and three things here cannot be called back: an upload
   * already at /api/transcribe, a cleanup pass already at /api/polish, and a
   * getUserMedia permission prompt the user has not answered yet. Each of those
   * continuations captures this counter on the way in and drops its result if the
   * counter has moved since. Without it, a reset looks like it worked and then the
   * old words reappear a second later — which is the bug this button exists for.
   */
  let dictationGeneration = 0;
  // The fallback path's recorder and microphone, held so a reset can release them.
  let activeRecorder = null;
  let activeStream = null;

  /**
   * Append a phrase, dropping leading words that repeat the accumulated tail.
   *
   * Rebuilding from `event.results` stopped whole-transcript re-appends, but not
   * every duplicate: chunks carry no separator, so "sounds" then "sounds" glues
   * into "soundssounds", and a phrase re-delivered across a session boundary
   * isn't in the list we re-read. Comparing words against the tail catches both.
   *
   * Cost: a deliberate immediate repetition ("very very") collapses to one.
   * Worth it against duplication that made dictation unusable.
   */
  function appendPhrase(acc, phrase) {
    const head = acc.trim().split(/\s+/).filter(Boolean);
    const tail = phrase.trim().split(/\s+/).filter(Boolean);
    if (!tail.length) return head.join(' ');

    // Longest overlap first, so a multi-word repeat collapses in one step.
    for (let n = Math.min(head.length, tail.length); n > 0; n--) {
      const end = head.slice(head.length - n).join(' ').toLowerCase();
      const start = tail.slice(0, n).join(' ').toLowerCase();
      if (end === start) {
        tail.splice(0, n);
        break;
      }
    }
    return [...head, ...tail].join(' ');
  }

  function stopRecognition() {
    if (recognition) {
      try {
        recognition.onend = null;
        recognition.stop();
      } catch {
        /* already stopped */
      }
      recognition = null;
    }
    document.getElementById('cmo-mic')?.classList.remove('cmo-rec');
  }

  /**
   * Drop the fallback recorder and hand the microphone back.
   *
   * `recorder.stop()` alone is not enough for a reset: `onstop` is where the upload
   * and the append live, so the handler is unhooked first — the point is to end the
   * recording, not to transcribe it. The tracks are stopped explicitly because the
   * recorder releasing its own reference does not turn off the phone's mic light.
   */
  function stopRecording() {
    if (activeRecorder) {
      try {
        activeRecorder.ondataavailable = null;
        activeRecorder.onstop = null;
        if (activeRecorder.state !== 'inactive') activeRecorder.stop();
      } catch {
        /* already finished */
      }
      activeRecorder = null;
    }
    if (activeStream) {
      try {
        activeStream.getTracks().forEach((t) => t.stop());
      } catch {
        /* already ended */
      }
      activeStream = null;
    }
  }

  /*
   * Dictated text is the most expensive thing on this surface. The Claude panel is
   * a sandboxed iframe, so it cannot be typed into from out here — the words have
   * to sit in this textarea until they are copied across, and that is exactly when
   * the workbench is most likely to reload underneath them: its lifecycle service
   * reloads the window whenever the browser restores the page from the back/forward
   * cache, which on a phone means every time you switch apps and come back. A
   * paragraph of speech has no backup anywhere, so it is written down as it is
   * spoken.
   */
  const DICTATION_KEY = 'cmo-dictation-draft';
  const DICTATION_MAX_AGE = 60 * 60 * 1000;
  let dictationTimer = null;
  let pendingDictation = null;

  function writeDictation() {
    clearTimeout(dictationTimer);
    dictationTimer = null;
    if (pendingDictation === null) return;
    const text = pendingDictation;
    pendingDictation = null;
    try {
      if (text.trim()) {
        localStorage.setItem(DICTATION_KEY, JSON.stringify({ text, at: Date.now() }));
      } else {
        localStorage.removeItem(DICTATION_KEY);
      }
    } catch {
      /* private mode: the words are still on screen, which is where they were */
    }
  }

  // Debounced, because the recognizer rewrites the whole textarea on every interim
  // result — several times a second while someone is talking.
  function saveDictation(text) {
    pendingDictation = text;
    if (!dictationTimer) dictationTimer = setTimeout(writeDictation, 400);
  }

  function clearDictation() {
    clearTimeout(dictationTimer);
    dictationTimer = null;
    pendingDictation = null;
    try {
      localStorage.removeItem(DICTATION_KEY);
    } catch {
      /* nothing was stored either */
    }
  }

  function loadDictation() {
    try {
      const saved = JSON.parse(localStorage.getItem(DICTATION_KEY) || 'null');
      if (saved?.text && Date.now() - (saved.at || 0) < DICTATION_MAX_AGE) return saved.text;
    } catch {
      /* unreadable: treat as nothing saved */
    }
    return '';
  }

  /*
   * The same cleanup pass the chat composer runs, for the same reason: what comes
   * out of either recognizer has no punctuation, no capitals and mangled product
   * names, and here it is on its way to the clipboard rather than into a box you
   * can tidy up by hand. Server side is /api/polish (see chat-service/polish.js).
   *
   * The switch is the chat app's key, read on use rather than cached: one origin,
   * one setting, and the chat may have flipped it in another tab since this
   * workbench loaded.
   */
  const POLISH_KEY = 'claude-polish-dictation';
  const POLISH_TIMEOUT_MS = 6000;

  function polishWanted() {
    try {
      return localStorage.getItem(POLISH_KEY) !== '0';
    } catch {
      return true;
    }
  }

  /** The cleaned-up text, or '' if there is nothing better than what came in. */
  async function polishText(text) {
    if (!polishWanted() || text.split(/\s+/).filter(Boolean).length < 3) return '';
    try {
      const res = await fetch('/api/polish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        // The route answers with the raw text rather than an error when Bedrock is
        // slow, so this bound is only for a request that never arrives at all.
        signal: AbortSignal.timeout?.(POLISH_TIMEOUT_MS),
      });
      // Includes 401 — the chat service's session, not code-server's password.
      // Nothing to say about it here: the text is already copied.
      if (!res.ok) return '';
      const data = await res.json();
      return data.changed && data.text ? String(data.text) : '';
    } catch {
      return '';
    }
  }

  /**
   * Put a selection around an element's text, so the platform's own Copy can take
   * it. The textarea in the dictation sheet has `select()` for this; a block of
   * text that is not an input needs a range.
   */
  function selectText(el) {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    } catch {
      return false; // a detached node, or no selection API
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Needs a secure context, and can still be refused.
      return false;
    }
  }

  /*
   * Start dictation over from nothing.
   *
   * The complaint this answers: dictation "remembers something", and clearing the
   * box by hand and speaking again does not get rid of it. It cannot, because none
   * of the state that puts the words back is in the box. It is `committedText`
   * (which openDictation deliberately seeds from the saved draft so a reload does
   * not lose a paragraph), `liveText`, the draft in localStorage, and whatever is
   * still in flight to the server. So this releases the microphone, forgets all
   * four, and leaves the mic off — "Restart mic" then starts from an empty box.
   *
   * It is its own button and not a long-press on the mic on purpose: it is reached
   * when dictation is already not behaving, and the mic is the control that is
   * already not doing what was expected. What it throws away is offered back as
   * Undo for a few seconds, because a paragraph of speech exists nowhere else.
   */
  const RESET_UNDO_MS = 15000;
  let resetUndo = null;
  let resetUndoTimer = null;

  function resetDictation(textarea, status) {
    dictationGeneration += 1;
    stopRecognition();
    stopRecording();
    committedText = '';
    liveText = '';
    clearDictation();

    const wiped = textarea ? textarea.value : '';
    if (textarea) {
      textarea.value = '';
      textarea.focus();
    }

    clearTimeout(resetUndoTimer);
    resetUndo = wiped.trim() ? wiped : null;
    if (!status) return;
    status.textContent = wiped.trim()
      ? 'Reset — mic released, transcript forgotten, box cleared.'
      : 'Reset — mic released, nothing left to forget.';
    if (!resetUndo) return;

    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'cmo-undo';
    undo.id = 'cmo-undo';
    undo.textContent = 'Undo';
    status.classList.add('cmo-status-undo');
    status.appendChild(undo);
    undo.addEventListener('click', () => {
      if (resetUndo === null) return;
      /*
       * `committedText` as well as the box, because the recognizer rewrites the
       * whole textarea from it on every result: restoring only what is on screen
       * would put the words back and then have the next sentence spoken wipe them
       * again. The mic stays off and the orphaned uploads stay orphaned — a reset
       * cannot be taken back, only the text can.
       */
      if (textarea) {
        textarea.value = resetUndo;
        committedText = resetUndo;
        saveDictation(textarea.value);
        textarea.focus();
      }
      resetUndo = null;
      clearTimeout(resetUndoTimer);
      status.textContent = 'Text restored — tap Restart mic to carry on.';
    });
    resetUndoTimer = setTimeout(() => {
      resetUndo = null;
      undo.remove();
    }, RESET_UNDO_MS);
  }

  function openDictation() {
    // Restored into `committedText`, not just the textarea: that is what the
    // recognizer appends to, so dictation carries on from the recovered text
    // instead of overwriting it on the first result.
    committedText = loadDictation();
    liveText = '';
    openSheet(`
      <p class="cmo-title">Dictate</p>
      <textarea id="cmo-text" placeholder="${
        SpeechRecognition ? 'Listening… speak now' : 'Type or paste here'
      }"></textarea>
      <p class="cmo-status" id="cmo-status"></p>
      <div class="cmo-row">
        <button class="cmo-action" id="cmo-copy">Copy &amp; close</button>
        <button class="cmo-action cmo-alt" id="cmo-again">Restart mic</button>
        <button class="cmo-action cmo-alt" id="cmo-reset"
                title="Release the mic, forget the transcript, clear the box">Reset</button>
        <button class="cmo-action cmo-alt" id="cmo-cancel">Cancel</button>
      </div>
      <p class="cmo-hint">Copy puts the text on the clipboard — long-press Claude's
      input and paste. The panel is a sandboxed iframe, so it can't be typed into
      from here.</p>`);

    const textarea = panel.querySelector('#cmo-text');
    const status = panel.querySelector('#cmo-status');
    textarea.value = committedText;
    if (committedText) status.textContent = 'Recovered what you dictated before.';
    textarea.focus();
    textarea.addEventListener('input', () => saveDictation(textarea.value));

    // Cancel is a decision to throw the text away. Dismissing the sheet by tapping
    // outside it is not, so that path keeps the draft — on a phone the two are one
    // stray tap apart.
    panel.querySelector('#cmo-cancel').addEventListener('click', () => {
      clearDictation();
      closeSheet();
    });
    // Restart keeps the words and gives the recognizer another go — the fix for a
    // session that has stopped hearing anything. Reset, below, is the other half:
    // the words are the problem.
    panel.querySelector('#cmo-again').addEventListener('click', () => {
      stopRecognition();
      stopRecording();
      startDictation(textarea, status);
    });
    panel.querySelector('#cmo-reset').addEventListener('click', () => {
      resetDictation(textarea, status);
    });
    panel.querySelector('#cmo-copy').addEventListener('click', async () => {
      const gen = dictationGeneration;
      const raw = textarea.value.trim();
      if (!raw) return closeSheet();

      /*
       * Copy the raw text first, then punctuate and copy again.
       *
       * The order matters twice over. The copy is the handover — it is the only way
       * text leaves this sheet — so it must not wait on a network round trip that
       * can fail, and a clipboard write issued after an `await` is refused outright
       * on iOS. Doing it in the tap means the worst case is unpunctuated text on
       * the clipboard, which is what this sheet did before, rather than nothing.
       */
      if (!(await copyText(raw))) {
        // Selecting the text lets the user copy with the native control instead.
        textarea.select();
        status.textContent = 'Press Copy on the selection.';
        return;
      }
      status.textContent = 'Copied — paste into Claude.';

      const cleaned = await polishText(raw);
      // Reset while the cleanup pass was out. The clipboard already has the raw
      // text and that is the user's, but the box has been deliberately emptied —
      // putting a punctuated version of the old dictation back into it is exactly
      // the "it remembers something" the reset was tapped to stop.
      if (gen !== dictationGeneration) return;
      if (cleaned && cleaned !== raw) {
        // Shown as well as copied: the user is about to paste it, and finding
        // something they did not see arrive in Claude's input is worse than a
        // second of delay.
        textarea.value = cleaned;
        if (await copyText(cleaned)) {
          status.textContent = 'Copied, punctuated — paste into Claude.';
        } else {
          // The raw text is on the clipboard and the better version is only on
          // screen, so this one is still the user's to copy — and still worth
          // keeping if the workbench reloads before they do.
          saveDictation(cleaned);
          writeDictation();
          textarea.select();
          status.textContent = 'Punctuated — press Copy on the selection.';
          return;
        }
      }
      // On the clipboard now, which outlives the page: the copy is the handover,
      // so keeping a second copy here would only resurface it next time.
      clearDictation();
      closeSheetLater(700);
    });

    startDictation(textarea, status);
  }

  function startDictation(textarea, status) {
    /*
     * A microphone is about to go live, so stop talking.
     *
     * Both dictation paths come through here — the recognizer and the whisper
     * recorder — which makes this the one place that has to know. Left playing,
     * the recognizer transcribes Claude's own reply into the composer and the
     * recorder uploads it to be transcribed; either way the user's next message
     * is Claude quoting itself.
     */
    stopSpeech();
    if (!SpeechRecognition) {
      status.textContent = 'Live dictation unavailable — recording instead.';
      recordAndTranscribe(textarea, status);
      return;
    }

    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true; // this is what makes words appear while speaking
    rec.lang = navigator.language || 'en-US';

    /*
     * Rebuild the text from `event.results` on every event rather than
     * accumulating.
     *
     * The old code did `finalText += chunk` from `event.resultIndex` onward.
     * That works on desktop, where recognition runs as one continuous session.
     * On mobile Safari the session ends on brief pauses and is restarted (see
     * onend below); each restart begins a fresh `results` list with
     * resultIndex back at 0, so every already-final phrase was appended again —
     * words showing up three or four times.
     *
     * `results` is authoritative for the current session, so read it whole and
     * keep finals from previous sessions in `committedText`, which only grows
     * when a session actually ends.
     */
    rec.onresult = (event) => {
      // A stopped recognizer can still deliver one more result. After a reset that
      // is a whole phrase landing in a box that was just emptied.
      if (recognition !== rec) return;
      let sessionFinal = '';
      let interim = '';
      for (let i = 0; i < event.results.length; i++) {
        const chunk = event.results[i][0].transcript;
        if (event.results[i].isFinal) sessionFinal = appendPhrase(sessionFinal, chunk);
        else interim = appendPhrase(interim, chunk);
      }
      liveText = sessionFinal;
      const joined = appendPhrase(
        appendPhrase(committedText, sessionFinal),
        interim,
      );
      textarea.value = joined.replace(/\s+/g, ' ').trimStart();
      saveDictation(textarea.value);
    };

    rec.onerror = (event) => {
      if (recognition !== rec) return;
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        status.textContent = 'Microphone permission denied.';
        stopRecognition();
        return;
      }
      // network / language-not-supported: fall back to server transcription.
      status.textContent = 'Live dictation failed — recording instead.';
      stopRecognition();
      recordAndTranscribe(textarea, status);
    };

    // Mobile Safari ends the session on brief pauses; restart while active.
    // Commit what this session finalised *before* restarting, because the new
    // session's `results` list starts empty and would otherwise lose it.
    rec.onend = () => {
      if (recognition !== rec) return;
      if (liveText.trim()) {
        committedText = appendPhrase(committedText, liveText);
        liveText = '';
      }
      try {
        rec.start();
      } catch {
        stopRecognition();
      }
    };

    recognition = rec;
    document.getElementById('cmo-mic')?.classList.add('cmo-rec');
    status.textContent = 'Listening…';
    try {
      rec.start();
    } catch {
      status.textContent = 'Could not start the microphone.';
      stopRecognition();
    }
  }

  /** Fallback: record audio and transcribe on the server (whisper.cpp). */
  async function recordAndTranscribe(textarea, status) {
    const gen = dictationGeneration;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      status.textContent = `Microphone blocked: ${err.message}`;
      return;
    }
    // The permission prompt is modal and answered by a human, so a reset can land
    // while it is on screen. Hand the microphone straight back rather than opening
    // a recording nobody asked for.
    if (gen !== dictationGeneration) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    const chunks = [];
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    activeRecorder = recorder;
    activeStream = stream;

    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      if (activeRecorder === recorder) {
        activeRecorder = null;
        activeStream = null;
      }
      status.textContent = 'Transcribing…';
      try {
        const wav = await toWav(new Blob(chunks, { type: recorder.mimeType }));
        const form = new FormData();
        form.append('audio', wav, 'recording.wav');
        const res = await fetch('/api/transcribe', { method: 'POST', body: form });
        // Transcription lives behind the chat service's session, which is
        // separate from code-server's password. Say so plainly instead of
        // reporting a bare "authentication required" that looks like a bug.
        if (res.status === 401) {
          throw new Error('Sign in first — tap the project switcher.');
        }
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'transcription failed');
        // An upload cannot be recalled, so the reset's only defence is to refuse
        // its answer. This is the continuation that made a reset look temporary:
        // the box emptied, and a sentence arrived in it seconds later.
        if (gen !== dictationGeneration) return;
        textarea.value = (textarea.value ? textarea.value + ' ' : '') + data.text;
        status.textContent = 'Transcribed.';
      } catch (err) {
        if (gen !== dictationGeneration) return;
        status.textContent = err.message;
      }
    };

    recorder.start();
    status.textContent = 'Recording — tap the mic to stop.';
    const mic = document.getElementById('cmo-mic');
    mic?.classList.add('cmo-rec');
    const stop = () => {
      mic?.classList.remove('cmo-rec');
      if (recorder.state !== 'inactive') recorder.stop();
      mic?.removeEventListener('click', stop);
    };
    mic?.addEventListener('click', stop, { once: true });
  }

  /**
   * Browsers record webm/opus; the server's whisper.cpp decodes
   * WAV/MP3/FLAC/Vorbis but not Opus, and AL2023 ships no ffmpeg. The browser
   * already has an Opus decoder, so convert here. 16 kHz mono is also exactly
   * what Whisper wants, which shrinks the upload.
   */
  async function toWav(blob) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      const rate = 16000;
      const offline = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
        1, Math.ceil(decoded.duration * rate), rate,
      );
      const src = offline.createBufferSource();
      src.buffer = decoded;
      src.connect(offline.destination);
      src.start();
      const out = await offline.startRendering();
      const samples = out.getChannelData(0);

      const buf = new ArrayBuffer(44 + samples.length * 2);
      const view = new DataView(buf);
      const str = (off, s) => {
        for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
      };
      str(0, 'RIFF');
      view.setUint32(4, 36 + samples.length * 2, true);
      str(8, 'WAVE');
      str(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, rate, true);
      view.setUint32(28, rate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      str(36, 'data');
      view.setUint32(40, samples.length * 2, true);
      for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
      return new Blob([buf], { type: 'audio/wav' });
    } finally {
      ctx.close();
    }
  }

  // -------------------------------------------------- a window per project
  /**
   * The project a workspace folder belongs to: its last path segment, which is the
   * name the rest of the service validates and lists. `folder()` — declared with
   * the status chip below, and hoisted — is the one reader of `?folder=`.
   */
  function projectOf(path) {
    return path ? path.replace(/\/+$/, '').split('/').pop() : '';
  }

  /**
   * Where a project opens: /p/<name>/?folder=<path>.
   *
   * The path segment is what lets a project be an installable app of its own — a
   * manifest's scope is a path prefix and scope matching ignores the query, so while
   * every project lived at /editor/?folder=… they were all one app to Android and
   * only the first would install. The query is still here because it is what
   * code-server reads to open the folder, and what `folder()` reads to know which
   * project this window is. Both halves must agree, so they are built together, here
   * and in chat-service/manifest.js — which is also where the reasoning is written
   * down. The route is in infra/userdata/bootstrap.sh.
   */
  function projectWindowPath(project) {
    return `/p/${encodeURIComponent(project)}/`;
  }

  function projectHref(path) {
    return `${projectWindowPath(projectOf(path))}?folder=${encodeURIComponent(path)}`;
  }

  /**
   * The project this window's *path* names, or '' for a page that is not one.
   *
   * The path is the authority on which app this page belongs to, and `?folder=` is
   * not: an install is decided by scope, scope is a path prefix, and the query can go
   * missing without the window changing. It does go missing — code-server answers a
   * request it has no password cookie for with `./login?folder=…&to=`, and `to` comes
   * back empty, so what survives that round trip is the project's path and no query.
   * A window in that state is still the project's window, and reading only `?folder=`
   * made it look like no project at all — which is how it came to link code-server's
   * own manifest instead of this project's. See linkProjectManifest.
   */
  function projectFromWindow() {
    const match = /^\/p\/([^/]+)\//.exec(location.pathname);
    if (!match) return '';
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1]; // not valid percent-encoding, so not a name the server will take
    }
  }

  /**
   * Whether an install can be offered here at all.
   *
   * A project's manifest is scoped to /p/<name>/, and a browser only offers to install
   * the app a page links while the page is *inside* that app's scope. So the editor's
   * other addresses — /editor/?folder=…, or the catch-all — can link a project's
   * manifest and still get silence, which from the outside is indistinguishable from
   * "already installed". addToHomeScreen walks out of that rather than explaining it.
   */
  function inProjectWindow(project) {
    return !!project && location.pathname.startsWith(projectWindowPath(project));
  }

  /**
   * The project this window is in, by whichever half of the address still says so.
   *
   * The path first, because it is the half that decides which app the page belongs to
   * and the half that survives code-server's login round trip. `?folder=` second,
   * because /editor/?folder=… is a project's window in every sense except the one
   * that matters to an install. Everything that offers or explains the install reads
   * this, so /p/<name>/ with no query is not mistaken for an empty window — that page
   * used to render no install button at all, which is the state a phone lands in
   * after signing in to code-server again and the state the report came from.
   */
  function thisWindowsProject() {
    return projectFromWindow() || projectOf(folder());
  }

  /*
   * A home-screen icon for this project, which on Android is the only way to give
   * a project a window of its own.
   *
   * Chrome gives an installed web app exactly one window on a phone — its own docs
   * say mobile "only support single clients" where desktop "support multiple
   * windows" — and no API opens a second one. What does work is app *identity*: a
   * manifest with an unfamiliar `id` describes a distinct application "even if it
   * is served from the same URL as another application", and a distinct
   * application on Android is a distinct icon with its own task in the recents
   * switcher. So the way to get project B beside project A is to install project
   * B's manifest, once.
   *
   * The link has to be in this document, because the manifest a browser installs
   * is the one linked from the page you install *from* — and this page is
   * code-server's, which ships no manifest of its own. `use-credentials` is not
   * optional: a manifest is fetched with credentials omitted by default, and the
   * route serving it is behind the session gate like everything else.
   */
  function linkProjectManifest() {
    /*
     * Removed first, and whether or not this page turns out to name a project.
     *
     * code-server links a manifest of its own —
     * `<link rel="manifest" href="./manifest.json">` — and that file has no `id` and
     * no `scope`, so both default to the directory the link resolves in. On
     * /p/<name>/ that is *this project's identity*, under the name "code-server": an
     * install accepted while it is linked takes the identity this project's own
     * manifest asks for, and every attempt afterwards is answered "already
     * installed", for good, until the icon is removed. On /editor/ it is worse than
     * that — the identity is /editor/, which is the same for every project, so the
     * first project installs and all the others collide with it.
     *
     * Which is why this is not conditional on knowing the project. The old early
     * return left that link in place on exactly the pages that could not name one,
     * and those are the pages a phone arrives on after a lapsed code-server session.
     * nginx now rewrites the tag as it passes (see infra/userdata/bootstrap.sh), so
     * a browser never sees it even before this script runs; this is the half that
     * does not depend on a string in someone else's HTML staying put.
     */
    const project = thisWindowsProject();
    const wanted = project ? `/chat/manifest.webmanifest?project=${encodeURIComponent(project)}` : '';
    /*
     * nginx rewrites the tag in the response now, so on /p/<name>/ the link is
     * already the right one before this runs. Left alone in that case, deliberately:
     * removing a manifest link and appending an identical one restarts Chrome's
     * installability check, and the offer this whole feature waits for is the thing
     * that restart delays. Anything else goes, whether or not this page names a
     * project.
     */
    document.querySelectorAll('link[rel="manifest"]').forEach((el) => {
      if (el.getAttribute('href') !== wanted) el.remove();
    });
    if (!project) return; // an empty window belongs to no project
    if (document.querySelector(`link[rel="manifest"][href="${wanted}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'manifest';
    link.href = wanted;
    link.crossOrigin = 'use-credentials';
    document.head.appendChild(link);
  }

  /*
   * Chrome's own install prompt, kept for a button.
   *
   * `preventDefault` suppresses the mini-infobar so the offer appears where the
   * rest of the project controls are, instead of as a strip the workbench has no
   * room for. The event fires per page load and only while this project is not
   * installed — which is exactly the condition under which offering it is useful,
   * so its absence is the signal to fall back to the browser's menu.
   */
  let installPrompt = null;
  let offerWaiters = [];
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    const waiting = offerWaiters;
    offerWaiters = [];
    waiting.forEach((resolve) => resolve(event));
  });

  /** Whether this browser has the event at all — no iOS browser does. */
  function browserOffersInstalls() {
    return 'onbeforeinstallprompt' in window;
  }

  /**
   * The offer, if it turns up within `ms`, else null.
   *
   * It is worth waiting for because it is late rather than absent: Chrome fires it
   * once it has fetched and checked the manifest and its icons, and this page is the
   * workbench — about 24M of JavaScript on a cold load — so a phone can easily open
   * the switcher and tap before the offer exists. Short, because `prompt()` needs the
   * user activation from the tap that started this and transient activation does not
   * outlive a few seconds; a longer wait would trade a working install for a
   * NotAllowedError. What the wait cannot cover, armLateOffer does.
   */
  function waitForOffer(ms) {
    if (installPrompt) return Promise.resolve(installPrompt);
    return new Promise((resolve) => {
      offerWaiters.push(resolve);
      setTimeout(() => resolve(null), ms);
    });
  }

  /** Say so when a late offer arrives, because the next tap is all it needs. */
  function armLateOffer(project) {
    waitForOffer(120000).then((offer) => {
      const el = panel.querySelector('#cmo-install-status');
      if (!offer || !el) return;
      el.textContent = `Chrome is ready now: tap “Give ${project} its own window” again.`;
    });
  }

  linkProjectManifest();

  async function addToHomeScreen() {
    const status = panel.querySelector('#cmo-install-status');
    const say = (text) => {
      if (status) status.textContent = text;
    };
    const project = thisWindowsProject();
    if (!installPrompt) {
      /*
       * One reason is worth acting on rather than explaining: this page is not the
       * project's own window, so it is outside the scope of the manifest it links and
       * no browser will offer to install it. One tap lands on /p/<name>/, where the
       * offer exists; the alternative was a status line telling someone to navigate
       * themselves, which is the same two taps with a paragraph to read first.
       */
      if (project && !inProjectWindow(project)) {
        say(`Opening ${project} in its own window — ask again there.`);
        location.href = projectHref(folder());
        return;
      }
      /*
       * Otherwise wait for it, and say what is true if it does not come — but never
       * send anyone to the browser's own menu, which is where this feature was
       * reported broken from.
       *
       * On Android that menu cannot install a second app from one origin, and this is
       * not a manifest problem: Chrome decides which of "Install app" and "App
       * already installed" to show from WebappRegistry.isAppInstalledForUrl, which is
       * hasAtLeastOneWebApkForOrigin — *any* installed web app whose scope shares this
       * origin, whatever its id or scope. Install the chat app and every page on the
       * host reports as installed, projects included; the row's action becomes "open"
       * and the open finds no app that handles /p/<name>/, so it fails with a toast.
       * That is "it says it's already installed, and it will not open" exactly.
       *
       * What is not subject to that check is the page's own offer:
       * DoesNewWebAppConflictWithExistingInstallation asks whether an installed WebAPK
       * handles this manifest's start_url, which is scope-accurate, so
       * `beforeinstallprompt` still fires for a project beside the chat app. So the
       * button is the route, and waiting for it is the advice.
       */
      if (project && browserOffersInstalls()) {
        say('Waiting for the browser’s install offer…');
        if (!(await waitForOffer(1200))) {
          say(
            `No offer yet — the editor is still loading, and this will say so when it ` +
              `arrives. Don’t use Chrome’s own menu: once any app from this address is ` +
              `installed it calls every page here “already installed”, project windows ` +
              `included, and its Open does nothing. This button is not affected.`,
          );
          armLateOffer(project);
          return;
        }
      } else {
        // No such event in this browser — every iOS one, for a start. Safari's own
        // menu has no per-origin opinion, and the manifest is linked, so it installs
        // this project.
        say('Use the browser menu → “Add to Home screen”. It picks up this project.');
        return;
      }
    }
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      // One shot per page load: the event cannot be prompted twice.
      installPrompt = null;
      say(
        choice?.outcome === 'accepted'
          ? `${project} is on your home screen. It opens in its own window.`
          : 'Not added. This button can offer again after a reload.',
      );
    } catch (err) {
      say(`Could not add it: ${err.message}`);
    }
  }

  /*
   * Why the install offer is missing, answered by the device rather than guessed at.
   *
   * "It says this app is already installed" is the report this exists for, and it
   * cannot be reproduced anywhere but the phone that made it: whether Chrome offers
   * an install depends on what is already on that home screen. Android matches an
   * installed web app to a page by *scope*, and the chat app's manifest used to claim
   * the whole origin — so with the chat icon installed, every project manifest served
   * from this origin looked to Chrome like that same app, whatever its `id` said. The
   * chat app has since been narrowed to /chat/, but a WebAPK installed before that
   * still holds the old scope until Chrome updates it, so this remains the way to
   * find out rather than assume:
   *
   *   - the build of this file, because a page open across a deploy is the other
   *     explanation for a feature that appears to be missing;
   *   - which manifest this page links, and what the server says is in it;
   *   - whether this is a browser tab at all — an install can only be offered from
   *     one, so doing this from inside an installed window explains the silence;
   *   - whether Chrome fired `beforeinstallprompt` for this page;
   *   - which installed app Chrome thinks belongs to this page, via
   *     getInstalledRelatedApps(). It only answers about apps the manifest declares
   *     as related, which is why manifest.js declares the chat app.
   */
  async function explainInstall() {
    const say = (text) => {
      const el = panel.querySelector('#cmo-install-status');
      if (el) el.textContent = text;
    };
    say('Checking…');
    const lines = [`Overlay ${OVERLAY_BUILD}.`];

    const link = document.querySelector('link[rel="manifest"]');
    if (!link) {
      lines.push('This page links no manifest, so there is nothing here to install.');
    } else {
      lines.push(`Manifest: ${link.getAttribute('href')}`);
      try {
        const res = await fetch(link.href);
        if (!res.ok) {
          lines.push(
            `The server answered ${res.status} for it, so the browser sees no manifest` +
              (res.status === 401 ? ' — this is the chat service asking for its own sign-in.' : '.'),
          );
        } else {
          const m = await res.json();
          lines.push(`It describes “${m.short_name || m.name}”, id ${m.id}, scope ${m.scope}.`);
          /*
           * Whether this page is inside that scope, which decides whether an install
           * can be offered here at all. Now that a project's scope is /p/<name>/ and
           * not the whole origin, the editor's older addresses — /editor/?folder=…,
           * or the catch-all — are out of scope, and Chrome stays silent for a page
           * outside the app it links. That silence looks exactly like "already
           * installed", so it is worth telling apart from it.
           */
          if (m.scope && !location.pathname.startsWith(m.scope)) {
            lines.push(
              `This page is at ${location.pathname}, outside that scope, so no install can be ` +
                'offered here: open the project from the switcher and try again from there.',
            );
          }
        }
      } catch (err) {
        lines.push(`It could not be fetched: ${err.message}`);
      }
    }

    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches;
    lines.push(
      standalone
        ? 'This window is already an installed app, and an install is only ever offered from a browser tab — open this same address in Chrome to add another project.'
        : 'This is a browser tab, which is where an install can be offered.',
    );
    lines.push(
      installPrompt
        ? 'Chrome has offered to install this project: the button above will do it.'
        : 'Chrome has not offered to install this page yet. It stays silent for a page ' +
          'outside the scope of the manifest it links, for an app already installed at ' +
          'this exact identity, and for the seconds before it has finished reading the ' +
          'manifest and its icons — the lines above say which. The button waits for it.',
    );

    if (navigator.getInstalledRelatedApps) {
      try {
        const apps = await navigator.getInstalledRelatedApps();
        /*
         * Read this precisely: the answer is about the apps *this manifest declares as
         * related*, which is the chat app and nothing else (manifest.js). A non-empty
         * answer means the chat app is installed on this phone — not that it claims
         * this page. It is still the useful fact, because it is the condition under
         * which Chrome's own menu stops offering installs for this whole origin:
         * isAppInstalledForUrl is hasAtLeastOneWebApkForOrigin, so one installed app
         * makes every page on the host report as installed, and the "open" that menu
         * offers instead finds nothing that handles /p/<name>/ and fails. The
         * button above uses the page's own offer, which is checked against this
         * manifest's start_url and so is not affected.
         */
        lines.push(
          apps.length
            ? `Chrome reports this phone has ${apps.length} of this manifest’s related apps installed: ` +
              `${apps.map((a) => a.id || a.url || a.platform).join(', ')} — the chat app. That is why Chrome’s own menu calls every page on this address “already installed” and then fails to open one: that check is per origin, not per app. It does not stop this project installing from the button above.`
            : 'Chrome reports none of this manifest’s related apps installed, so nothing of ours is in the way.',
        );
      } catch (err) {
        lines.push(`Chrome would not say what is installed: ${err.message}`);
      }
    } else {
      lines.push('This browser cannot say which apps are installed.');
    }

    say(lines.join(' '));
  }

  // --------------------------------------------------------- project switcher
  async function openProjects() {
    openSheet('<p class="cmo-title">Open project</p><p class="cmo-hint">Loading…</p>');
    let projects = [];
    try {
      const res = await fetch('/api/projects');
      // The editor and the chat API are gated separately — code-server checks its
      // own password, the API checks a session cookie. Signing into the editor
      // alone leaves this request unauthorized, and without this branch the 401
      // body falls through to `|| []` and renders as "No projects found", which
      // looks like an empty workspace rather than a missing login.
      if (res.status === 401) {
        const next = encodeURIComponent(location.pathname + location.search);
        openSheet(`
          <p class="cmo-title">Sign in to list projects</p>
          <p class="cmo-hint">The project list comes from the chat service, which
          needs its own sign-in. Same password as the editor — once only.</p>
          <div class="cmo-row">
            <button class="cmo-action" id="cmo-signin">Sign in</button>
            <button class="cmo-action cmo-alt" id="cmo-close-projects">Close</button>
          </div>`);
        panel.querySelector('#cmo-close-projects').addEventListener('click', closeSheet);
        panel.querySelector('#cmo-signin').addEventListener('click', () => {
          location.href = `/login?next=${next}`;
        });
        return;
      }
      projects = (await res.json()).projects || [];
    } catch {
      panel.innerHTML =
        '<p class="cmo-title">Open project</p><p class="cmo-hint">Could not reach the server.</p>';
      return;
    }

    // Which folder this window already has, so tapping it can do nothing instead
    // of reloading the workbench to arrive where it already is.
    const current = folder();
    // And which project it is, which is not the same question: /p/<name>/ with no
    // ?folder= is this project's window and used to render no install button at all,
    // on exactly the page the install has to come from. See thisWindowsProject.
    const installProject = thisWindowsProject();

    /*
     * A project is a link, not a button, and that is the whole point.
     *
     * Switching project used to mean giving up the window you were in: this sheet
     * assigned `location.href`, so project B replaced project A and the only way
     * to have both was to remember the URL. The chat app already treats a project
     * as a window of its own; the editor is the surface where that was missing.
     *
     * Three ways out of it, in order of how much a phone can offer:
     *   - tap the row        -> open it here, exactly as before
     *   - tap ⧉             -> a new tab, because `target="_blank"` on a real
     *                            anchor is the one popup iOS never blocks
     *   - long-press the row -> the browser's own menu, which is the only thing
     *                            that can open a separate *window* (iPad, desktop)
     *
     * All three need the `href` to be real, which is why the same URL is built
     * once here and used by both anchors.
     */
    const items = projects
      .map((p) => {
        const open = current !== '' && current === p.path;
        const path = encodeURIComponent(p.path);
        const href = projectHref(p.path);
        return (
          '<div class="cmo-item-row">' +
          `<a class="cmo-item" href="${href}" data-path="${path}"` +
          `${open ? ' data-open="1"' : ''}>${p.name}${open ? ' — open' : ''}</a>` +
          `<a class="cmo-item-new" href="${href}" target="_blank" rel="noopener"` +
          ` aria-label="Open ${p.name} in a new tab">&#10697;</a>` +
          '</div>'
        );
      })
      .join('');

    openSheet(`
      <p class="cmo-title">Open project</p>
      ${items || '<p class="cmo-hint">No projects found.</p>'}
      <div class="cmo-row">
        <button class="cmo-action" id="cmo-new-project">+ New project</button>
        <button class="cmo-action cmo-alt" id="cmo-close-projects">Close</button>
      </div>
      ${
        installProject
          ? `<div class="cmo-row">
        <button class="cmo-action cmo-alt" id="cmo-install">&#8962; Give ${installProject} its own window</button>
        <button class="cmo-action cmo-alt" id="cmo-install-why">&#9906; Check this install</button>
      </div>
      <p class="cmo-status" id="cmo-install-status"></p>`
          : ''
      }
      <p class="cmo-hint">Tap to open here, &#10697; for a new tab, long-press for
      the browser's own menu. A phone's installed app only ever has one window, so
      the way to run two projects side by side there is to give each one its own
      home-screen icon — same app, same login, its own window in the app switcher.
      Each project is a separate workspace, so Claude's session history follows the
      folder.</p>`);

    panel.querySelector('#cmo-close-projects').addEventListener('click', closeSheet);
    panel.querySelector('#cmo-new-project').addEventListener('click', openNewProject);
    panel.querySelector('#cmo-install')?.addEventListener('click', addToHomeScreen);
    panel.querySelector('#cmo-install-why')?.addEventListener('click', explainInstall);
    // Only the row itself. The ⧉ anchor next to it is deliberately left to the
    // browser: `target="_blank"` with no JavaScript in the way is what makes it a
    // navigation iOS trusts rather than a popup it blocks. The sheet stays open
    // behind it, so several projects can be opened in a row.
    panel.querySelectorAll('.cmo-item').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        // The row carries a real href for the long-press menu, but a plain tap
        // still means "open it here" — so the navigation stays this file's
        // decision, and the two branches below keep working as they did.
        event.preventDefault();
        // Already this folder. Navigating would reload the entire workbench, kill
        // the extension host and take an unsent message in the Claude panel with
        // it — to end up exactly here. The switcher is also the natural thing to
        // open when checking which project you are in, so this is a normal tap,
        // not a mistake to punish.
        if (btn.dataset.open) {
          closeSheet();
          return;
        }
        // Never a bare `/?folder=...`: `/` is the chat, so that silently threw you
        // into the chat while the editor kept whatever folder it had, which reads as
        // "the project switcher does nothing". decodeURIComponent because the data
        // attribute holds the encoded path and projectHref encodes it again.
        location.href = projectHref(decodeURIComponent(btn.dataset.path));
      });
    });
  }

  /**
   * Create a project: folder + git repo + optional GitHub remote, then open it.
   *
   * The GitHub step involves network calls and can take a few seconds, so the
   * button reports progress and each step's outcome is shown individually — a
   * project that exists locally but failed to reach GitHub is a different
   * result from a fully wired one, and silently conflating them is how you end
   * up pushing to a remote that was never created.
   */
  function openNewProject() {
    openSheet(`
      <p class="cmo-title">New project</p>
      <input id="cmo-np-name" class="cmo-input" type="text" autocapitalize="none"
             autocorrect="off" spellcheck="false" placeholder="project-name">
      <input id="cmo-np-desc" class="cmo-input" type="text"
             placeholder="Description (optional)">
      <label class="cmo-check">
        <input type="checkbox" id="cmo-np-gh" checked>
        Create a GitHub repo and push
      </label>
      <label class="cmo-check">
        <input type="checkbox" id="cmo-np-private" checked>
        Private
      </label>
      <p class="cmo-status" id="cmo-np-status"></p>
      <div class="cmo-row">
        <button class="cmo-action" id="cmo-np-go">Create</button>
        <button class="cmo-action cmo-alt" id="cmo-np-back">Back</button>
      </div>
      <p class="cmo-hint">Creates /workspace/projects/&lt;name&gt;, runs git init
      with a first commit, then creates the remote with the workspace's GitHub
      token. Opens the project when it's ready.</p>`);

    const nameEl = panel.querySelector('#cmo-np-name');
    const status = panel.querySelector('#cmo-np-status');
    const go = panel.querySelector('#cmo-np-go');
    nameEl.focus();

    panel.querySelector('#cmo-np-back').addEventListener('click', openProjects);

    const create = async () => {
      const name = nameEl.value.trim();
      if (!name) {
        status.textContent = 'Give it a name.';
        return;
      }
      if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        status.textContent = 'Letters, numbers, dot, dash and underscore only.';
        return;
      }

      go.disabled = true;
      const wantsGithub = panel.querySelector('#cmo-np-gh').checked;
      status.textContent = wantsGithub ? 'Creating folder, git repo and remote…' : 'Creating…';

      try {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            github: wantsGithub,
            private: panel.querySelector('#cmo-np-private').checked,
            description: panel.querySelector('#cmo-np-desc').value.trim(),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `server returned ${res.status}`);

        const steps = data.project.steps || [];
        const failed = steps.filter((s) => !s.ok);
        const repo = steps.find((s) => s.step === 'github' && s.ok);

        if (failed.length) {
          // Don't navigate away from a partial result — the message is the point.
          status.innerHTML =
            `Created <b>${escapeHtml(name)}</b>, but: ` +
            failed.map((s) => `${escapeHtml(s.step)} failed — ${escapeHtml(s.error || '')}`).join('; ');
          go.disabled = false;
          return;
        }

        status.textContent = repo?.url
          ? `Created and pushed to ${repo.url}. Opening…`
          : 'Created. Opening…';
        setTimeout(() => {
          location.href = projectHref(data.project.path);
        }, 900);
      } catch (err) {
        status.textContent = err.message;
        go.disabled = false;
      }
    };

    go.addEventListener('click', create);
    nameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') create();
    });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ------------------------------------------------- escaping a stuck layout
  /*
   * Claude opens files and diffs in the editor area. With tabs, the activity bar
   * and the status bar all hidden for phone use, nothing on screen closes one
   * again: the panel keeps whatever width is left over, and reloading brings the
   * file back. On a desktop you can at least drag the split to the edge — on a
   * phone the workspace is simply stuck, which is why this exists.
   *
   * The workbench's command service is not reachable from here. There is no
   * supported global for it, and this file must not reach into VS Code's
   * internals — rewriting the bundle black-screened the editor twice already
   * (see the disconnect-frame note above). So the commands are driven the one way
   * a page can drive them from outside: keybindings. The mobile extension binds
   * ctrl+alt+shift+F9 and F10, and these synthesise those chords. VS Code's
   * keybinding service listens for keydown on the window and does not check
   * `isTrusted`, so a dispatched event reaches it even while focus sits inside
   * the Claude webview's iframe.
   *
   * Nothing observable comes back, so success cannot be reported honestly from
   * out here. Hence three escalating options rather than one button that claims
   * to have worked: the command, the chrome so files can be closed by hand, and
   * a reload — which now recovers on its own, because the extension closes
   * restored file tabs at startup.
   */
  const KEY_BACK = { key: 'F9', code: 'F9', keyCode: 120 };
  const KEY_CHROME = { key: 'F10', code: 'F10', keyCode: 121 };
  const KEY_TERMINAL = { key: 'F11', code: 'F11', keyCode: 122 };

  function pressChord(spec) {
    const init = {
      key: spec.key,
      code: spec.code,
      keyCode: spec.keyCode,
      which: spec.keyCode,
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    // Dispatch from whatever holds focus so the event bubbles up through body and
    // document to the window, wherever the listener happens to be attached.
    const target = document.activeElement || document.body;
    for (const type of ['keydown', 'keyup']) {
      const event = new KeyboardEvent(type, init);
      // `keyCode` in the init dictionary is a legacy extension, and VS Code maps
      // keys from it. Where the browser ignores it, define it by hand rather
      // than dispatching an event the keybinding service will discard.
      if (!event.keyCode) {
        try {
          Object.defineProperty(event, 'keyCode', { get: () => spec.keyCode });
          Object.defineProperty(event, 'which', { get: () => spec.keyCode });
        } catch {
          /* nothing else to try; `code` may still be enough */
        }
      }
      target.dispatchEvent(event);
    }
  }

  // --------------------------------------------------- what reloaded the editor
  /*
   * A reload of the workbench is not a cosmetic event here: it restarts the
   * extension host and takes anything typed into the Claude panel and not sent
   * with it. Reports of "it refreshed a few times and deleted what I typed" cannot
   * be diagnosed from the instance, because the server side of every cause looks
   * identical — a new connection and a dead extension host — whether the page
   * navigated itself, the user pulled to refresh, or iOS discarded the tab to
   * reclaim memory.
   *
   * So each load writes down how it happened, and the Layout sheet shows the last
   * few. `navigation.type` is what separates the cases: `navigate` means something
   * assigned to `location` (a project switch), `reload` means the page or the OS
   * reloaded it, `back_forward` means history. The folder comes along because a
   * run of `navigate` entries with the *same* folder is a very different bug from
   * one where it changes.
   */
  const LOADS_KEY = 'claude-editor-loads';
  const LOADS_KEEP = 12;

  function loadHistory() {
    try {
      const list = JSON.parse(localStorage.getItem(LOADS_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function recordLoad(reason) {
    let how = reason || 'unknown';
    try {
      const nav = !reason
        && performance.getEntriesByType
        && performance.getEntriesByType('navigation')[0];
      if (nav && nav.type) how = String(nav.type);
    } catch {
      /* no navigation timing: the entry is still worth having for its timestamp */
    }
    let folder = '';
    try {
      folder = new URLSearchParams(location.search).get('folder') || '';
    } catch {
      /* empty window */
    }
    const list = loadHistory();
    list.push({ t: Date.now(), how, folder });
    try {
      localStorage.setItem(LOADS_KEY, JSON.stringify(list.slice(-LOADS_KEEP)));
    } catch {
      /* private mode: the history is diagnostic, never load-bearing */
    }
  }

  function loadSummary() {
    const list = loadHistory();
    if (!list.length) return '';
    const recent = list.filter((e) => Date.now() - e.t < 5 * 60 * 1000).length;
    const shown = list.slice(-5).map((e) => {
      const at = new Date(e.t).toTimeString().slice(0, 8);
      const where = e.folder ? ` ${e.folder.split('/').filter(Boolean).pop()}` : '';
      return `${at} ${e.how}${where}`;
    });
    return `${recent} load${recent === 1 ? '' : 's'} in the last five minutes. ` +
      shown.join(' · ');
  }

  function openLayout() {
    openSheet(`
      <p class="cmo-title">Layout</p>
      <div class="cmo-row">
        <button class="cmo-action" id="cmo-back">Back to Claude, full screen</button>
      </div>
      <div class="cmo-row">
        <button class="cmo-action cmo-alt" id="cmo-chrome">Show tabs &amp; bars</button>
        <button class="cmo-action cmo-alt" id="cmo-reload">Reload the editor</button>
      </div>
      <div class="cmo-row">
        <button class="cmo-action cmo-alt" id="cmo-layout-close">Close</button>
      </div>
      <p class="cmo-status" id="cmo-layout-status"></p>
      <p class="cmo-hint">The first button closes the files and diffs Claude
      opened and gives it the whole window back — the conversation keeps running,
      and unsaved files are left alone. If the layout is still wrong, show the
      tabs and close things by hand, or reload. Last resort, when even a reload
      comes back broken:
      <a href="/chat/reset.html?from=editor">reset this device</a>.</p>
      <p class="cmo-hint" id="cmo-loads"></p>`);

    const status = panel.querySelector('#cmo-layout-status');
    // Only shown once there is something to show, so the sheet stays a set of
    // buttons for the person who came here to fix their screen.
    const loads = loadSummary();
    if (loads) panel.querySelector('#cmo-loads').textContent = `This tab: ${loads}`;

    panel.querySelector('#cmo-layout-close').addEventListener('click', closeSheet);
    panel.querySelector('#cmo-reload').addEventListener('click', () => {
      status.textContent = 'Reloading…';
      location.reload();
    });
    panel.querySelector('#cmo-back').addEventListener('click', () => {
      pressChord(KEY_BACK);
      status.textContent = 'Asked the editor to close open files.';
      closeSheetLater(700);
    });
    panel.querySelector('#cmo-chrome').addEventListener('click', () => {
      pressChord(KEY_CHROME);
      status.textContent = 'Toggled tabs, activity bar and status bar.';
      closeSheetLater(700);
    });
  }

  // ------------------------------------------------------- keep the screen on
  /*
   * The editor has the same problem as the chat app: the display sleeps on its
   * idle timer while you are reading a diff or waiting on a task, and hiding the
   * page suspends dictation and freezes the workbench's socket.
   *
   * Same reconciler as chat-service/public/app.js, and deliberately the same
   * localStorage key — code-server and the chat are one origin behind nginx, so
   * the switch in the chat's Settings governs both. Duplicated rather than shared
   * because this file is injected raw into the workbench and imports nothing.
   *
   * The wake lock is released by the browser on every hide and never re-taken,
   * and the OS revokes it silently, so it has to be re-requested rather than
   * acquired once.
   */
  var wakeLock = null;
  var wakeLockPending = false;

  function keepAwakeWanted() {
    try {
      return localStorage.getItem('claude-keep-awake') !== '0';
    } catch (err) {
      return true;
    }
  }

  function syncWakeLock() {
    if (!keepAwakeWanted() || document.visibilityState !== 'visible') {
      var held = wakeLock;
      wakeLock = null;
      try { if (held) held.release(); } catch (err) { /* already gone */ }
      return;
    }
    if (wakeLock || wakeLockPending || !navigator.wakeLock) return;
    wakeLockPending = true;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLockPending = false;
      // The page may have been hidden, or the switch flipped, while we waited.
      if (!keepAwakeWanted() || document.visibilityState !== 'visible') {
        try { lock.release(); } catch (err) { /* nothing to undo */ }
        return;
      }
      wakeLock = lock;
      lock.addEventListener('release', function () {
        if (wakeLock === lock) wakeLock = null;
      });
    }).catch(function () {
      // Hidden, unsupported, or refused by the OS. The timer retries.
      wakeLockPending = false;
    });
  }

  document.addEventListener('visibilitychange', syncWakeLock);
  window.addEventListener('pageshow', syncWakeLock);
  window.addEventListener('focus', syncWakeLock);
  setInterval(syncWakeLock, 30000);
  syncWakeLock();

  // ------------------------------------------------- is Claude working, and what
  /*
   * The one thing you need to know before the history has finished loading.
   *
   * Opening a conversation on a second device means waiting while the Claude panel
   * re-reads and re-renders the entire transcript — measured at 1.75–3.97s inside
   * the extension host before the CLI is even launched, on transcripts up to 8.7MB,
   * and it renders oldest-first, so the newest message arrives last. That is the
   * message you need in order to reply, and it is the one you wait longest for.
   *
   * The panel is a proprietary webview, so none of that can be reordered from here.
   * What can be done is to answer the question from outside it, while it works:
   *
   *   Claude is working  ->  the answer has not been said yet. Wait; the history
   *                          is worth the wait, because the end of it is coming.
   *   Claude is idle     ->  it is your turn, and the last message is all you
   *                          need. Here it is, in tens of milliseconds.
   *
   * "Working" is not something a transcript can tell you — there is no turn-end
   * marker on disk — so it comes from claude-broker, which owns the process. See
   * chat-service/claude-status.js.
   */
  const STATUS_POLL_MS = 4000;
  // A tab left open for hours must not poll forever. Working turns are minutes,
  // not hours, and a stale chip is harmless once the answer is on screen anyway.
  const STATUS_POLL_LIMIT = 30 * 60 * 1000;
  // Long enough to read a line and decide, short enough not to sit on the editor.
  const CHIP_LINGER_MS = 30000;
  /*
   * A slow heartbeat, even when nothing is working.
   *
   * Switching conversations inside the panel is invisible from out here: it is one
   * webview rearranging itself, with no navigation, no visibility change, and
   * nothing to listen for. Without a heartbeat the answer from page load stands
   * until something else happens to ask — which is what "the status is stale after
   * I switch" actually was. A tail read is tens of milliseconds, so this is cheap
   * enough to run while the tab is watched and stopped the moment it is not.
   */
  const STATUS_HEARTBEAT_MS = 15000;
  /*
   * And a fast one, but only while the status sheet is open in front of someone.
   *
   * The sheet answers "what did Claude last say", and that answer changes
   * underneath it: a turn ends, another message is written mid-turn, someone
   * types into the panel. Opened once and left alone it kept showing the snapshot
   * from the tap that opened it, and the only way to see anything newer was to
   * keep tapping Refresh — which is the same waiting-and-checking this whole
   * section exists to remove.
   *
   * Five seconds rather than the heartbeat's fifteen, because a sheet on screen is
   * the one moment where a stale line is actively being read as the current one.
   * It is bounded three ways: only while that sheet is the sheet on screen, only
   * while the tab is visible, and only for as long as a working turn would be
   * polled for anyway.
   */
  const SHEET_POLL_MS = 5000;
  // A sheet left open in a pocket must not poll for the rest of the day. Same
  // limit as a working turn, and Refresh — or reopening it — starts it again.
  const SHEET_FOLLOW_LIMIT = STATUS_POLL_LIMIT;

  let status = null;
  let statusPollTimer = null;
  let statusHeartbeat = null;
  let statusPollingSince = 0;
  let chipTimer = null;
  let sheetPollTimer = null;
  let sheetFollowUntil = 0;
  /*
   * What the open sheet is showing, which is what "something changed" is measured
   * against. It lives with the sheet rather than with the last fetch, because the
   * fetch that finds the change is usually not the sheet's own: a working turn is
   * already polled every four seconds, the heartbeat runs every fifteen, and the
   * window regaining focus asks as well. Whichever of them notices, the sheet
   * catches up.
   */
  let sheetShown = null;
  // Which sheet the status sheet is. Opening any other one (dictation, layout)
  // bumps the counter, which ends the following without needing to be told.
  let statusSheetGeneration = -1;
  /*
   * A conversation the user picked out of the list, which then overrides the
   * guess. Null means "whichever one you think I am in" — see guessConversation in
   * chat-service/claude-status.js for how good that guess can be, and why the
   * answer always names what it chose.
   */
  let pinnedSession = null;

  function folder() {
    try {
      return new URLSearchParams(location.search).get('folder') || '';
    } catch {
      return ''; // an empty window: no conversation to report on
    }
  }

  /**
   * The conversation a tapped notification was about — `?session=`.
   *
   * A notification names one conversation, and this window's own guess is about the
   * project (see guessConversation in chat-service/claude-status.js), so arriving from
   * a notification means arriving with an answer the page would otherwise have to
   * infer. The URL is built by turn-watcher.js and opened by pwa/sw.js.
   */
  function notifiedSession() {
    try {
      return new URLSearchParams(location.search).get('session') || '';
    } catch {
      return '';
    }
  }

  /**
   * Spend the parameter: read once, then take it out of the URL.
   *
   * Because this page reloads itself. The workbench calls location.reload() on every
   * bfcache restore (see `pageshow` at the bottom of this file), which on a phone
   * means every time you switch apps and come back — and a `?session=` still in the
   * URL would re-pin that conversation and re-open the sheet over the editor, hours
   * after the notification was tapped, forever.
   *
   * The other pairs are put back byte for byte rather than re-serialized, because one
   * of them is `?folder=` and it is the argument code-server opens the workspace from:
   * a URLSearchParams round trip would turn a space in a project's path into `+`, and
   * the next reload would look for a folder that does not exist.
   */
  function forgetNotifiedSession() {
    try {
      const kept = location.search
        .replace(/^\?/, '')
        .split('&')
        .filter((pair) => pair && !pair.startsWith('session='));
      const search = kept.length ? `?${kept.join('&')}` : '';
      history.replaceState(history.state, '', `${location.pathname}${search}${location.hash}`);
    } catch {
      /* A browser that refuses replaceState still gets everything else. */
    }
  }

  /**
   * Ask the chat service. Every failure answers null, and null shows nothing:
   * a 401 (the editor and the chat API are gated separately, so signing into one
   * leaves the other unauthorized), no route on an older deployment, a dropped
   * network. None of those are worth a banner over someone's editor — the project
   * switcher is where a missing chat-service sign-in is explained.
   */
  async function fetchStatus() {
    const cwd = folder();
    if (!cwd) return null;
    const pin = pinnedSession ? `&sessionId=${encodeURIComponent(pinnedSession)}` : '';
    try {
      const res = await fetch(`/api/claude-status?cwd=${encodeURIComponent(cwd)}${pin}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  /*
   * The prompt a conversation began with: asked once, then kept for the life of the
   * page.
   *
   * Immutable, which is the whole reason it is a second request rather than another
   * field on the status answer — that one is polled every four seconds while a turn
   * runs, and re-sending a paragraph that cannot have changed on every poll would be
   * the same page of text a hundred times.
   *
   * Three states, and they have to stay apart:
   *   a value     — asked, and this is the prompt
   *   null        — asked, and this conversation has no typed opening (another
   *                 session's message opened it, say)
   *   not present — never asked, or the ask failed. A failure is silent and
   *                 retried the next time the sheet opens, like every other fetch
   *                 out here: the editor gets no banner because the chat service's
   *                 session lapsed.
   */
  const firstPrompts = new Map();
  const firstPromptAsks = new Map();

  function askFirstPrompt(sessionId) {
    if (firstPrompts.has(sessionId)) return Promise.resolve(firstPrompts.get(sessionId));
    const pending = firstPromptAsks.get(sessionId);
    if (pending) return pending;

    const cwd = folder();
    const ask = (async () => {
      try {
        const res = await fetch(
          `/api/first-prompt?cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(sessionId)}`,
        );
        if (!res.ok) return undefined;
        const data = await res.json();
        const value = data?.text ? { text: String(data.text), at: data.at || null } : null;
        firstPrompts.set(sessionId, value);
        return value;
      } catch {
        return undefined;
      } finally {
        firstPromptAsks.delete(sessionId);
      }
    })();
    firstPromptAsks.set(sessionId, ask);
    return ask;
  }

  function hideChip() {
    if (chipTimer) clearTimeout(chipTimer);
    chipTimer = null;
    chip.classList.add('cmo-gone');
    // Removed rather than left transparent: it sits over the editor's top edge,
    // and `pointer-events: none` is one CSS mistake away from swallowing taps.
    setTimeout(() => chip.remove(), 450);
  }

  /** How long ago, in words, for a list where exact times would be noise. */
  function sinceText(at) {
    if (!at) return '';
    const mins = Math.round((Date.now() - at) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
  }

  /**
   * One line of a message, with its markdown taken off rather than rendered.
   *
   * The chip and the conversation list are single lines of plain text — a heading or
   * a `<strong>` has nowhere to go in them — so what they need is not the renderer
   * that draws the sheet but the same message with its markers removed. Stripping
   * before the line is cut also matters: an answer that opens with `**Shipped**`
   * used to arrive in the list as a stray `**` hanging off the end of the previous
   * sentence, because the cut landed between the marker and its text.
   */
  function plainLine(markdown) {
    return (
      String(markdown == null ? '' : markdown)
        // A fenced block is not a line of prose. Unterminated counts: a transcript
        // is read while it is still being written.
        .replace(/```[\s\S]*?(```|$)/g, ' ')
        .replace(/~~~[\s\S]*?(~~~|$)/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        // A table has no one-line form. Its alignment row carries no words at all,
        // and its cells read better separated than piped.
        .replace(/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/gm, ' ')
        .replace(/^\s*\|(.*)\|?\s*$/gm, (_, row) => row.split('|').join(' · '))
        // Line markers while the lines are still lines: a `*` opening a bullet and
        // a `*` opening emphasis are told apart by where they sit.
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, ' ')
        .replace(/^\s{0,3}([-*+]|\d{1,3}[.)])\s+/gm, '')
        // Then the inline ones, bold before italic so `**` never leaves a lone `*`.
        .replace(/`+([^`]*)`+/g, '$1')
        .replace(/\*\*([^*]+?)\*\*/g, '$1')
        .replace(/__([^_]+?)__/g, '$1')
        .replace(/\*([^*\s][^*]*?)\*/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()
    );
  }

  /**
   * A name for a conversation: Claude Code's own title, or nothing.
   *
   * The opening of the last message used to stand in for a missing title, and a
   * list of those is unreadable — five rows all beginning "Done —" name nothing,
   * and the row you want is the one whose subject you remember. It also hid a bug
   * for a week: the title never arrived at all (see `aiTitle` in claude-status.js)
   * and the list looked merely wordy rather than broken. So a conversation with no
   * title says so, and the message stays in the sheet below where it belongs.
   */
  function nameOf(c) {
    return c?.title || 'Untitled conversation';
  }

  /**
   * The first question waiting, or the last one asked. See `question` on
   * /api/claude-status.
   */
  const askedOf = (s) => s?.question?.questions?.[0] || null;

  /** A single line: what it is doing, or the first of what it said. */
  function chipLine(s) {
    /*
     * A question outranks everything else the chip could say.
     *
     * It is the only state where nothing at all happens until the person acts, and
     * the state the panel is least able to show them: inside it a pending ask and an
     * ask answered last week are the same card. The header — Claude Code's own short
     * label for the question — is what makes this specific enough to act on.
     */
    if (s.state === 'question') {
      const head = askedOf(s)?.header;
      return head ? `Claude is waiting for your answer · ${head}` : 'Claude is waiting for your answer';
    }
    const line =
      s.state === 'working'
        ? 'Claude is working…'
        : s.last?.text
          ? plainLine(s.last.text)
          : s.state === 'unknown'
            ? 'Claude — tap for status'
            : 'Claude is waiting for you';
    // Name the conversation only when the project holds more than one, because
    // that is the only time it tells you anything — and it is exactly when an
    // answer about the wrong one is possible. See guessConversation.
    const many = (s.conversations?.length || 0) > 1;
    return many && s.title ? `${s.title} · ${line}` : line;
  }

  /**
   * The second line, for the one moment it is worth having: the panel is redrawing a
   * conversation's history, and the question cards in it are already answered.
   *
   * This is the half of the double-answer problem that can be fixed from out here.
   * The panel re-renders every question in a conversation as a fresh card whenever it
   * loads one — on a page load, and on a switch to a conversation it is not already
   * showing — and a card gives no sign of having been answered, so the same question
   * can be answered twice. Nothing outside a webview can change what it draws. What
   * it can do is say, beside it and unasked, that the answer is already on disk and
   * what it was.
   *
   * Only when a question is *not* waiting: if one is, the line above says so and the
   * card at the bottom of the panel is the live one.
   */
  function answeredNote(s) {
    if (s.state === 'question' || !s.question?.answered) return '';
    const picked = (s.question.questions || []).map((q) => q.answer).filter(Boolean);
    const said = picked.length ? `you chose “${picked.join('”, “')}”` : 'it was answered';
    const when = s.question.at ? ` ${sinceText(Date.parse(s.question.at))}` : '';
    return `Already answered${when} — ${said}`;
  }

  /**
   * `replay` says the panel is (re)drawing this conversation's history, which is the
   * only time the note above is news. See answeredNote.
   */
  function showChip(s, { linger = true, replay = false } = {}) {
    chipText.textContent = chipLine(s);
    const note = replay ? answeredNote(s) : '';
    chipNote.textContent = note;
    chipNote.classList.toggle('cmo-on', Boolean(note));
    chipDot.classList.toggle('cmo-busy', s.state === 'working');
    chipDot.classList.toggle('cmo-ask', s.state === 'question');
    chip.classList.remove('cmo-gone');
    if (!chip.isConnected) document.body.appendChild(chip);
    if (chipTimer) clearTimeout(chipTimer);
    // A working chip stays: it is the reason to keep waiting, and it is replaced
    // by the finished one as soon as the turn ends. A question stays for the
    // stronger version of the same reason — it is the one state that will not
    // resolve on its own, so a chip that times out takes the only notice of it
    // away with it.
    const sticky = s.state === 'working' || s.state === 'question';
    chipTimer = linger && !sticky ? setTimeout(hideChip, CHIP_LINGER_MS) : null;
  }

  function stopStatusPoll() {
    if (statusPollTimer) clearTimeout(statusPollTimer);
    statusPollTimer = null;
  }

  /**
   * Ask, and decide whether the answer is worth putting on screen.
   *
   * `silent` is what makes a heartbeat tolerable: a repeat of what is already
   * known changes nothing, but two things still speak up. A turn finishing is the
   * moment the answer exists, and the conversation *changing* — someone switched
   * conversations in the panel, and this is the first sight of it out here — is the
   * moment the last message on screen stopped belonging to what is on screen.
   */
  async function refreshStatus({ silent = false } = {}) {
    const next = await fetchStatus();
    if (!next) return null;
    const prev = status;
    status = next;

    const switched = Boolean(prev?.sessionId && next.sessionId && prev.sessionId !== next.sessionId);
    const finished = prev?.state === 'working' && next.state !== 'working';
    // Being asked something is news of the same order as a turn ending, and a
    // dismissed chip must come back for it: this is the state where nothing happens
    // until the person acts.
    const asked = prev?.state !== 'question' && next.state === 'question';
    /*
     * The panel is drawing this conversation's history from scratch — the first
     * answer of a page, or a switch to a conversation it was not already showing.
     * Those are exactly the two moments it redraws old question cards as though they
     * were live. See answeredNote.
     */
    const replay = !prev || switched;
    // A visible chip is always kept current; an absent one is only brought back
    // for something new. Otherwise a dismissed chip would return every 15s.
    if (!silent || switched || finished || asked || chip.isConnected) showChip(next, { replay });

    if (next.state === 'working' || next.state === 'question') {
      if (!statusPollTimer) statusPollingSince = Date.now();
      stopStatusPoll();
      statusPollTimer = setTimeout(pollStatus, STATUS_POLL_MS);
    }
    /*
     * Whichever background ask found it, an open sheet is showing this answer and
     * has to catch up. `silent` is exactly the right condition: it means nobody
     * tapped for this — the heartbeat, the working poll, the sheet's own poll,
     * coming back to the window. The tapped paths redraw the sheet themselves,
     * through openStatus, and deliberately do not read anything out: a message
     * that appears in the same moment you asked for it is on screen, being looked
     * at, which is not the case this speaks for.
     */
    if (silent) syncStatusSheet();
    return next;
  }

  /**
   * Poll fast while a turn is in flight, and only while the tab is visible.
   *
   * The transition from working to idle is why this is four seconds rather than
   * the heartbeat's fifteen — it is the moment the answer you were waiting for
   * exists, and the chip is rewritten when it happens.
   */
  async function pollStatus() {
    stopStatusPoll();
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - statusPollingSince > STATUS_POLL_LIMIT) return;
    await refreshStatus({ silent: true });
  }

  /**
   * Answer the question on arrival, unasked.
   *
   * Deliberately not behind a tap: the wait this exists for happens on page load,
   * and being told to tap something while the editor is busy loading is the same
   * wait with an extra step.
   */
  const checkStatus = () => refreshStatus();

  /** Notice a switch that this page has no way of being told about. */
  function startStatusHeartbeat() {
    if (statusHeartbeat) return;
    statusHeartbeat = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      // A working turn is already being polled, four times as often.
      if (statusPollTimer) return;
      refreshStatus({ silent: true });
    }, STATUS_HEARTBEAT_MS);
  }

  // ------------------------------------------------- following the open sheet
  /*
   * Keep the sheet current while it is open, and read out what arrives.
   *
   * The reading is the part that is deliberately unlike the Read aloud button
   * below, which only ever speaks when pressed. Speech that starts on its own is a
   * phone talking in a meeting, so this is fenced in by the sheet: it can only
   * happen while the status sheet is the sheet on screen, which means a tap opened
   * it seconds ago and one tap beside it ends it. Stop silences the message being
   * read; closing the sheet stops anything further being read at all.
   *
   * Two things deliberately do not speak. A message that has not changed — the
   * poll finding the same answer again is not news — and a change of
   * *conversation*, because following another one is a request to look at it, not
   * to be read its history, and the sheet is already describing it.
   *
   * One platform note. iOS refuses speech that did not begin inside a gesture, and
   * a poll five seconds later is not inside one; once Read aloud has been pressed
   * on the page the refusal lifts for the rest of it. Android — the surface this
   * was asked for — has no such rule and reads the first change it sees.
   */

  /** Is the status sheet the sheet on screen? */
  function statusSheetOpen() {
    return sheet.classList.contains('cmo-open') && sheetGeneration === statusSheetGeneration;
  }

  function stopSheetPoll() {
    if (sheetPollTimer) clearTimeout(sheetPollTimer);
    sheetPollTimer = null;
  }

  /** Arm the next look, if there is still a sheet to look on behalf of. */
  function followStatusSheet() {
    stopSheetPoll();
    if (!statusSheetOpen()) return;
    if (Date.now() >= sheetFollowUntil) return;
    sheetPollTimer = setTimeout(pollStatusSheet, SHEET_POLL_MS);
  }

  async function pollStatusSheet() {
    sheetPollTimer = null;
    if (!statusSheetOpen()) return;
    /*
     * A locked phone is a hidden tab, and nothing on a hidden sheet is being
     * misread, so this stops asking and stays armed: coming back re-asks anyway
     * (see the visibilitychange handler) and the sheet catches up then.
     */
    if (document.visibilityState !== 'visible') {
      followStatusSheet();
      return;
    }
    if (Date.now() >= sheetFollowUntil) {
      // Redrawn rather than just going still, because the sheet says in words
      // that it is refreshing itself, and that has just stopped being true.
      // Not over a live selection, though: a sheet whose last line is out of date
      // is a smaller loss than text somebody was halfway through copying, so this
      // keeps looking until the selection is let go.
      if (selectionInPanel()) {
        sheetPollTimer = setTimeout(pollStatusSheet, SHEET_POLL_MS);
        return;
      }
      openStatus({ auto: true });
      return;
    }
    await refreshStatus({ silent: true });
    followStatusSheet();
  }

  /**
   * The one thing to know before hearing the message, or nothing.
   *
   * A message read out with no lead-in is heard as the answer, and three times out of
   * four that is what it is. The exceptions are what this exists for: a turn still
   * running, whose last message answers the question *before* the one you asked, and
   * a turn that was killed partway — `cutOff` from /api/claude-status, see NO_ANSWER
   * in chat-service/claude-status.js. Being read a half-finished thought as though it
   * were the conclusion is how you end up waiting for a turn that has already stopped.
   *
   * Null rather than 'Claude finished.' so the two callers can differ: the sheet's own
   * button says nothing in the ordinary case, because you just tapped Read aloud on a
   * message you are looking at.
   */
  function statusNote(s = status) {
    // Ahead of "still working", because a question is also a turn in flight and this
    // is the more specific truth about it: it is in flight and it is stuck on you.
    if (s?.state === 'question') return 'Claude is waiting for your answer.';
    if (s?.state === 'working') return 'Still working.';
    if (s?.cutOff === 'overflow') return 'Claude stopped: this conversation is too long to continue.';
    if (s?.cutOff) return 'Claude stopped before finishing.';
    return null;
  }

  /**
   * Put a changed answer on the open sheet, and say the new message out loud.
   *
   * Called from `refreshStatus`, so it runs for every fetch however it was
   * started. Redrawing is `openStatus` again: it is cheap, it is the one place
   * that knows how this sheet looks, and it re-seeds the baseline below.
   */
  function syncStatusSheet() {
    if (!statusSheetOpen() || !status) return;
    const before = sheetShown;
    const text = status.last?.text || '';
    if (before && before.state === status.state && before.text === text) return;
    /*
     * Held while a selection is live. `sheetShown` is deliberately left alone, so
     * the next look finds the same change still unshown and draws it — and speaks it
     * — the moment the selection is let go. Nothing is lost but a few seconds, and
     * what it buys is that copying an answer cannot be interrupted by the sheet
     * updating underneath it.
     */
    if (selectionInPanel()) return;

    const said =
      Boolean(text) && Boolean(before) && text !== before.text && status.sessionId === before.sessionId;
    openStatus({ auto: true });
    // After the redraw, so the button it draws says Stop rather than Read aloud.
    if (said) speak(text, statusNote() || 'Claude finished.');
  }

  // --------------------------------------------------- the message, rendered
  /*
   * Markdown as something worth looking at — the counterpart of `speakable` below,
   * and here for the same reason. A final message is *written*: bold, bullets,
   * backticks, a fenced diff in the middle of it. This sheet was showing the
   * asterisks, and on a phone this sheet is the whole of what you read of an answer,
   * so the source is not the thing to show.
   *
   * Nodes, never a string of markup. Every character here is model output, it
   * routinely contains angle brackets, and `innerHTML` behind an escaping function
   * is one careless edit away from executing what a message asked for. Elements
   * cannot go wrong that way: text only ever arrives through `textContent`, and the
   * one attribute taken from the message is an href whose scheme is checked.
   *
   * The subset is what Claude actually writes and what fits in a sheet: fenced
   * code, headings, bullet and numbered lists, rules, tables, inline code, bold,
   * italic, links. No nesting and no blockquotes — anything unrecognised is left as
   * the text it was, which is exactly what this sheet did before.
   *
   * Tables were left out of the first version of this on the grounds that they do
   * not fit a phone, which was the wrong call: a status answer is very often mostly
   * table — surface, check, result — and a table left as source is not a wide table,
   * it is a screenful of pipes.
   */
  const MD_FENCE = /^\s*(```|~~~)/;
  const MD_HEADING = /^\s*(#{1,6})\s+(.*)$/;
  const MD_RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
  const MD_BULLET = /^\s*[-*+]\s+(.*)$/;
  const MD_NUMBER = /^\s*(\d{1,3})[.)]\s+(.*)$/;
  /*
   * One pass over the inline forms, in this order for a reason: a backtick span
   * wins outright, because `**` inside code is code and not bold; `**` is tried
   * before `*`, so bold is never read as two italics; and the italic form requires
   * a non-space after the marker, which is what keeps "2 * 3 * 4" and a `*` bullet
   * that reached here as prose from turning the rest of a line into emphasis.
   */
  const MD_INLINE = new RegExp(
    [
      '(`+)([^`]+?)\\1', // 1,2  inline code
      '\\*\\*([^*]+?)\\*\\*', // 3  **bold**
      '__([^_]+?)__', // 4  __bold__
      '\\[([^\\]]+?)\\]\\(([^)\\s]+)\\)', // 5,6  [label](href)
      '\\*([^*\\s][^*]*?)\\*', // 7  *italic*
    ].join('|'),
    'g',
  );

  const mdNode = (tag, text) => {
    const el = document.createElement(tag);
    el.textContent = text;
    return el;
  };

  /*
   * One row of a pipe table, split into cells.
   *
   * The outer pipes are optional in every dialect worth supporting, so they are
   * dropped before the split rather than becoming empty leading and trailing cells.
   * `\|` is a literal pipe inside a cell and must not split it.
   */
  const MD_DELIM_CELL = /^:?-+:?$/;
  function mdCells(line) {
    let text = line.trim();
    if (text.startsWith('|')) text = text.slice(1);
    if (/(^|[^\\])\|$/.test(text)) text = text.slice(0, -1);
    return text.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
  }

  /**
   * The alignment row, if the line after a candidate header is one.
   *
   * This is what tells a table from a sentence with pipes in it: a header alone is
   * ambiguous, a header followed by `|---|---|` with a matching number of cells is
   * not. Returning the alignments doubles as the answer to "was this a table".
   */
  function mdAlignments(header, next) {
    if (next === undefined) return null;
    const cells = mdCells(next);
    if (cells.length !== header.length || !cells.every((c) => MD_DELIM_CELL.test(c))) return null;
    return cells.map((c) =>
      /^:.*:$/.test(c) ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '',
    );
  }

  /*
   * A link a tap can follow, or the text it was.
   *
   * `javascript:` in a message from a model is a script this page would run on a
   * tap, and there is no version of this feature that is worth that; anything but
   * http(s) or a path on this origin stays as characters. The rest opens in a new
   * tab, because the sheet is over a workbench with a conversation in it.
   */
  function mdLink(label, href) {
    if (!/^(https?:\/\/|\/)/i.test(href)) return document.createTextNode(`${label} (${href})`);
    const a = mdNode('a', label);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
  }

  function mdInline(text, into) {
    const source = String(text);
    let last = 0;
    for (const m of source.matchAll(MD_INLINE)) {
      if (m.index > last) into.appendChild(document.createTextNode(source.slice(last, m.index)));
      last = m.index + m[0].length;
      if (m[2] !== undefined) into.appendChild(mdNode('code', m[2]));
      else if (m[3] !== undefined) into.appendChild(mdNode('strong', m[3]));
      else if (m[4] !== undefined) into.appendChild(mdNode('strong', m[4]));
      else if (m[5] !== undefined) into.appendChild(mdLink(m[5], m[6]));
      else into.appendChild(mdNode('em', m[7]));
    }
    if (last < source.length) into.appendChild(document.createTextNode(source.slice(last)));
    return into;
  }

  function renderMarkdown(markdown) {
    const out = document.createDocumentFragment();
    const lines = String(markdown == null ? '' : markdown).split('\n');
    // The block being filled, so consecutive lines join instead of each becoming its
    // own paragraph: a wrapped sentence is one paragraph, and a run of bullets is
    // one list.
    let para = null;
    let list = null;
    const flush = () => {
      if (para) {
        mdInline(para.join('\n'), out.appendChild(document.createElement('p')));
        para = null;
      }
      list = null;
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const fence = MD_FENCE.exec(line);
      if (fence) {
        flush();
        const body = [];
        i += 1;
        // An unterminated block is normal here: this is a transcript being read
        // while it is still being written, so it ends where the message ends.
        while (i < lines.length && !new RegExp(`^\\s*${fence[1]}`).test(lines[i])) {
          body.push(lines[i]);
          i += 1;
        }
        const pre = document.createElement('pre');
        pre.appendChild(mdNode('code', body.join('\n')));
        out.appendChild(pre);
        continue;
      }
      if (!line.trim()) {
        flush();
        continue;
      }
      if (MD_RULE.test(line)) {
        flush();
        out.appendChild(document.createElement('hr'));
        continue;
      }
      /*
       * A table, if the next line says this one was a header. Checked before the
       * inline forms get near it, because a cell is markdown in its own right and
       * the pipes are structure rather than text.
       */
      if (line.includes('|')) {
        const header = mdCells(line);
        const align = header.length > 1 ? mdAlignments(header, lines[i + 1]) : null;
        if (align) {
          flush();
          const table = document.createElement('table');
          const headRow = table.createTHead().insertRow();
          header.forEach((cell, col) => {
            const th = document.createElement('th');
            if (align[col]) th.style.textAlign = align[col];
            headRow.appendChild(mdInline(cell, th));
          });
          const body = table.createTBody();
          i += 2;
          while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
            const cells = mdCells(lines[i]);
            const row = body.insertRow();
            // Padded to the header's width rather than the row's: a short row is
            // normal in hand-written markdown, and a ragged table misaligns every
            // column after the gap.
            for (let col = 0; col < header.length; col += 1) {
              row.appendChild(mdInline(cells[col] ?? '', document.createElement('td')));
              if (align[col]) row.cells[col].style.textAlign = align[col];
            }
            i += 1;
          }
          i -= 1; // the loop's own increment lands on the line that ended the table
          const wrap = document.createElement('div');
          wrap.className = 'cmo-md-table';
          wrap.appendChild(table);
          out.appendChild(wrap);
          continue;
        }
      }
      const heading = MD_HEADING.exec(line);
      if (heading) {
        flush();
        const el = document.createElement('p');
        el.className = 'cmo-md-h';
        mdInline(heading[2], el);
        out.appendChild(el);
        continue;
      }
      const bullet = MD_BULLET.exec(line);
      const numbered = bullet ? null : MD_NUMBER.exec(line);
      if (bullet || numbered) {
        if (para) flush();
        const want = bullet ? 'UL' : 'OL';
        if (!list || list.tagName !== want) {
          list = document.createElement(want);
          // Numbered lists keep the number they were written with, so a message
          // that resumes at 4 does not silently restart at 1.
          if (numbered && Number(numbered[1]) !== 1) list.start = Number(numbered[1]);
          out.appendChild(list);
        }
        mdInline(bullet ? bullet[1] : numbered[2], list.appendChild(document.createElement('li')));
        continue;
      }
      /*
       * Prose. A line under a list item that is not itself an item continues that
       * item — which is how a wrapped bullet arrives — rather than starting a
       * paragraph inside the list.
       */
      if (list) {
        const item = list.lastElementChild;
        item.appendChild(document.createTextNode('\n'));
        mdInline(line, item);
        continue;
      }
      if (!para) para = [];
      para.push(line);
    }
    flush();
    return out;
  }

  /**
   * The question, and — the part this was really written for — whether it is still a
   * question at all.
   *
   * Two failures of the panel meet here, and only one of them is about waiting.
   *
   *   **A question waiting reads as a turn in flight.** On disk and to the broker an
   *   unanswered `AskUserQuestion` is `stop_reason: 'tool_use'` with a live process,
   *   which is what work in progress looks like — so every surface said "Claude is
   *   working…" about a conversation that had stopped and was waiting for a person.
   *   Measured on the transcripts here: a median wait of three minutes, a longest of
   *   5.9 hours, and three conversations sitting on one unnoticed.
   *
   *   **An answered question is drawn again as though it were new.** The panel
   *   re-renders every question in a conversation when it loads one — on a page load,
   *   and on a switch to a conversation it is not already showing — and a card carries
   *   no sign of having been answered, so the same question can be answered twice.
   *   What a card cannot say, `toolUseResult.answers` in the transcript can: which
   *   option was taken, in the words it was taken in. That is what this puts on
   *   screen, because the card itself is inside a webview nothing out here may touch.
   *
   * Nodes, never markup, like everything else on this sheet: a question and its option
   * labels are model output.
   *
   * Bounded the same way the rest of this answer is — `question` comes from the tail
   * window claude-status.js already reads, so a conversation whose last question is
   * megabytes back reports none and this says nothing. Silence is the right failure
   * here: the sentence it would otherwise print is a claim about history it has not
   * read.
   */
  function paintAsk(s) {
    const holder = panel.querySelector('#cmo-ask');
    if (!holder) return;
    holder.textContent = '';
    const q = s.question;
    if (!q) return;

    // Waiting: show it. The full question, its header and every option label, because
    // this sheet is often read before the panel has finished drawing the card at all.
    if (s.state === 'question') {
      for (const asked of q.questions || []) {
        const block = document.createElement('div');
        block.className = 'cmo-ask-block';
        if (asked.header) {
          const head = document.createElement('p');
          head.className = 'cmo-ask-head';
          head.textContent = asked.multiSelect ? `${asked.header} · pick any` : asked.header;
          block.appendChild(head);
        }
        const text = document.createElement('p');
        text.className = 'cmo-ask-q';
        text.textContent = asked.question;
        block.appendChild(text);
        if (asked.options?.length) {
          const list = document.createElement('ul');
          list.className = 'cmo-ask-opts';
          for (const label of asked.options) {
            const item = document.createElement('li');
            item.textContent = label;
            list.appendChild(item);
          }
          block.appendChild(list);
        }
        holder.appendChild(block);
      }
      return;
    }

    const note = document.createElement('p');
    note.className = 'cmo-hint';
    if (q.answered) {
      const picked = (q.questions || []).map((entry) => entry.answer).filter(Boolean);
      const when = q.at ? sinceText(Date.parse(q.at)) : '';
      note.textContent =
        `${picked.length ? `You answered this${when ? ` ${when}` : ''}: “${picked.join('”, “')}”.` : `The last question here was already answered${when ? ` ${when}` : ''}.`}` +
        ' The panel redraws every question card when it reloads a conversation, so a card on screen is not necessarily waiting for anything — this is how to tell.';
    } else if (q.pending) {
      // Unanswered and nothing running it: the process that asked is gone, so the card
      // in the panel leads nowhere. The way to carry on is to say the answer as an
      // ordinary message.
      note.textContent =
        'This conversation stopped in the middle of asking you something, and nothing is running it now, so answering the card would go nowhere. Send your answer as a message instead.';
    } else {
      // Asked, dismissed, and the conversation moved on past it. Nothing to say.
      return;
    }
    holder.appendChild(note);
  }

  /**
   * The prompt this conversation began with, and a button that copies it.
   *
   * What it is for: the opening prompt is the message most worth sending again — the
   * brief, the standing instructions, the paragraph that took five minutes to write
   * — and it is the one a long conversation buries. Once a conversation has been
   * compacted, the CLI's own history no longer holds it, and scrolling the panel back
   * to the top of a 12MB transcript is not a thing anyone does on a phone. The
   * transcript still has it, a kilobyte from the start of the file; this is that read,
   * put where the rest of "what is going on in this conversation" already lives.
   *
   * Drawn asynchronously, unlike everything else on this sheet, because it is a
   * second request. Nothing appears until it arrives, and nothing appears at all if
   * it never does: a lapsed chat-service session or an older deployment with no such
   * route leaves the sheet exactly as it was, which is the rule every fetch out here
   * follows.
   */
  function paintFirstPrompt(sessionId) {
    const block = panel.querySelector('#cmo-first-block');
    if (!block || !sessionId) return;

    if (!firstPrompts.has(sessionId)) {
      askFirstPrompt(sessionId).then((value) => {
        if (value === undefined) return; // the ask failed; say nothing
        /*
         * The sheet may have been closed, replaced by another one, or moved to a
         * different conversation while this was in flight. Drawing then would put
         * one conversation's opening prompt under another conversation's answer,
         * which is worse than showing nothing.
         */
        if (!statusSheetOpen() || status?.sessionId !== sessionId) return;
        paintFirstPrompt(sessionId);
      });
      return;
    }

    const found = firstPrompts.get(sessionId);
    block.textContent = '';

    if (!found) {
      const note = document.createElement('p');
      note.className = 'cmo-hint';
      note.textContent =
        'This conversation has no opening prompt of yours — something other than a typed message started it.';
      block.appendChild(note);
      return;
    }

    const head = document.createElement('p');
    head.className = 'cmo-section';
    const sent = sinceText(Date.parse(found.at));
    head.textContent = sent ? `How this started · ${sent}` : 'How this started';
    block.appendChild(head);

    // textContent, and a plain block rather than renderMarkdown: this is text a
    // person typed, on its way back to the clipboard, so it is shown exactly as it
    // was written — backticks, asterisks, newlines and all.
    const text = document.createElement('div');
    text.className = 'cmo-first';
    text.textContent = found.text;
    block.appendChild(text);

    const row = document.createElement('div');
    row.className = 'cmo-row';
    const copy = document.createElement('button');
    copy.className = 'cmo-action cmo-alt';
    copy.id = 'cmo-first-copy';
    copy.textContent = 'Copy & close';
    copy.setAttribute('aria-label', 'Copy the prompt this conversation started with');
    row.appendChild(copy);
    block.appendChild(row);

    const note = document.createElement('p');
    note.className = 'cmo-status';
    note.id = 'cmo-first-status';
    block.appendChild(note);

    copy.addEventListener('click', async () => {
      // The text is already in hand, so the clipboard write is the first thing the
      // tap does — iOS refuses one issued after an `await`, which is the same rule
      // the dictation sheet's Copy follows.
      if (!(await copyText(found.text))) {
        selectText(text);
        note.textContent = 'Press Copy on the selection.';
        return;
      }
      // Closing is part of the job: the input this is going to be pasted into is
      // behind this sheet.
      note.textContent = 'Copied — long-press Claude’s input and paste.';
      closeSheetLater(900);
    });
  }

  /** The whole of what Claude last said, for when one line was not enough. */
  function openStatus({ auto = false } = {}) {
    /*
     * A tap is a decision to watch this conversation for a while. A redraw from
     * the poll is not, and must not extend its own licence to keep polling —
     * otherwise the limit above can never be reached.
     */
    if (!auto) {
      sheetFollowUntil = Date.now() + SHEET_FOLLOW_LIMIT;
      // A tap is a fresh look at this sheet, so the notification switch goes back to
      // describing itself rather than reporting what a previous tap did.
      notifyNote = '';
    }
    const s = status;
    if (!s) {
      openSheet(`
        <p class="cmo-title">Claude</p>
        <p class="cmo-hint">No status yet. The chat service answers this, and it has
        its own sign-in — open the project switcher if you have not signed in.</p>
        <div class="cmo-row"><button class="cmo-action cmo-alt" id="cmo-status-close">Close</button></div>`);
      panel.querySelector('#cmo-status-close').addEventListener('click', closeSheet);
      return;
    }

    const working = s.state === 'working';
    const asking = s.state === 'question';
    const when = s.last?.at ? new Date(s.last.at) : null;
    const ago = when ? Math.max(0, Math.round((Date.now() - when.getTime()) / 60000)) : null;
    const size = s.bytes ? `${(s.bytes / (1024 * 1024)).toFixed(1)} MB` : null;
    const said = s.last?.text || '';
    // No button when there is nothing to say or nothing to say it with, rather
    // than a disabled one: this sheet is answering a question, and an inert
    // control in it reads as something being broken.
    const canSpeak = Boolean(said) && (speechAvailable() || serverVoiceReady());
    /*
     * Talking it over is a separate capability from being read to, and offered
     * separately: reading needs a voice on this box, talking needs an OpenAI key and a
     * browser that can hold a WebRTC session. A deployment can have either without the
     * other, so neither button stands in for the other's absence — and when there is
     * nothing behind it there is no button, for the same reason as above.
     */
    const canTalk = Boolean(said) && talkReady();
    /*
     * A tap is the only chance to make the audio element playable — see
     * `unlockAudio`. Doing it here, rather than only on the Read aloud button,
     * is what lets the sheet read out a message that arrives while it is open:
     * that read is on a timer, and by then there is no gesture to borrow.
     */
    if (!auto && serverVoiceReady()) unlockAudio();

    const others = Array.isArray(s.conversations) ? s.conversations : [];

    /*
     * Being told when this happens without watching for it.
     *
     * Drawn from what can be known synchronously — whether the browser has the APIs
     * at all, and whether the site has been refused permission — because both of
     * those are dead ends, and a dead end is better said in a sentence than offered
     * as a button that does nothing. Whether this device is *subscribed* can only be
     * answered asynchronously, so the button starts neutral and paintNotify (called
     * at the end of this function) corrects it a tick later.
     */
    const notify = !pushSupported()
      ? '<p class="cmo-hint">This browser cannot send notifications, so nothing here can tell you when a turn ends. On an iPhone that needs this page added to the home screen first.</p>'
      : Notification.permission === 'denied'
        ? '<p class="cmo-hint">Notifications are blocked for this site, and only the browser can undo that: Chrome → ⋮ → Site settings → Notifications.</p>'
        : '<div class="cmo-row"><button class="cmo-action cmo-alt" id="cmo-notify">\u{1F514} Notify me when a turn ends</button></div>' +
          '<p class="cmo-status" id="cmo-notify-status"></p>';

    openSheet(`
      <p class="cmo-title">${
        asking
          ? 'Claude is waiting for your answer'
          : working ? 'Claude is working' : s.cutOff ? 'Claude stopped' : 'Your turn'
      }</p>
      <p class="cmo-hint" id="cmo-status-name"></p>
      <p class="cmo-hint" id="cmo-status-detail"></p>
      <!-- The question, when one is waiting — and when the last one is answered, that
           it is, which is the only defence out here against answering it twice. See
           paintAsk. -->
      <div id="cmo-ask"></div>
      <div class="cmo-said" id="cmo-status-said"></div>
      <div class="cmo-row">
        ${canSpeak ? `<button class="cmo-action" id="cmo-speak">${
          speaking ? 'Stop' : 'Read aloud'
        }</button>` : ''}
        ${canTalk ? '<button class="cmo-action cmo-alt" id="cmo-talk">\u{1F4AC} Talk it over</button>' : ''}
        ${said ? '<button class="cmo-action cmo-alt" id="cmo-said-copy">Copy</button>' : ''}
        <button class="cmo-action cmo-alt" id="cmo-status-refresh">Refresh</button>
        <button class="cmo-action cmo-alt" id="cmo-status-close">Close</button>
      </div>
      <!-- Always drawn when there is a Copy, empty until it is pressed: .cmo-status
           reserves its line, so nothing below moves out from under a thumb. -->
      ${said ? '<p class="cmo-status" id="cmo-said-copy-note"></p>' : ''}
      ${canSpeak && serverVoiceReady() ? `
        <label class="cmo-voice">Voice
          <select id="cmo-voice" aria-label="Which voice reads the message"></select>
        </label>
        <p class="cmo-hint" id="cmo-voice-note"></p>` : ''}
      <!-- One button per fenced block in the message, filled in below: the labels
           name a language that came out of the message, and nothing from outside
           this file is ever built into a string of HTML here. -->
      <div id="cmo-code-reads"></div>
      <p class="cmo-hint">${
        asking
          ? 'Nothing more happens in this conversation until this is answered. It has to be answered in the panel — tap the question card at the bottom of it. Nothing out here can answer on your behalf.'
          : working
            ? 'The panel is still loading the history; the end of it has not been written yet.'
            : s.cutOff === 'overflow'
              ? 'The last turn could not run: this conversation is too long to continue. Start a new one to carry on.'
              : s.cutOff
                ? 'The last turn was cut off before it finished — this is the last thing said before that. Send “continue” and it picks up where it stopped.'
                : 'This is the last thing Claude said. The panel is still rendering the history above it.'
      }${size ? ` This conversation is ${size} on disk, which is what the panel is reading.` : ''}</p>
      <p class="cmo-hint" id="cmo-status-follow"></p>
      <!-- The prompt this conversation began with. Empty until it is in hand, and
           empty for good if the ask fails — see paintFirstPrompt. -->
      <div id="cmo-first-block"></div>
      ${notify}
      ${others.length > 1 ? `
        <p class="cmo-hint" id="cmo-convo-head"></p>
        <div id="cmo-convos" class="cmo-convos"></div>` : ''}`);

    /*
     * Which conversation this is about, said out loud.
     *
     * Nothing outside the panel can see which conversation is on screen, so this
     * answer is a guess whenever it was not asked for by id. Naming it is what
     * makes a wrong guess correctable instead of merely stale — the list below is
     * the correction.
     */
    panel.querySelector('#cmo-status-name').textContent = [
      nameOf(s),
      pinnedSession ? 'following this one' : others.length > 1 ? 'best guess' : null,
    ]
      .filter(Boolean)
      .join(' · ');

    /*
     * Rendered, not shown as source — on a phone this sheet is the whole of the
     * answer, and an answer is written with bold and bullets in it. Still nodes and
     * never `innerHTML`: renderMarkdown builds elements and only ever puts model
     * text through textContent, so a message containing markup stays text.
     */
    const saidEl = panel.querySelector('#cmo-status-said');
    saidEl.textContent = '';
    saidEl.appendChild(
      said
        ? renderMarkdown(said)
        : document.createTextNode('Nothing has been said in this conversation yet.'),
    );
    panel.querySelector('#cmo-status-detail').textContent = [
      ago === null ? null : ago === 0 ? 'just now' : `${ago} min ago`,
      /*
       * Where the verdict came from, because the three are not equally certain: the
       * broker knows, a pid found in /proc says only that something is holding the
       * conversation, and the transcript shows the state it was left in.
       *
       * `brokered === false` is worth its own words rather than being folded into the
       * first: it had been claiming "live from the broker" about processes the broker
       * had never heard of, which is the one phrase in this line that is supposed to
       * mean somebody is certain. Null means no process, or no broker to ask.
       */
      s.source !== 'broker'
        ? 'read from the transcript'
        : s.brokered === false ? 'a process outside the broker' : 'live from the broker',
      // Not the same statement as "idle": no process means nothing can be working,
      // where no device merely means nobody is watching one that is.
      s.live === false ? 'nothing running it' : s.clients === 0 ? 'no device attached' : null,
    ]
      .filter(Boolean)
      .join(' · ');
    panel.querySelector('#cmo-status-close').addEventListener('click', closeSheet);
    panel.querySelector('#cmo-notify')?.addEventListener('click', toggleNotify);
    paintAsk(s);
    paintFirstPrompt(s.sessionId);

    /*
     * The answer, on the clipboard.
     *
     * Selecting it by hand works now, but not well here: the message scrolls inside
     * its own box, and a drag through a scrollable block on a phone scrolls it rather
     * than extending the selection. So the whole message gets a button, the way the
     * opening prompt below already has one.
     *
     * The markdown, not the rendering. What an answer is copied *into* — a commit
     * message, a reply, an issue — is text, and the asterisks, backticks and fences
     * are the part that survives the trip.
     *
     * This one does not close the sheet, unlike the prompt's Copy: that text is on its
     * way into Claude's input, which is behind the sheet, and this text is on its way
     * out of this machine entirely.
     */
    panel.querySelector('#cmo-said-copy')?.addEventListener('click', async () => {
      const note = panel.querySelector('#cmo-said-copy-note');
      // The write is the first thing the tap does — iOS refuses a clipboard write
      // issued after an `await`, the same rule the other two Copy buttons follow.
      if (!(await copyText(said))) {
        // Refused: leave the message selected so the platform's own Copy can take it.
        selectText(saidEl);
        if (note) note.textContent = 'Press Copy on the selection.';
        return;
      }
      if (note) note.textContent = 'Copied — the message as Claude wrote it, markdown and all.';
    });

    // Ask again, in place. The heartbeat is fifteen seconds and someone reading
    // this sheet has a more specific question than that.
    panel.querySelector('#cmo-status-refresh').addEventListener('click', async () => {
      const button = panel.querySelector('#cmo-status-refresh');
      button.textContent = 'Refreshing…';
      await refreshStatus();
      openStatus();
    });

    /*
     * The other conversations in this project.
     *
     * This is the honest answer to "which conversation am I in", given that the
     * panel will not say: show them all, name each, and let a tap decide. Tapping
     * one pins it, so the chip and this sheet follow that conversation instead of
     * the guess — which is what someone who has just switched actually wants.
     */
    const list = panel.querySelector('#cmo-convos');
    if (list) {
      const busy = others.filter((c) => c.state === 'working').length;
      // Counted separately and said first: a conversation waiting on an answer is the
      // one to open, and it is the one that will still be waiting in an hour.
      const waiting = others.filter((c) => c.state === 'question').length;
      panel.querySelector('#cmo-convo-head').textContent =
        `${others.length} conversations here${waiting ? `, ${waiting} waiting on you` : ''}${
          busy ? `, ${busy} working` : ''
        } — tap one to follow it`;

      for (const c of others) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `cmo-convo${c.current ? ' cmo-current' : ''}`;
        const dot = document.createElement('span');
        dot.className = `cmo-dot${
          c.state === 'working' ? ' cmo-busy' : c.state === 'question' ? ' cmo-ask' : ''
        }`;
        const label = document.createElement('span');
        label.className = 'cmo-convo-label';
        // A title and a message are both model output. Never markup.
        label.textContent = nameOf(c);
        const meta = document.createElement('span');
        meta.className = 'cmo-convo-meta';
        meta.textContent = [
          // "stopped" earns its place in a list: it is the row you would otherwise
          // keep opening to see whether the answer had landed yet. "waiting on you"
          // earns it twice over — that row will never move on its own.
          c.state === 'question'
            ? 'waiting on you'
            : c.state === 'working' ? 'working' : c.cutOff ? 'stopped' : 'your turn',
          sinceText(c.at),
          c.live === false ? 'not running' : null,
        ]
          .filter(Boolean)
          .join(' · ');
        row.append(dot, label, meta);
        row.addEventListener('click', async () => {
          // Whatever is being read aloud belongs to the conversation being left,
          // and hearing it under a sheet describing a different one is worse than
          // silence. Same on the way back.
          stopSpeech();
          pinnedSession = c.sessionId;
          await refreshStatus();
          openStatus();
        });
        list.appendChild(row);
      }

      if (pinnedSession) {
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'cmo-convo cmo-convo-back';
        back.textContent = 'Stop following — go back to the active one';
        back.addEventListener('click', async () => {
          stopSpeech();
          pinnedSession = null;
          await refreshStatus();
          openStatus();
        });
        list.appendChild(back);
      }
    }

    /*
     * Read aloud, and Stop.
     *
     * `speak` is called straight out of the tap with the text already in hand —
     * no await in front of it — because iOS refuses speech that did not start
     * inside a gesture. The sheet is left open afterwards rather than closed: the
     * voice outlives it either way, and dismissing it is how you get back to
     * watching the panel while it reads.
     */
    const speakBtn = panel.querySelector('#cmo-speak');
    if (speakBtn) {
      speakBtn.addEventListener('click', () => {
        if (speaking) {
          stopSpeech();
          return;
        }
        // Said first, when a turn is still running or was cut off: otherwise the
        // previous message is heard as the answer to the thing still being worked on.
        const note = statusNote(s);
        const started = speak(said, note ? `${note} Last message:` : '');
        if (!started) {
          panel.querySelector('#cmo-status-detail').textContent =
            'Nothing was spoken — there is no voice on this device, or the mic is live.';
        }
      });
    }

    /*
     * Talk it over — a spoken conversation about this message, with something that
     * cannot act on it. See the talk section below for what it is and is not.
     *
     * Started straight out of the tap, like the read and for a harder reason: iOS
     * refuses a `getUserMedia` that no gesture asked for, and there is no second
     * chance at it. What it is handed is the message as it was written — fences and
     * all, because the code in it is often the thing being asked about — and the prompt
     * this conversation began with, if this page already has it.
     *
     * That prompt is not the turn before this message, and cannot be: /api/claude-status
     * answers with the last assistant message and, separately, the conversation's
     * opening prompt, with nothing in between. The opening prompt is the honest answer
     * to "what is this about" on this surface, and an empty one is treated by the server
     * as not provided rather than guessed at.
     */
    panel.querySelector('#cmo-talk')?.addEventListener('click', () => {
      startTalk(said, firstPrompts.get(s.sessionId)?.text || '');
    });

    /*
     * A button for each code block, because "Code block." is not always the answer.
     *
     * The read of the message skips the code and says it was there; this is how you
     * ask for the part that was skipped. Numbered to match what the read says, and
     * labelled with the language and the length, which is what tells two blocks in
     * one message apart by ear.
     *
     * Rendered even when this device is set to its own voice — `speakCode` explains
     * why a block cannot be read that way, and a button that is missing explains
     * nothing. When there is no server voice at all there is nothing to explain in a
     * button either, so that case is a sentence.
     */
    const codeWrap = panel.querySelector('#cmo-code-reads');
    if (codeWrap) {
      const blocks = codeBlocks(said).filter((block) => block.code.trim());
      if (blocks.length && !serverVoiceReady()) {
        const note = document.createElement('p');
        note.className = 'cmo-hint';
        note.textContent =
          blocks.length === 1
            ? 'The code block above is read by the server voice, which this device does not have.'
            : `The ${blocks.length} code blocks above are read by the server voice, which this device does not have.`;
        codeWrap.appendChild(note);
      } else if (blocks.length) {
        codeWrap.className = 'cmo-row';
        for (const block of blocks) {
          const button = document.createElement('button');
          button.className = 'cmo-action cmo-alt';
          const parts = [
            blocks.length > 1 ? `Read block ${block.index + 1}` : 'Read the code',
            block.lang,
            `${block.lines} line${block.lines === 1 ? '' : 's'}`,
          ].filter(Boolean);
          button.dataset.cmoBlock = String(block.index);
          button.dataset.cmoLabel = parts.join(' · ');
          button.textContent = button.dataset.cmoLabel;
          button.addEventListener('click', () => {
            // Its own Stop while it is the one reading, like the message button —
            // and a tap on a different block switches to that block instead of
            // stopping, which is what `speakCode` does by stopping first.
            if (speaking && readingBlock === block.index) {
              stopSpeech();
              return;
            }
            const why = speakCode(block);
            if (why) sayWhy(why);
          });
          codeWrap.appendChild(button);
        }
      }
    }

    /*
     * Which voice reads it.
     *
     * Options as nodes, not as interpolated markup: the names come from the AWS
     * API rather than from this file, and the rule on this surface is that nothing
     * from outside it is ever built into a string of HTML.
     *
     * Only the voices for this phone's own language, which turns forty-three
     * options into a dozen. The rest are a language nobody here reads in, and a
     * picker that has to be scrolled past ten of those to reach the local ones is
     * worse than one that offers fewer.
     */
    const voiceSelect = panel.querySelector('#cmo-voice');
    if (voiceSelect) {
      const add = (value, label) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        voiceSelect.appendChild(option);
      };
      const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
      const all = serverSpeech.voices || [];
      const languageOf = (v) => String(v.language || '').toLowerCase();
      const isMine = (v) => languageOf(v).startsWith(lang);
      /*
       * Plus every voice that can read a language this phone is not set to.
       *
       * The filter above is about a picker nobody wants to scroll — but the message
       * is not always in the phone's language, and on this deployment that is the
       * normal case rather than the exception: Claude answers in Hebrew on a phone
       * set to English, and Polly has no Hebrew voice at all. Hiding the Hebrew and
       * the multilingual voices is how such a phone ends up with a picker full of
       * voices, none of which can say the message it was sent.
       */
      const alsoOffer = (v) => languageOf(v) === 'multi' || languageOf(v).startsWith('he');
      const mine = all.filter(isMine);
      const others = all.filter((v) => !isMine(v) && alsoOffer(v));
      const offered = mine.length || others.length ? [...mine, ...others] : all;
      for (const voice of offered) {
        // 'multi' is not a language code and should not be shown as one: these are
        // one voice reading whatever script it is handed.
        const spoken = languageOf(voice) === 'multi' ? 'any language' : voice.language;
        add(voice.id, `${voice.id} · ${spoken}${voice.gender ? ` · ${voice.gender}` : ''}`);
      }
      if (speechAvailable()) add('browser', 'This browser’s own voice');

      // A stored voice this deployment no longer offers leaves the select empty,
      // which is the moment to fall back to the default rather than to show a
      // blank picker and then read in something else.
      voiceSelect.value = voicePref() || serverSpeech.voice || '';
      if (!voiceSelect.value) voiceSelect.value = serverSpeech.voice || '';

      /*
       * What choosing this voice means, in the terms that differ between them:
       * whether it can read Hebrew, and what it costs. Asked of the voice's
       * `provider` rather than assuming Polly, which is what this said when Polly
       * was the only server voice there was.
       */
      const paintVoiceNote = () => {
        const noteEl = panel.querySelector('#cmo-voice-note');
        if (!noteEl) return;
        if (voiceSelect.value === 'browser') {
          noteEl.textContent =
            'Instant, free, and it sounds like a satnav. Works with no AWS permission and no network. Cannot read a code block — that is done on the server.';
          return;
        }
        const chosen = (serverSpeech.voices || []).find((v) => v.id === voiceSelect.value);
        const provider = chosen?.provider || 'polly';
        const hebrew = String(chosen?.language || '').toLowerCase().startsWith('he');
        noteEl.textContent =
          provider === 'azure'
            ? // One free resource, one monthly allowance, two languages — so what
              // differs between two Azure voices here is only which language it is
              // good at. The English one is the default for anyone who has not
              // chosen, which is why the allowance is worth stating on both.
              `${hebrew ? 'A Hebrew neural voice' : 'An English neural voice'}, on Azure’s free tier — half a million characters a month, and nothing is charged past that: it stops until the 1st, and Polly keeps working. ${hebrew ? 'Hebrew only.' : ''}`.trim()
            : provider === 'openai'
              ? 'One voice for every language, so it reads a message with both Hebrew and English in it. Slower to start than the others, and metered by the character.'
              : 'Synthesised on the server by Polly’s generative engine — about two seconds before the first word, then continuous. A full-length message costs about seven cents. No Hebrew.';
      };

      voiceSelect.addEventListener('change', () => {
        setVoicePref(voiceSelect.value);
        // Whatever is playing is in the old voice, and hearing the rest of it in
        // that voice after choosing another one reads as the setting not working.
        stopSpeech();
        // A change is a gesture too, so this is a free chance to make the element
        // playable — which is what the auto-read while this sheet is open needs.
        if (voiceSelect.value !== 'browser') unlockAudio();
        paintVoiceNote();
      });
      paintVoiceNote();
    }

    /*
     * Say, in the sheet, that the sheet is watching — and stop saying it the
     * moment it isn't. A sheet that quietly refreshes itself is indistinguishable
     * from one that does not, right up to the point where a phone starts talking.
     */
    const following = Date.now() < sheetFollowUntil;
    panel.querySelector('#cmo-status-follow').textContent = !following
      ? 'This has stopped refreshing itself — tap Refresh, or reopen it, to follow along again.'
      : speechAvailable() || serverVoiceReady()
        ? 'Refreshing every 5 seconds while this is open, and reading out anything new that Claude says. Stop silences the message being read; closing this stops it following.'
        : 'Refreshing every 5 seconds while this is open.';

    /*
     * The baseline for "something changed", seeded from what was just drawn — so
     * the message already on screen is never read out as if it had just arrived —
     * and the timer that does the looking.
     */
    sheetShown = { state: s.state, text: s.last?.text || '', sessionId: s.sessionId };
    statusSheetGeneration = sheetGeneration;
    followStatusSheet();
    // Correct the notification line, which cannot be drawn from anything the
    // sheet already knows: only the browser can say whether this device is
    // subscribed, and it answers asynchronously.
    paintNotify();
  }

  // ------------------------------------------------------------ notifications
  /*
   * Ask to be told when a turn ends, from the surface the turns are on.
   *
   * The switch already existed — in the chat app's Settings sheet — and the
   * sessions it notifies about are precisely the ones out here: the Claude Code
   * panel in this editor, and anything under tmux. So someone who only ever opens
   * the editor had no way to turn on the one feature written for them, and the
   * honest answer to "how do I enable this" was "install a second app and go
   * looking in a sheet". This is that switch, on the sheet that already answers
   * "has Claude finished".
   *
   * Everything below it is shared with the chat app: one origin, one service worker
   * under /chat/, one subscription, one row in the server's device list. Turning it
   * on here is the same act as turning it on there, which is why the wording says
   * "this device" and never "this app".
   *
   * The plumbing is repeated from chat-service/public/app.js rather than imported.
   * This file is a plain script that nginx injects into code-server's HTML; an
   * import would make the button depend on a second request and on whatever CSP
   * code-server ships that week, and a notification switch that fails to load is
   * worse than sixty duplicated lines. push-test.js covers the server side of it
   * for both callers.
   */
  const PUSH_SW = '/chat/sw.js';
  const PUSH_SCOPE = '/chat/';
  const pushSupported = () =>
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  /** base64url → bytes. `applicationServerKey` takes nothing else. */
  function pushKeyBytes(base64url) {
    const padded = base64url.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  /** The key a subscription was made with, back in the form the server names it. */
  const pushKeyOf = (subscription) => {
    const key = subscription?.options?.applicationServerKey;
    if (!key) return null;
    let out = '';
    for (const byte of new Uint8Array(key)) out += String.fromCharCode(byte);
    return btoa(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  /**
   * The worker if it is already there, without installing one.
   *
   * Everything that only reads the state goes through this, so opening the editor
   * on a device that has never asked for notifications registers nothing.
   */
  async function pushWorkerIfAny() {
    if (!pushSupported()) return null;
    return navigator.serviceWorker.getRegistration(PUSH_SCOPE).catch(() => null);
  }

  /** Whether this device is subscribed, without asking or installing anything. */
  async function pushSubscription() {
    const reg = await pushWorkerIfAny();
    if (!reg) return null;
    return reg.pushManager.getSubscription().catch(() => null);
  }

  /**
   * The chat service, with its two failures named.
   *
   * A 401 here is the ordinary one: the editor and the chat API are gated
   * separately, so a device signed into code-server alone gets one — and unlike the
   * status chip, which stays silent about it, a switch that was just tapped has to
   * say why nothing happened.
   */
  async function pushApi(path, options) {
    const res = await fetch(path, options);
    if (res.status === 401) {
      throw new Error(
        'the chat service needs its own sign-in — open the project switcher and tap Sign in',
      );
    }
    if (!res.ok) throw new Error(`the server answered ${res.status}`);
    return res;
  }

  /**
   * Subscribe this device and tell the server.
   *
   * `Notification.requestPermission()` is the caller's job, before anything is
   * awaited: the prompt needs the tap that got here to still be the most recent
   * thing that happened.
   *
   * Note what is *not* awaited: `navigator.serviceWorker.ready`. That promise
   * resolves for the worker controlling *this page*, and this page is /editor/,
   * which /chat/sw.js will never control — awaiting it here would hang forever.
   * `register()` hands back the registration, and its pushManager works from it.
   */
  async function pushSubscribeHere({ fresh = false } = {}) {
    const reg = await navigator.serviceWorker.register(PUSH_SW);
    const { key } = await pushApi('/api/push/key').then((r) => r.json());

    let subscription = await reg.pushManager.getSubscription();
    // A subscription is bound to the key it was made with. If the server's keypair
    // has changed — a lost volume, a rebuilt box — the old subscription still looks
    // healthy here while every notification sent to it fails at the push service.
    //
    // `fresh` is the other reason to throw one away, and it cannot be detected here
    // at all: the push service has forgotten the endpoint while the browser goes on
    // handing out a subscription that still carries the right key. Only the server
    // hears about that, which is why it is passed in rather than worked out.
    if (subscription && (fresh || pushKeyOf(subscription) !== key)) {
      await subscription.unsubscribe().catch(() => {});
      subscription = null;
    }
    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        // Required by Chrome, and true: every push this app sends is shown.
        userVisibleOnly: true,
        applicationServerKey: pushKeyBytes(key),
      });
    }
    const answer = await pushApi('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription),
    }).then((r) => r.json());
    /*
     * The server has heard from the push service that this endpoint is dead, so the
     * subscription in hand is worthless however healthy it looks. Replace it now,
     * while a load is already happening and nobody has to be asked for anything —
     * this is the loop that made notifications stop for a day without a single error
     * on either side. Once only, so a server that kept saying `gone` cannot spin.
     */
    if (answer?.gone && !fresh) return pushSubscribeHere({ fresh: true });
    return subscription;
  }

  /** Ask the server to send one to *this* device, and name which one that is. */
  const pushTestHere = (subscription) =>
    pushApi('/api/push/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    }).then((r) => r.json());

  /**
   * What to say about a test notification, from this device's own result.
   *
   * `sent` is a total over every subscribed device, and reading success out of it is
   * how this switch came to report "a test notification has just been sent to this
   * device" one second after the push service refused that very device — the phone
   * looked configured, stayed silent, and nothing anywhere disagreed for a day.
   * `mine` is the answer to the question actually being asked.
   */
  function pushTestNote(result) {
    if (!result.mine) {
      return result.sent
        ? 'On. A test notification was sent, but the server could not tell which device asked — so it may have gone to another one.'
        : 'Subscribed, but the test notification could not be sent to any device.';
    }
    if (result.mine.gone) {
      return 'Subscribed, but the push service has forgotten this device twice over. Clearing the app usually fixes it: open /chat/reset.html here, then turn this back on.';
    }
    if (!result.mine.ok) {
      return `Subscribed, but the push service refused the test for this device (${result.mine.status}). Nothing will arrive here until that clears.`;
    }
    return 'On, and a test notification has just been sent to this device. If it does not appear within a few seconds, Android is holding it: check Settings › Apps › Chrome › Notifications.';
  }

  /** Stop this device, at both ends. */
  async function pushUnsubscribeHere() {
    const subscription = await pushSubscription();
    if (!subscription) return;
    // Server first: the endpoint is what identifies this device there, and once the
    // browser has dropped the subscription that string is gone.
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    }).catch(() => {});
    await subscription.unsubscribe().catch(() => {});
  }

  /**
   * Keep an existing subscription honest, at every load. Never prompts.
   *
   * Three silent failures this repairs, all of which read as "notifications just
   * stopped" from the phone: the server losing its device list, which lives on
   * disk; a rotated keypair leaving a subscription that can no longer be sent to;
   * and — the one that actually happened — an endpoint the push service has
   * forgotten, which pushSubscribeHere replaces when the server says so. The chat
   * app does this at boot; on a phone that only opens the editor, this is the only
   * place it can happen.
   */
  async function pushRepair() {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    if (!(await pushSubscription())) return;
    await pushSubscribeHere().catch(() => {});
  }

  /*
   * The last thing this switch said about itself, kept across a redraw.
   *
   * The sheet it lives on redraws itself every five seconds, and a message that
   * says "a test notification has just been sent" is worth nothing if it is wiped
   * two seconds later by the poll. Opening the sheet by hand clears it: at that
   * point it is describing something that happened a sheet ago.
   */
  let notifyNote = '';

  /**
   * What the button says, from what is true now.
   *
   * `note` is what just happened, when something did; without it the line describes
   * the state, because this is also drawn when the sheet opens.
   */
  async function paintNotify(note) {
    if (note !== undefined) notifyNote = note;
    const btn = panel.querySelector('#cmo-notify');
    if (!btn) return;
    const on = Boolean(await pushSubscription());
    // Re-queried: an await in a sheet is long enough for another sheet to replace it.
    const button = panel.querySelector('#cmo-notify');
    if (!button) return;
    button.dataset.on = on ? '1' : '';
    button.disabled = false;
    button.textContent = on ? '\u{1F514} Turn off notifications' : '\u{1F514} Notify me when a turn ends';
    const line = panel.querySelector('#cmo-notify-status');
    if (!line) return;
    line.textContent =
      notifyNote ||
      (on
        ? 'On for this device. One notification per conversation when a turn ends out here — this panel, or anything under tmux — and nothing for a turn that ended more than ten minutes ago.'
        : 'Buzzes this phone when Claude finishes a turn in the editor or under tmux, with the project and the first line of the answer. Asked for permission once.');
  }

  /**
   * The tap.
   *
   * `Notification.requestPermission()` comes first, before any await, for the
   * activation reason above. Off is the other direction and needs no permission.
   */
  async function toggleNotify() {
    const btn = panel.querySelector('#cmo-notify');
    if (!btn) return;
    if (btn.dataset.on === '1') {
      btn.disabled = true;
      await pushUnsubscribeHere();
      await paintNotify(
        'Off for this device. Nothing will be sent here until this is turned back on.',
      );
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      await paintNotify(
        permission === 'denied'
          ? 'Blocked for this site, and only the browser can undo that: Chrome → ⋮ → Site settings → Notifications. Android may also list this app under Settings › Apps.'
          : 'Not enabled — the permission prompt was dismissed. Tapping this again asks once more.',
      );
      return;
    }

    btn.disabled = true;
    const line = panel.querySelector('#cmo-notify-status');
    if (line) line.textContent = 'Turning them on…';
    try {
      let subscription = await pushSubscribeHere();
      /*
       * A test notification, sent by the server to this device.
       *
       * Everything can be correct at both ends and still produce nothing on the
       * phone — permission granted to the browser but revoked for the site, a
       * battery optimiser holding the worker down — and the alternative to finding
       * that out now is finding it out by missing the notification that mattered.
       */
      let result = await pushTestHere(subscription);
      if (result.mine?.gone) {
        // The push service has just refused the endpoint this phone is holding, and
        // that refusal is the only evidence anywhere that it is dead — the browser
        // hands it over, its key matches, nothing else disagrees. So the test is
        // also the discovery: replace it and try once more before saying anything.
        subscription = await pushSubscribeHere({ fresh: true });
        result = await pushTestHere(subscription);
      }
      await paintNotify(pushTestNote(result));
    } catch (err) {
      await paintNotify(`Could not turn them on: ${err.message}`);
    }
  }

  // ------------------------------------------------------- reading it aloud
  /*
   * Say the last message out loud, when asked to.
   *
   * The other half of the mic. Dictation carries a phone-shaped question into
   * Claude; this carries the answer back out, for the times you are holding the
   * phone rather than reading it — walking, driving, or waiting on a turn that
   * has been running for an hour. The final message of a turn is the one worth
   * hearing: it is where the summary of everything that just happened is.
   *
   * It is a button, deliberately, and not something that fires whenever a turn
   * ends. A turn can finish while you are mid-sentence with someone, in another
   * app, or twenty minutes after you stopped waiting for it — and a phone that
   * starts talking by itself in any of those is worse than one that stays quiet.
   *
   * There is exactly one exception, and the point of it is that it cannot be any
   * of those cases: while the status sheet is open, a message arriving is read out
   * as it lands. That sheet is only open because it was tapped open, it is on
   * screen while it happens, and dismissing it ends it. See followStatusSheet —
   * everything here is still driven from a tap, one way or another.
   *
   * This cannot be done from the extension, and that is not a limitation of this
   * repo. The panel is a proprietary webview, and the extension host is a node
   * process with no audio device — nothing in either can make a sound. The
   * workbench page can, and it is also the one place that already has the text,
   * from /api/claude-status. So the overlay speaks, and the panel is untouched.
   *
   * There are two voices, and which one is used is a setting in this sheet.
   *
   *   The **server voice** is the default and the reason this feature is worth
   *   using: a neural voice synthesised by /api/speak and played here as ordinary
   *   audio, which sounds like a person reading rather than a satnav — see
   *   chat-service/speak.js. Which provider it comes from is that file's decision
   *   and not this one's: an Azure voice on the free tier where the box has the
   *   credentials, Polly's generative engine where it does not, and Polly at about
   *   seven cents a message for anyone who picks it in this sheet. Either way the
   *   first word takes about two seconds, which is why the server cuts a message
   *   into pieces and this plays them in a chain.
   *
   *   The **browser voice** is `speechSynthesis`, which was all of this feature
   *   until now. It is instant and free and it sounds like a satnav from 2009. It
   *   stays for three reasons that are all real: it works with no AWS permission
   *   at all, it is what answers when the server refuses or the network is gone,
   *   and it is the only one that starts the very instant a thumb comes off the
   *   button. Anyone who prefers it can pick it.
   *
   * Two constraints shape the rest, and both are ones the dictation sheet already
   * lives with:
   *
   *   iOS refuses speech that did not start inside a tap. So the first utterance
   *   is queued synchronously from the click handler, never after an `await` —
   *   exactly the rule the clipboard write follows. `openStatus` has already
   *   refreshed the status, so the text is in hand and nothing is fetched here.
   *
   *   Speaking while the recognizer is listening dictates Claude's own words back
   *   into the composer. So opening the dictation sheet stops the speech, and
   *   this never starts while dictation is running.
   */

  /*
   * Utterances are queued one at a time, not all at once.
   *
   * Two reasons, and the second is the one that matters on this surface: iOS
   * speaks only the first of a long queue and drops the rest, and a short current
   * utterance is what makes Stop stop now instead of at the end of the message.
   */
  const SPEECH_CHUNK = 220;

  let speechChunks = [];
  let speaking = false;
  /*
   * Which code block is being read, or -1 for none and for the message itself.
   *
   * Kept out here beside `speaking` because `paintSpeech` needs it, and that runs
   * during the first paint of the bar — a declaration further down would be in its
   * temporal dead zone at that point. It is the same question `speaking` answers,
   * asked about a button that there are several of.
   */
  let readingBlock = -1;

  const speechAvailable = () =>
    typeof window.speechSynthesis !== 'undefined' &&
    typeof window.SpeechSynthesisUtterance === 'function';

  /*
   * What /api/voice-status said about the server voice: which voices there are,
   * which is the default, and whether this box can synthesise at all. Asked once
   * per page load, and it has to be in hand *before* the tap — iOS will not let a
   * fetch happen between the gesture and the sound, so a read that had to ask
   * first would be a read that never started.
   *
   * Null means no server voice, for any reason: an older deployment with no such
   * route, a lapsed chat-service session (this surface is gated separately from
   * code-server), an instance role without Polly, or no network. All four have the
   * same answer — the browser's own voice, silently.
   */
  let serverSpeech = null;
  const serverVoiceReady = () =>
    Boolean(serverSpeech?.configured) &&
    Array.isArray(serverSpeech.voices) &&
    serverSpeech.voices.length > 0 &&
    typeof window.Audio === 'function';

  /*
   * What the same route said about a spoken conversation: whether this box has an
   * OpenAI key at all, which model and voice it would use, and how much of the day's
   * allowance is left. Null means it cannot hold one — no key, an older deployment, a
   * lapsed chat-service session — and that is a sheet with no such button on it rather
   * than a button that explains itself after the tap.
   */
  let serverTalk = null;
  /*
   * Whether this page has ever had an answer from /api/voice-status.
   *
   * Not the same question as `serverSpeech`: a box can answer "no voice, and here is a
   * spoken conversation" or the other way round, and both are answers. The bar's tap
   * re-asks only when nothing has answered yet — which is the normal way round on this
   * surface, since the editor has its own password and the chat service has another.
   */
  let voicesAnswered = false;

  async function loadSpeechVoices() {
    try {
      const res = await fetch('/api/voice-status', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const body = await res.json();
      voicesAnswered = true;
      serverSpeech = body?.speech?.configured ? body.speech : null;
      serverTalk = body?.realtime?.configured ? body.realtime : null;
    } catch {
      /* no server voice available; speechSynthesis is the answer and needs no fetch */
    }
  }

  /*
   * Which voice, remembered per device.
   *
   * Empty means "whatever the server's default is", rather than a copy of the
   * server's default frozen at first use: the default is decided in one place
   * (`preferredVoice` in chat-service/speak.js, which prefers the free provider
   * unless SPEAK_VOICE names one) and a phone that never chose should follow it —
   * including when it changes. 'browser' is the explicit choice of the local voice.
   */
  const VOICE_KEY = 'cmo-voice';
  function voicePref() {
    try {
      return localStorage.getItem(VOICE_KEY) || '';
    } catch {
      return '';
    }
  }
  function setVoicePref(value) {
    try {
      if (value) localStorage.setItem(VOICE_KEY, value);
      else localStorage.removeItem(VOICE_KEY);
    } catch {
      /* private mode: the choice holds for this page and no longer */
    }
  }
  /** The voice to ask for, or '' to let the server pick. */
  function chosenVoice() {
    const wanted = voicePref();
    if (!wanted || wanted === 'browser') return '';
    return (serverSpeech?.voices || []).some((v) => v.id === wanted) ? wanted : '';
  }
  /** Is the browser's own voice the one that has been asked for? */
  const wantsBrowserVoice = () => voicePref() === 'browser';

  /*
   * The audio element, and the tap that makes it usable.
   *
   * iOS will not play audio that no gesture asked for, and the permission is
   * granted to *an element*, not to the page: an `<audio>` that has been played
   * once inside a tap can be given a new `src` and played again from a timer
   * afterwards. That is what makes the two things this needs possible at all —
   * fetching the audio after the tap (there is no way around that; it does not
   * exist yet when the button is pressed), and reading out a message that arrives
   * while the sheet is open, which is not a tap at all.
   *
   * So one element, created and unlocked on the first tap and then kept for the
   * life of the page, and a silent WAV to unlock it with. Never replaced: a new
   * element would be locked again, and the next read would be silence.
   */
  /*
   * Every audio URL on this surface is same-origin, and that is a constraint, not
   * a preference.
   *
   * This overlay is injected into code-server's workbench, and that page carries
   * code-server's own Content-Security-Policy. It says `media-src 'self'`. Neither
   * a `data:` URL nor a `blob:` one is `'self'`, so both are refused by the browser
   * the moment they are handed to the element — after the audio has been fetched,
   * which is what made this so confusing to find: the network showed the mp3
   * arriving and the phone still read the message in the robotic voice, because a
   * blocked source fires `error` and `readTrouble` falls back.
   *
   * So the silence comes from `/api/speak/silence` and the segments are played
   * straight from `/api/speak`. The policy belongs to code-server, ships in its
   * server bundle with per-build nonces, and would be undone by the next upgrade if
   * it were patched — so this side is the one that has to hold. `overlay-test.js`
   * asserts that nothing else ever reaches the element.
   */
  const SILENCE = '/api/speak/silence';
  let audioEl = null;

  function unlockAudio() {
    if (typeof window.Audio !== 'function') return false;
    if (!audioEl) {
      audioEl = new window.Audio();
      audioEl.preload = 'auto';
    }
    try {
      audioEl.onended = null;
      audioEl.onerror = null;
      audioEl.src = SILENCE;
      const played = audioEl.play();
      // Older browsers return undefined here rather than a promise, and a rejection
      // is not a failure worth reporting: it means this was not a gesture, and the
      // read that follows will say so if it turns out to matter.
      if (played && typeof played.catch === 'function') played.catch(() => {});
    } catch {
      /* as above */
    }
    return true;
  }

  /**
   * The fenced code blocks in a message, in the order they appear.
   *
   * Two callers, and they need the same answer: the read button offered for each
   * block, and `speakable`, which has to say that a block was there without
   * reading it. One scanner rather than a regex each, so the numbers a listener
   * hears ("Code block 2") and the numbers on the buttons cannot disagree.
   *
   * Line-anchored, because that is what a fence is — three backticks in the middle
   * of a sentence are prose about backticks. An unterminated block is kept and
   * runs to the end: that is a message still being written, which is a normal
   * thing to find in a transcript being read while it grows.
   */
  function codeBlocks(markdown) {
    const source = String(markdown == null ? '' : markdown);
    const blocks = [];
    let open = null;
    let offset = 0;
    for (const line of source.split('\n')) {
      // The newline `split` removed, which the last line does not have.
      const next = Math.min(offset + line.length + 1, source.length);
      const fence = /^\s{0,3}(```+|~~~+)(.*)$/.exec(line);
      if (open) {
        // A closing fence is the same character as the one that opened the block,
        // at least as long, and has nothing after it. Everything else is content —
        // including ``` inside a ~~~ block, which is how a markdown example is
        // written.
        const closes =
          fence &&
          fence[1][0] === open.marker[0] &&
          fence[1].length >= open.marker.length &&
          !fence[2].trim();
        if (closes) {
          open.end = next;
          blocks.push(open);
          open = null;
        } else {
          open.body.push(line);
        }
      } else if (fence) {
        open = {
          marker: fence[1],
          // The info string's first word is the language; the rest is whatever the
          // renderer wanted (`js title="x"`). Narrowed to the characters a tag is
          // made of, because this ends up in a button label and in a request body.
          lang: (fence[2].trim().split(/\s+/)[0] || '').replace(/[^\w+#.-]/g, '').slice(0, 20),
          body: [],
          start: offset,
          end: source.length,
        };
      }
      offset = next;
    }
    if (open) blocks.push(open);
    return blocks.map((block, index) => {
      const code = block.body.join('\n');
      return {
        index,
        lang: block.lang,
        code,
        lines: code.trim() ? code.replace(/\n+$/, '').split('\n').length : 0,
        start: block.start,
        end: block.end,
      };
    });
  }

  /**
   * Markdown as something worth listening to.
   *
   * A final message is written to be *read*: bold, bullets, backticks, file
   * paths, links, and a fenced diff in the middle of it. Spoken literally that is
   * "asterisk asterisk Done asterisk asterisk", every slash of every path read
   * out, and a minute of punctuation names. So the markup is removed rather than
   * pronounced, and the parts that are not prose at all — code blocks, URLs — are
   * replaced by the fact that they were there, because silently dropping them
   * would misrepresent the message.
   *
   * Deterministic and local, on purpose. A model would do this better, and
   * `polish.js` is right there — but it would put a network round trip and a bill
   * between the tap and the first word, and iOS only allows speech that starts
   * inside the tap. This is the one thing in the app that has to begin
   * immediately.
   */
  function speakable(markdown) {
    let text = String(markdown == null ? '' : markdown);

    /*
     * Code is not prose and it is on screen anyway, so the read says that a block
     * was there and moves on. Each block has its own button for hearing it read
     * properly — see `speakCode` — which is why they are numbered once there is
     * more than one: "Code block 2" is the only thing that tells a listener which
     * of the buttons reads the part that was skipped. One block needs no number.
     */
    const blocks = codeBlocks(text);
    if (blocks.length) {
      let out = '';
      let at = 0;
      for (const block of blocks) {
        out += text.slice(at, block.start);
        out += blocks.length > 1 ? ` Code block ${block.index + 1}. ` : ' Code block. ';
        at = block.end;
      }
      text = out + text.slice(at);
    }

    // Images say nothing out loud. Links keep their label and lose their target:
    // the label is the sentence, the URL is unspeakable.
    text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
    text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    text = text.replace(/<(https?:\/\/[^>]*)>/g, ' link ');
    text = text.replace(/\bhttps?:\/\/\S+/g, ' link ');

    // Inline code is usually an identifier, a flag or a filename — all of them
    // words. It is the backticks that are not.
    text = text.replace(/`+([^`]*)`+/g, '$1');

    /*
     * Line-level markers, before the inline ones: a `*` opening a list item and a
     * `*` opening emphasis are told apart by the space after it, and only while
     * the line still begins where it began.
     *
     * The full stop is added here, on the lines that had a marker, rather than
     * later on every line. A heading or a bullet ends where it ends whatever
     * follows it, and this is the last point at which that is still known — after
     * the marker is gone, a bullet and the second line of a wrapped sentence look
     * identical, and giving both a full stop invents a sentence break in the
     * middle of the prose one.
     */
    text = text
      .split('\n')
      .map((line) => {
        const stripped = line
          .replace(/^\s{0,3}#{1,6}\s+/, '')
          .replace(/^\s{0,3}>\s?/, '')
          .replace(/^\s{0,3}([-*+]|\d{1,3}[.)])\s+/, '')
          .replace(/^\s*\[[ xX]\]\s*/, '')
          .replace(/^\s{0,3}([-*_])(\s*\1){2,}\s*$/, '')
          .trim();
        if (stripped === line.trim() || !stripped) return stripped;
        return /[.!?:;,]$/.test(stripped) ? stripped : `${stripped}.`;
      })
      .join('\n');

    // Tables read as prose only if the pipes become pauses; the separator row is
    // not a row at all. Terminated here for the same reason a bullet is: a row is
    // one item, and this is the last point at which it is recognisable as one.
    text = text.replace(/^\s*\|?[\s:|-]*\|[\s:|-]*$/gm, '');
    text = text.replace(/^\s*\|(.*)\|\s*$/gm, (_m, row) => {
      const cells = row.split('|').map((cell) => cell.trim()).filter(Boolean).join(', ');
      return cells && !/[.!?:;,]$/.test(cells) ? `${cells}.` : cells;
    });

    text = text.replace(/(\*\*|__|~~)/g, '');
    text = text.replace(/(^|[\s(])[*_]([^\s*_][^*_]*)[*_]($|[\s.,;:!?)])/g, '$1$2$3');

    /*
     * A path is a word, and the word is its last segment.
     *
     * Reading "slash workspace slash projects slash claude dash web slash chat
     * dash service slash auth dot js" is how a spoken summary becomes unusable,
     * and the file name is the part that identifies it anyway. Guarded so that
     * ordinary prose keeps its slashes: it takes either a second slash or a file
     * extension on the end to count as a path, which leaves "and/or", "24/7" and
     * "km/h" alone.
     */
    text = text.replace(
      /(^|[\s("'])(\.{0,2}\/?[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)+)/g,
      (match, pre, candidate) => {
        const looksLikePath =
          (candidate.match(/\//g) || []).length >= 2 || /\.[A-Za-z]{1,5}$/.test(candidate);
        if (!looksLikePath) return match;
        const segments = candidate.split('/').filter((part) => part && part !== '.' && part !== '..');
        return pre + (segments[segments.length - 1] || candidate);
      },
    );
    // `auth.js:42` and `auth.js:42-51` are line references, and they are read as
    // ones. Left as a colon they run the number into the next sentence.
    text = text.replace(
      /([A-Za-z0-9._-]+\.[A-Za-z]{1,5}):(\d+)(?:-(\d+))?/g,
      (_m, file, from, to) => `${file}, line ${from}${to ? ` to ${to}` : ''}`,
    );

    // Arrows, box drawing, dingbats, check marks and emoji — written as escapes
    // because this file is injected raw into a page whose charset we do not set.
    // Deliberately NOT the General Punctuation block (U+2000–U+206F): the dashes
    // and curly quotes in it are how a sentence is paced, and a synthesiser reads
    // them as the pauses they are.
    // U+2300–U+27BF already contains the box-drawing block, hence no range for it.
    text = text.replace(/[\u2190-\u21FF\u2300-\u27BF\u2B00-\u2BFF\uFE0F]/g, ' ');
    text = text.replace(/[\u{1F000}-\u{1FAFF}]/gu, ' ');

    /*
     * A blank line ends a sentence; a single newline does not.
     *
     * Which is exactly what those two mean in markdown, and it is also how they
     * sound. A synthesiser reads a bare newline as nothing at all, so something has
     * to supply the pauses — but supplying one at every newline breaks prose that
     * happens to be hard-wrapped, and a full stop in the middle of a sentence is
     * heard as a real one ("it now reads the mic button's. class instead of"). That
     * is worse than a missing pause, because it changes what the sentence says.
     *
     * The short lines this used to be for — headings, bullets, table rows — are
     * already terminated above, at the point where their marker was still there to
     * prove they were one. So they keep their pacing and nothing has to guess.
     */
    const paragraphs = [];
    let broken = false;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) {
        broken = true;
        continue;
      }
      const previous = paragraphs.length - 1;
      if (broken && previous >= 0 && !/[.!?:;,]$/.test(paragraphs[previous])) {
        paragraphs[previous] += '.';
      }
      paragraphs.push(line);
      broken = false;
    }
    // The last sentence too, or the voice ends on the rising note of an
    // unterminated line and sounds like it was cut off.
    const last = paragraphs.length - 1;
    if (last >= 0 && !/[.!?]$/.test(paragraphs[last])) {
      paragraphs[last] = paragraphs[last].replace(/[:;,]$/, '') + '.';
    }
    text = paragraphs.join(' ');

    text = text.replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
    // Collapse what the two passes above can leave behind: "word.." from a line
    // that ended in an abbreviation, and " . " from a line that was only markup.
    text = text.replace(/\.{2,}/g, '.').replace(/(?:\s\.)+/g, '.').trim();

    /*
     * The whole message, however long it is.
     *
     * This used to stop at 2400 characters and say "that is as far as I will
     * read; the rest is on screen", on the theory that a long read is usually the
     * wrong message and a minute is enough to find out. In practice the person
     * listening is listening *because* they are not looking at the screen — often
     * with the phone in a pocket — so "the rest is on screen" is an instruction to
     * go and do the thing they asked the voice to do for them, and it arrived
     * exactly on the messages worth hearing in full. Stop is one tap away on the
     * bar and it stops immediately, which is the answer to the wrong message.
     *
     * Nothing else needs a limit for this to be safe: the server refuses text past
     * `SPEAK_MAX_CHARS` (see chat-service/speak.js) with a sentence, the overlay's
     * answer to a refusal is to read the whole thing with the browser's own voice,
     * and that voice is free and unmetered. Long is slow, never silent.
     */
    return text;
  }

  /**
   * Sentences, by scanning rather than by regex.
   *
   * A lookbehind (`/(?<=[.!?])\s+/`) is the obvious way to write this and the
   * wrong one here: it is a *parse* error on a browser that does not support it,
   * so the whole file fails to load and every button on this bar disappears —
   * the exact silent failure `overlay-test.js` exists for, except that the test
   * runs on node, where the syntax is fine, and would never see it.
   */
  function splitSentences(text) {
    const out = [];
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
      if ('.!?'.indexOf(text[i]) === -1) continue;
      // Take a run of terminators together ("Really?!"), and only break if
      // whitespace follows — "3.5" and "auth.js" are not sentence ends.
      let end = i;
      while (end + 1 < text.length && '.!?'.indexOf(text[end + 1]) !== -1) end += 1;
      if (end + 1 < text.length && !/\s/.test(text[end + 1])) {
        i = end;
        continue;
      }
      out.push(text.slice(start, end + 1));
      start = end + 1;
      i = end;
    }
    if (start < text.length) out.push(text.slice(start));
    return out;
  }

  /**
   * Split into utterance-sized pieces at sentence boundaries.
   *
   * Sentences first, and only then a hard split of any single sentence longer
   * than the limit — a code-heavy line can be one 900-character "sentence", and
   * it still has to be said.
   */
  function speechPieces(text) {
    const pieces = [];
    let current = '';

    const flush = () => {
      const trimmed = current.trim();
      if (trimmed) pieces.push(trimmed);
      current = '';
    };

    // Trimmed here, not by the scanner: a split leaves the space that followed the
    // full stop on the front of the next sentence, and joining those with another
    // space is a double space inside an utterance.
    for (const piece of splitSentences(text).map((s) => s.trim())) {
      if (!piece) continue;
      if (piece.length > SPEECH_CHUNK) {
        flush();
        for (const word of piece.split(' ')) {
          if (current.length + word.length + 1 > SPEECH_CHUNK) flush();
          current += (current ? ' ' : '') + word;
        }
        flush();
        continue;
      }
      if (current.length + piece.length + 1 > SPEECH_CHUNK) flush();
      current += (current ? ' ' : '') + piece;
    }
    flush();
    return pieces;
  }

  /** Reflect speech on the bar and in the sheet, wherever either happens to be. */
  function paintSpeech() {
    statusBtn.classList.toggle('cmo-speaking', speaking);
    // The glyph changes as well as the colour: on the bar this is the only Stop
    // once the sheet has been dismissed, and a pulse alone does not say so.
    statusBtn.innerHTML = speaking ? '&#9632;' : '&#9673;';
    statusBtn.setAttribute(
      'aria-label',
      speaking ? 'Stop reading aloud' : 'Is Claude working?',
    );
    const sheetBtn = panel.querySelector('#cmo-speak');
    if (sheetBtn) sheetBtn.textContent = speaking ? 'Stop' : 'Read aloud';
    /*
     * The block buttons say Stop too, and only the one that is reading.
     *
     * Its own label is kept on the element rather than rebuilt here: it names a
     * language that came out of the message, and re-deriving it in two places is
     * how the two of them drift apart.
     */
    for (const btn of panel.querySelectorAll('[data-cmo-block]')) {
      const mine = speaking && String(readingBlock) === btn.dataset.cmoBlock;
      btn.textContent = mine ? 'Stop' : btn.dataset.cmoLabel || 'Read';
      btn.classList.toggle('cmo-alt', !mine);
    }
  }

  function stopSpeech() {
    speechChunks = [];
    readingBlock = -1;
    if (speaking) speaking = false;
    if (speechAvailable()) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* a synthesiser that refuses to be cancelled is still one we forget */
      }
    }
    stopServerRead();
    paintSpeech();
  }

  /*
   * Reading with the server voice.
   *
   * The shape is forced by what the audio is: a message is several complete mp3s,
   * fetched one at a time and played in a chain, and none of them exist until they
   * are asked for. Which gives three things to be careful about.
   *
   *   **The chain has to survive Stop.** Every fetch and every `ended` handler
   *   outlives the read that started it, and a piece that arrives after Stop must
   *   not begin playing — so each read gets a generation, and everything checks it
   *   before doing anything. Same reason `sayNext` checks `speaking`.
   *
   *   **The next piece is fetched while this one plays.** Synthesis takes about a
   *   fifth of the time the audio takes to play (measured; see speak.js), so one
   *   piece ahead is enough to make a message continuous, and fetching further
   *   ahead than that would pay for audio that Stop is about to discard.
   *
   *   **The first failure is recoverable and the rest are not.** If nothing has
   *   been heard yet, the browser's own voice can still read the whole message and
   *   the listener hears one voice reading one message. Once a piece has played,
   *   falling back would start the message again in a different voice, which is
   *   worse than stopping and saying why.
   */
  let read = null;
  let readGeneration = 0;

  function stopServerRead() {
    readGeneration += 1;
    read = null;
    if (!audioEl) return;
    audioEl.onended = null;
    audioEl.onerror = null;
    try {
      audioEl.pause();
      // Detached rather than set to '': an empty src is a request for the page's
      // own URL, which some browsers will actually go and fetch.
      audioEl.removeAttribute('src');
      if (typeof audioEl.load === 'function') audioEl.load();
    } catch {
      /* the element keeps its unlock either way, which is the part that matters */
    }
  }

  /** Say why, on the sheet, if the sheet is open to be told. */
  function sayWhy(text) {
    const detail = panel.querySelector('#cmo-status-detail');
    if (detail) detail.textContent = text;
  }

  /** The sentence the server sent with a refusal, or the status on its own. */
  async function refusalReason(res) {
    try {
      const body = await res.json();
      if (body?.error) return String(body.error);
    } catch {
      /* not JSON: the status is all there is to go on */
    }
    return res.status === 401
      ? 'the chat service is not signed in on this device'
      : `the server answered ${res.status}`;
  }

  /**
   * One piece of audio, as a URL that can be played. Started once and shared, so
   * asking for the piece that is already on its way is free.
   */
  function segmentUrl(index, generation) {
    if (!read || index < 0 || index >= read.total) return null;
    const already = read.fetching.get(index);
    if (already) return already;
    const url = `/api/speak?id=${encodeURIComponent(read.id)}&segment=${index}`;
    /*
     * Fetched here and then played from the same URL, rather than handed to the
     * element unseen.
     *
     * The element cannot report *why* a source failed — it fires `error` and says
     * nothing — and the server's refusals are sentences worth repeating: a lapsed
     * session, the day's budget, a voice Polly would not speak. This fetch is where
     * those are read. It is not a wasted round trip: the response is
     * `Cache-Control: private, max-age=600`, so the element's own request for the
     * same URL is served from the browser cache, and a miss costs a re-read of
     * audio the server already has rather than another synthesis.
     *
     * It is also what makes the piece *ahead* worth asking for: that request is what
     * makes Polly build it while this one plays.
     */
    const pending = fetch(url).then(async (res) => {
      if (!res.ok) throw new Error(await refusalReason(res));
      // Drain it, so it lands in the cache the element is about to read from.
      await res.blob();
      if (generation !== readGeneration || !read) return null;
      return url;
    });
    read.fetching.set(index, pending);
    return pending;
  }

  /** Play piece `index`, then the one after it, until Stop or the end. */
  async function playSegment(index, generation) {
    let url = null;
    try {
      url = await segmentUrl(index, generation);
    } catch (err) {
      readTrouble(index, generation, err.message);
      return;
    }
    if (generation !== readGeneration || !read || !url) return;

    // One ahead, while this one plays. Failures here are not reported: this piece
    // is about to be asked for properly, and that is where it will be handled.
    if (index + 1 < read.total) {
      const ahead = segmentUrl(index + 1, generation);
      if (ahead) ahead.catch(() => {});
    }

    audioEl.onended = () => {
      if (generation !== readGeneration) return;
      if (read && index + 1 < read.total) {
        playSegment(index + 1, generation);
        return;
      }
      // The end of the message: keep the element and its unlock, drop everything
      // else, and put the bar back to being a status button.
      stopServerRead();
      speaking = false;
      paintSpeech();
    };
    audioEl.onerror = () => {
      if (generation === readGeneration) readTrouble(index, generation, 'the audio would not play');
    };

    try {
      audioEl.src = url;
      const played = audioEl.play();
      if (played && typeof played.catch === 'function') {
        played.catch((err) => {
          if (generation === readGeneration) {
            readTrouble(index, generation, err?.message || 'the browser refused to play it');
          }
        });
      }
    } catch (err) {
      readTrouble(index, generation, err?.message || 'the browser refused to play it');
    }
  }

  /**
   * Something went wrong. Fall back to the browser's voice if nothing has been
   * heard yet, and otherwise stop and say so.
   */
  function readTrouble(index, generation, why) {
    if (generation !== readGeneration) return;
    const text = read?.text || '';
    // Never for a code read: the browser's voice would read the block character by
    // character, because turning code into words happens on the server and nowhere
    // else. Silence with a reason beats two minutes of punctuation names.
    if (index === 0 && text && read?.kind !== 'code') {
      fallBackToBrowser(text, why);
      return;
    }
    stopSpeech();
    sayWhy(`Stopped reading: ${why}. The rest of the message is above.`);
  }

  /**
   * Read the whole message with the browser's own voice instead.
   *
   * Best-effort by nature: on iOS this is past the gesture, so it may itself be
   * refused — which is exactly the state the sheet then reports rather than
   * leaving a phone that was told to read and then said nothing.
   */
  function fallBackToBrowser(text, why) {
    stopServerRead();
    speaking = false;
    if (speechAvailable() && speakInBrowser(text)) {
      sayWhy(`Reading with this browser's own voice: ${why}.`);
      return;
    }
    paintSpeech();
    sayWhy(`Nothing was read aloud: ${why}.`);
  }

  /**
   * Start a server read. Synchronous up to the point where it cannot be — the
   * element is unlocked inside the tap, and everything that has to wait for the
   * network happens after this has already returned.
   */
  function speakOnServer(text, { kind = 'prose', lang = '' } = {}) {
    if (!unlockAudio()) return false;
    readGeneration += 1;
    const generation = readGeneration;
    speaking = true;
    paintSpeech();

    fetch('/api/speak/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `kind: 'code'` hands over one fenced block verbatim and asks the server to
      // turn it into words. What a listener hears is decided there rather than here
      // so that both surfaces hear the same thing, and so the reduction can change
      // without shipping a new overlay to a phone that has cached this file.
      body: JSON.stringify({ text, voice: chosenVoice(), kind, lang }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(await refusalReason(res));
        return res.json();
      })
      .then((prepared) => {
        if (generation !== readGeneration) return;
        if (!prepared?.id || !prepared.segments) throw new Error('the server prepared nothing to play');
        read = {
          id: prepared.id,
          total: prepared.segments,
          voice: prepared.voice,
          text,
          kind,
          fetching: new Map(),
        };
        playSegment(0, generation);
      })
      .catch((err) => {
        if (generation !== readGeneration) return;
        const why = err?.message || 'the server voice is unavailable';
        // Same reason as in `readTrouble`: there is no local way to read code, so a
        // refused code read is a refusal, not a handover to a voice that would
        // spell it out.
        if (kind === 'code') {
          stopSpeech();
          sayWhy(`That block was not read: ${why}. It is on screen above.`);
          return;
        }
        fallBackToBrowser(text, why);
      });
    return true;
  }

  /** Say the next piece, and the one after it, until Stop or the end. */
  function sayNext() {
    if (!speechChunks.length) {
      speaking = false;
      paintSpeech();
      return;
    }
    const piece = speechChunks.shift();
    const utterance = new window.SpeechSynthesisUtterance(piece);
    // The same language the recognizer dictates in, so one setting governs both
    // directions of the conversation.
    utterance.lang = navigator.language || 'en-US';
    // Chaining on `end` is what keeps iOS speaking past the first piece. `error`
    // is chained too rather than aborting: one refused piece (a stray character,
    // an interrupted voice) must not silence the rest of the message.
    utterance.onend = () => {
      if (speaking) sayNext();
    };
    utterance.onerror = () => {
      if (speaking) sayNext();
    };
    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      // Nothing will be spoken, so do not leave a Stop button on the bar.
      stopSpeech();
    }
  }

  /** Read with the browser's own voice. Returns whether anything will be said. */
  function speakInBrowser(text) {
    if (!speechAvailable()) return false;
    speechChunks = speechPieces(text);
    if (!speechChunks.length) return false;
    speaking = true;
    paintSpeech();
    sayNext();
    return true;
  }

  /**
   * Start reading, in whichever voice this device is set to. Returns whether
   * anything will actually be said, so the caller can label its own button
   * honestly.
   *
   * `lead` is spoken first and is plain speech, not markdown — it goes on *after*
   * the reduction rather than in front of the message, because the strips that
   * remove headings and bullets are anchored to the start of a line, and anything
   * put in front of the first line hides the marker on it.
   *
   * Must be called inside the tap: see the note at the top of this section. That
   * is true of both voices, for different reasons — `speechSynthesis.speak` is
   * refused outside a gesture, and the audio element has to be unlocked by one.
   */
  function speak(markdown, lead = '') {
    stopSpeech();
    const canRead = speechAvailable() || serverVoiceReady();
    if (!canRead) return false;
    /*
     * Never over a live microphone. The recognizer would hear this and dictate
     * Claude's own words back into the composer, and the whisper path would
     * record them and send them to be transcribed.
     *
     * Asked of the mic button rather than of `recognition`, because that class is
     * the one thing both dictation paths maintain — the recognizer sets it, and so
     * does the recorder, which holds its state in a local nothing else can see.
     */
    if (document.getElementById('cmo-mic')?.classList.contains('cmo-rec')) return false;
    const body = speakable(markdown);
    // Asked of the message, not of the lead: a lead alone is this feature
    // announcing itself and saying nothing, which is worse than the button
    // reporting that there was nothing to read.
    if (!body) return false;
    const text = lead ? `${lead} ${body}` : body;
    // The server voice unless this device asked for the local one — and the local
    // one whenever the server has nothing to offer, which is what makes this work
    // on a deployment with no Polly permission at all.
    if (!wantsBrowserVoice() && serverVoiceReady()) return speakOnServer(text);
    return speakInBrowser(text);
  }

  /**
   * Read one fenced block as code, rather than as the words "Code block".
   *
   * Server-only, and not as a shortcut: a block becomes listenable by being turned
   * into spoken words — indentation as "indent two", `=>` as "arrow", a line number
   * every few lines — and that happens in `chat-service/speak.js`. The browser's
   * own voice would read the punctuation out one character at a time, which is the
   * thing this feature exists to avoid, so when there is no server voice the answer
   * is a reason and not a worse read.
   *
   * Returns '' when something will be read, and otherwise the sentence to show.
   * Must be called inside the tap, like everything else in this section.
   */
  function speakCode(block) {
    stopSpeech();
    if (!block?.code?.trim()) return 'That block is empty — there is nothing in it to read.';
    if (document.getElementById('cmo-mic')?.classList.contains('cmo-rec')) {
      return 'Not while the microphone is live — it would hear the code being read and dictate it back.';
    }
    if (!serverVoiceReady()) {
      return 'Code is read by the server voice, and this device has none: it is not signed in to the chat service, or this deployment cannot synthesise.';
    }
    // A device set to its own voice is told, rather than quietly overridden. The
    // choice was made for the message; this is the one read it cannot serve.
    if (wantsBrowserVoice()) {
      return 'Code is read on the server, and this device is set to its own voice. Pick a server voice above to hear a block.';
    }
    if (!speakOnServer(block.code, { kind: 'code', lang: block.lang })) {
      return 'This browser would not let the audio start. Tap Read aloud once, then try the block again.';
    }
    readingBlock = block.index;
    paintSpeech();
    return '';
  }

  // ------------------------------------------ talking a message over out loud
  /*
   * A spoken conversation about the message on the sheet, with something that cannot
   * act on it.
   *
   * Read aloud answers "say this to me". This answers the thing you want a second
   * later — wait, go back to the part about the timeout — out loud, on a phone,
   * without typing and without waiting for a turn. Three properties, all deliberate:
   *
   *   **It cannot reach Claude.** The session is minted with no tools and an
   *   instruction saying as much (chat-service/realtime.js), and there is nothing on
   *   this side that could carry what was said into the panel: no chord is pressed, no
   *   text is written, nothing is sent to this box at all once the line is up. That is
   *   the point rather than a limitation — a voice channel is the last place a command
   *   should be issued from, because a misheard sentence there is a force-push nobody
   *   typed and nobody saw. The sheet says so above the transcript, where it cannot be
   *   missed.
   *
   *   **The audio does not pass through this box.** The browser holds a two-minute
   *   credential and opens WebRTC straight to OpenAI. Latency is the whole feature, and
   *   a relay on an instance that is also running a compiler is latency.
   *
   *   **It ends by itself.** It is metered by the minute, so the server counts sessions
   *   against the day and this end hangs up on its own timer — and every way out of it
   *   stops the microphone, because the failure mode of a voice call is a pocket that
   *   is still connected.
   */
  const talk = {
    pc: null,           // RTCPeerConnection, and the answer to "is one up?"
    channel: null,      // the `oai-events` channel, which carries both transcripts
    mic: null,          // the MediaStream, kept so its tracks can actually be stopped
    audio: null,        // the element playing the far end, made once and reused
    /*
     * Muted, which is not one of the ways out: the microphone is still open and the
     * minute is still being billed, the far end is simply being sent silence. See
     * `setTalkMute` for why that is the useful thing rather than stopping the track.
     */
    muted: false,
    started: 0,
    timer: null,
    /*
     * Which conversation is the current one. Every handler and everything after an
     * await checks it, for the same reason the read does: a credential minted or an
     * answer arriving after Hang up must not open a line nobody asked for.
     */
    generation: 0,
    lines: [],          // { who: 'you' | 'voice', text, partial }
  };

  /*
   * Everything this needs, asked of the box and of the browser separately.
   *
   * The key is the box's answer and WebRTC is the browser's, and they fail differently:
   * a deployment with no OpenAI key cannot offer this at all, while a webview without
   * RTCPeerConnection or getUserMedia would take the tap and then do nothing. Either
   * way there is no button, because an inert control on this sheet reads as something
   * being broken.
   */
  const talkReady = () =>
    Boolean(serverTalk?.configured) &&
    typeof window.RTCPeerConnection === 'function' &&
    typeof window.Audio === 'function' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function';

  /** Is a conversation up, or on its way up? */
  const talking = () => Boolean(talk.pc);

  /** Stop a stream. The stream is not the microphone; its tracks are. */
  function stopTracks(stream) {
    for (const track of stream?.getTracks?.() || []) {
      try {
        track.stop();
      } catch {
        /* already stopped, which is the state being asked for */
      }
    }
  }

  /**
   * Mute, which is not the same thing as stopping the microphone.
   *
   * `enabled = false` keeps the track and the session and sends silence in place of the
   * room; stopping it would close the microphone and there would be no way back into
   * this conversation — a second one costs another session against the day's count. So
   * while muted the recording indicator stays lit, correctly, and the minute is still
   * being billed. Hanging up is still the only thing that closes the line, which is why
   * nothing here reports otherwise.
   *
   * It is worth a button because of how the session is minted: turn detection is
   * semantic with `interrupt_response` on (chat-service/realtime.js), so anything the
   * phone hears — a cough, someone else's sentence, a podcast in the room — cuts off the
   * explanation mid-word. Mute is how a long answer gets listened to in a noisy place.
   */
  function setTalkMute(muted) {
    talk.muted = Boolean(muted);
    for (const track of talk.mic?.getTracks?.() || []) track.enabled = !talk.muted;
    paintTalkMute();
    // Only once there is a line: before that the state line is saying how the
    // connection is going, which is the more useful of the two.
    if (talking()) paintTalkState(talkStateText());
  }

  /**
   * What the state line says while a line is up — "Listening" is a lie when muted.
   *
   * It says the line is still open as well, in the same breath, because the mistake this
   * button makes possible is muting instead of hanging up and putting the phone in a
   * pocket. What actually closes it then is the ten-minute timer.
   */
  const talkStateText = () =>
    talk.muted ? 'Muted — it cannot hear you, and the line is still open' : 'Listening';

  /**
   * Start one, from inside the tap.
   *
   * `text` is the message as it was written, fences and all. `prompt` is what was asked
   * to produce it, or '' when this page has no answer to that — the server treats an
   * empty one as not provided rather than inventing context for it.
   */
  async function startTalk(text, prompt = '') {
    if (talking()) {
      endTalk();
      return;
    }
    if (!talkReady() || !String(text || '').trim()) return;
    /*
     * Never over a live microphone, and for a harder reason than the read has: there is
     * one microphone on this phone, and the recognizer would dictate this conversation
     * into Claude's composer — which is the one thing this feature promises cannot
     * happen.
     */
    if (document.getElementById('cmo-mic')?.classList.contains('cmo-rec')) {
      sayWhy('Not while the microphone is live — dictation and a spoken conversation cannot share it.');
      return;
    }
    stopSpeech();   // one voice at a time, and this one answers back

    const generation = ++talk.generation;
    talk.lines = [];
    /*
     * Unmuted, always: a conversation that opened muted because the last one ended that
     * way is one you talk into for ten seconds before finding out. `endTalk` clears it
     * first — this is the second line of defence, and the one that matters, because the
     * mute is applied to a stream that no longer exists by then: a stale `true` here
     * would draw "Unmute" over a microphone that is in fact live.
     */
    talk.muted = false;
    openTalkSheet();
    paintTalkState('Asking for a line…');
    paintTalkTranscript();
    paintTalkBar();

    try {
      /*
       * The microphone first, before the credential.
       *
       * It is the one step a person rather than a server can refuse, and asking for it
       * first is what makes a refusal free: the server reserves a session against the
       * day's count before it calls OpenAI, deliberately, so one minted and then
       * abandoned has been spent.
       */
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (generation !== talk.generation) {
        stopTracks(mic);
        return;
      }
      talk.mic = mic;
      // There is something to mute from here, which is before the line is up: the room
      // is already being heard while the credential is still being minted.
      paintTalkMute();

      const res = await fetch('/api/realtime/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, prompt }),
      });
      if (!res.ok) throw new Error(await refusalReason(res));
      const minted = await res.json();
      if (generation !== talk.generation) return;
      if (!minted?.value) throw new Error('the server minted nothing to connect with');

      await connectTalk(minted, generation);
    } catch (err) {
      if (generation !== talk.generation) return;
      // Hang up first: whatever failed, the microphone may already be live, and the
      // sentence below is the only thing that will be on screen afterwards.
      endTalk();
      paintTalkState(
        `Not connected: ${
          err?.name === 'NotAllowedError'
            ? 'the microphone was not allowed'
            : err?.message || 'the connection failed'
        }`,
      );
    }
  }

  /**
   * Open the session with the minted credential.
   *
   * Nothing about it is configured from here — the model, the voice, the turn
   * detection, the instructions and the absence of tools are all baked into the
   * credential on the server, so a tampered overlay gets a session shaped exactly the
   * same way. This end sends an offer and plays what comes back.
   */
  async function connectTalk(minted, generation) {
    const pc = new window.RTCPeerConnection();
    talk.pc = pc;
    // From here on there is something to hang up, so the bar says so — before the SDP
    // round trip rather than after it, because that is where a connection stalls.
    paintTalkBar();

    /*
     * One element for the life of the page, like the read's, and for the same reason:
     * on iOS the permission to make a sound belongs to an element.
     *
     * A stream rather than a file, so it is never given a `src` and code-server's
     * `media-src 'self'` has nothing to refuse — `srcObject` is not a URL. `playsInline`
     * on the property and the attribute both: the attribute is what older WebKit reads,
     * and without it iOS takes over the whole screen with an audio call.
     */
    if (!talk.audio) {
      talk.audio = new window.Audio();
      talk.audio.autoplay = true;
      talk.audio.playsInline = true;
      talk.audio.setAttribute?.('playsinline', '');
    }
    pc.ontrack = (event) => {
      if (generation !== talk.generation) return;
      talk.audio.srcObject = event.streams?.[0] || null;
      talk.audio.play?.()?.catch?.(() => {
        // The tap that started this is the gesture, so this is nearly impossible — and
        // a connected session in silence is worth a sentence either way.
        paintTalkState('Connected, but this browser will not play the audio');
      });
    };
    pc.onconnectionstatechange = () => {
      if (generation !== talk.generation) return;
      if (pc.connectionState === 'connected') paintTalkState(talkStateText());
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        endTalk();
        paintTalkState('The line dropped');
      }
    };

    for (const track of talk.mic.getTracks()) pc.addTrack(track, talk.mic);

    // The event channel carries both halves of the transcript, which is what makes this
    // auditable at all: you can read what it heard you say.
    const channel = pc.createDataChannel('oai-events');
    talk.channel = channel;
    channel.onmessage = (event) => onTalkEvent(event, generation);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // Where to send it is the server's decision, not this file's: the box may be
    // holding an Azure deployment or an OpenAI key, and only it knows which. The
    // fallback is the OpenAI URL so that a client running against an older build of
    // the service still works rather than posting an offer to `undefined`.
    const callUrl =
      minted.callUrl ||
      `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(minted.model || '')}`;
    const answer = await fetch(callUrl, {
      method: 'POST',
      body: offer.sdp,
      headers: { Authorization: `Bearer ${minted.value}`, 'Content-Type': 'application/sdp' },
    });
    if (!answer.ok) throw new Error(`the voice service refused the connection (${answer.status})`);
    const sdp = await answer.text();
    // Hung up while that was in flight: the credential has minutes left on it and
    // applying this would open the line anyway, seconds after it was ended.
    if (generation !== talk.generation) return;
    await pc.setRemoteDescription({ type: 'answer', sdp });

    talk.started = Date.now();
    const minutes = Number(minted.maxMinutes) || 10;
    talk.timer = setInterval(() => {
      paintTalkClock();
      if (Date.now() - talk.started >= minutes * 60000) {
        endTalk();
        paintTalkState(`The line closed after ${minutes} minutes`);
      }
    }, 1000);

    paintTalkState(talkStateText());
    paintTalkClock();
    /*
     * What it costs and when it stops, on the sheet while it runs. This is the one
     * thing on this surface that spends money by the minute, and the day's count is
     * kept by the server rather than here — so it is reported rather than assumed.
     */
    const spent = minted.budget;
    const note = panel.querySelector('#cmo-talk-note');
    if (note) {
      note.textContent = [
        `${minted.voice || 'a voice'} on ${minted.model || 'OpenAI'}, billed by the minute.`,
        spent ? `${spent.sessions} of ${spent.limit} conversations today.` : '',
        `The line closes by itself after ${minutes} minutes.`,
      ]
        .filter(Boolean)
        .join(' ');
    }
  }

  /**
   * What the far end says about itself: the transcripts, and the errors.
   *
   * The deltas as well as the completed events, so a sentence appears while it is being
   * said — dimmed until it is final, because a half-heard line shown as finished is how
   * you end up certain it said something it did not.
   */
  function onTalkEvent(event, generation) {
    if (generation !== talk.generation) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;   // not ours to understand
    }
    const type = String(msg?.type || '');

    // What it is saying. The event was renamed between API versions and both spellings
    // are still in the wild, so this matches the shape rather than one name.
    if (/^response\.(output_)?audio_transcript\.delta$/.test(type)) {
      addTalkText('voice', msg.delta || '', true);
      return;
    }
    if (/^response\.(output_)?audio_transcript\.done$/.test(type)) {
      finishTalkLine('voice', msg.transcript);
      return;
    }
    // And what it heard you say, which is the half worth having on screen.
    if (type === 'conversation.item.input_audio_transcription.delta') {
      addTalkText('you', msg.delta || '', true);
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      finishTalkLine('you', msg.transcript);
      return;
    }
    if (type === 'error') {
      paintTalkState(`Trouble: ${msg.error?.message || 'the far end reported an error'}`);
    }
  }

  /** Add to the open line for `who`, starting one if the last line was the other's. */
  function addTalkText(who, text, partial) {
    if (!text) return;
    const last = talk.lines[talk.lines.length - 1];
    if (last && last.who === who && last.partial) last.text += text;
    else talk.lines.push({ who, text, partial });
    paintTalkTranscript();
  }

  /** Close the open line, preferring the final transcript over the deltas. */
  function finishTalkLine(who, transcript) {
    const last = talk.lines[talk.lines.length - 1];
    const final = String(transcript || '').trim();
    if (last && last.who === who && last.partial) {
      if (final) last.text = final;
      last.partial = false;
    } else if (final) {
      talk.lines.push({ who, text: final, partial: false });
    }
    paintTalkTranscript();
  }

  /**
   * Hang up.
   *
   * Called by the button, by the bar, by Close, by a tap beside the sheet, by any sheet
   * drawn over this one, by a dropped line, by the timer, by every refusal and by the
   * page going away — which is the whole point: there is no path out of a conversation
   * that leaves the microphone open. Safe to call when there is nothing to end, because
   * most of those callers cannot know whether there is.
   */
  function endTalk() {
    talk.generation += 1;
    if (talk.timer) clearInterval(talk.timer);
    talk.timer = null;
    try {
      talk.channel?.close?.();
    } catch {
      /* already gone */
    }
    try {
      talk.pc?.close?.();
    } catch {
      /* already gone */
    }
    // The tracks, not the stream: a MediaStream dropped without stopping its tracks
    // leaves the recording indicator lit and the microphone live.
    stopTracks(talk.mic);
    // Kept, not replaced — the element holds this page's permission to make a sound.
    if (talk.audio) talk.audio.srcObject = null;
    talk.pc = null;
    talk.channel = null;
    talk.mic = null;
    talk.muted = false;
    talk.started = 0;
    paintTalkState('Hung up');
    paintTalkClock();
    paintTalkMute();
    paintTalkBar();
  }

  /*
   * The sheet, which is the whole of this feature's screen: what it is not, what it is
   * doing, how long it has been doing it, what was said, a way to stop talking without
   * stopping the line, and two ways to end it.
   *
   * One string of static HTML with nothing from outside this file in it — the rule on
   * this surface — and everything else written through textContent afterwards. A
   * transcript is the furthest thing from trusted text there is: it is what a voice
   * model heard somebody say, on the other side of a network.
   */
  function openTalkSheet() {
    openSheet(
      `<p class="cmo-title">Talking it over</p>
      <p class="cmo-warn">A side channel, and not Claude. It can hear you and talk about
      this message — explain it, read the code out loud, translate it — and that is all
      it can do: it cannot run anything, change a file, or tell Claude what you said.
      Nothing said here reaches the conversation.</p>
      <p class="cmo-status" id="cmo-talk-state"></p>
      <p class="cmo-hint" id="cmo-talk-clock"></p>
      <div class="cmo-talk-log" id="cmo-talk-log"></div>
      <div class="cmo-row">
        <button class="cmo-action cmo-alt" id="cmo-talk-mute" aria-pressed="false" disabled>Mute</button>
        <button class="cmo-action" id="cmo-talk-end">Hang up</button>
        <button class="cmo-action cmo-alt" id="cmo-talk-close">Close</button>
      </div>
      <p class="cmo-hint" id="cmo-talk-note"></p>`,
      { keepTalking: true },
    );
    /*
     * Mute first in the row, and never styled like Hang up.
     *
     * It is the control reached for in a hurry, mid-sentence, while something is being
     * said out loud that the room should not answer — and the button beside it ends a
     * session that counts against the day. Two taps that mean different things must not
     * look like each other.
     */
    panel
      .querySelector('#cmo-talk-mute')
      .addEventListener('click', () => setTalkMute(!talk.muted));
    // Hang up and stay: the transcript is worth reading after the line has gone.
    panel.querySelector('#cmo-talk-end').addEventListener('click', () => endTalk());
    panel.querySelector('#cmo-talk-close').addEventListener('click', closeSheet);
    paintTalkMute();
  }

  /**
   * The mute control, which is enabled exactly while there is a microphone to mute.
   *
   * `aria-pressed` rather than a changed colour alone: this is a toggle, and a screen
   * reader on a phone is the case where "did that do anything" is hardest to answer.
   */
  function paintTalkMute() {
    const btn = panel.querySelector('#cmo-talk-mute');
    if (!btn) return;
    btn.disabled = !talk.mic;
    btn.textContent = talk.muted ? 'Unmute' : 'Mute';
    btn.setAttribute('aria-pressed', talk.muted ? 'true' : 'false');
    btn.setAttribute(
      'aria-label',
      talk.muted
        ? 'Unmute the microphone — the line is still open'
        : 'Mute the microphone, without ending the conversation',
    );
  }

  function paintTalkState(text) {
    const el = panel.querySelector('#cmo-talk-state');
    if (el) el.textContent = text;
  }

  function paintTalkClock() {
    const el = panel.querySelector('#cmo-talk-clock');
    if (!el) return;
    if (!talk.started) {
      el.textContent = '';
      return;
    }
    const secs = Math.floor((Date.now() - talk.started) / 1000);
    el.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} on this line`;
  }

  function paintTalkTranscript() {
    const box = panel.querySelector('#cmo-talk-log');
    if (!box) return;
    box.textContent = '';
    for (const line of talk.lines) {
      const el = document.createElement('p');
      el.className = `cmo-talk-line${line.partial ? ' cmo-partial' : ''}`;
      const who = document.createElement('span');
      who.className = 'cmo-who';
      who.textContent = line.who === 'you' ? 'you' : 'the voice';
      el.append(who, document.createTextNode(line.text));
      box.appendChild(el);
    }
    box.scrollTop = box.scrollHeight;
  }

  /**
   * Reflect a live line on the bar, which is the one control that outlives the sheet.
   *
   * Deliberately the same look as reading aloud — a filled square where the status dot
   * usually is — because it means the same thing to a thumb: this is how you make it
   * stop. The two cannot both be true; `startTalk` stops the read before it begins.
   */
  function paintTalkBar() {
    const live = talking();
    statusBtn.classList.toggle('cmo-speaking', live || speaking);
    statusBtn.innerHTML = live || speaking ? '&#9632;' : '&#9673;';
    statusBtn.setAttribute(
      'aria-label',
      live ? 'Hang up the spoken conversation' : speaking ? 'Stop reading aloud' : 'Is Claude working?',
    );
  }

  // -------------------------------------------------------------- wiring
  document.getElementById('cmo-mic').addEventListener('click', () => {
    if (recognition) {
      stopRecognition();
      return;
    }
    if (!sheet.classList.contains('cmo-open')) openDictation();
  });
  document.getElementById('cmo-projects').addEventListener('click', openProjects);
  document.getElementById('cmo-layout').addEventListener('click', openLayout);
  // The chip is the answer; the button is how you get it back after it has gone,
  // and how you ask again without reloading.
  statusBtn.addEventListener('click', async () => {
    /*
     * While it is reading, this button is Stop.
     *
     * The sheet is dismissed by tapping beside it and the voice carries on, so at
     * that point the bar holds the only control there is — and a phone talking
     * with no visible way to stop it is the worst outcome this feature has. It
     * looks like Stop too: see `paintSpeech`.
     */
    if (speaking) {
      stopSpeech();
      return;
    }
    /*
     * And while a spoken conversation is up, it is Hang up.
     *
     * Same reason, one step worse: the sheet can be dismissed with the line still open,
     * and this bar is then the only control on screen that knows about it. A phone with
     * a live microphone and no visible way to end the call is the worst thing this
     * feature could leave behind.
     */
    if (talking()) {
      endTalk();
      return;
    }
    // Before the await, not after it: this is the gesture, and by the time the
    // status has been fetched iOS no longer counts anything as one. See
    // `unlockAudio` — the sheet's own read, and the auto-read, both depend on it.
    if (serverVoiceReady()) unlockAudio();
    // Refreshed before opening, because this button is also "ask again" — and a
    // minutes-old snapshot is exactly the wrong thing to answer that with.
    await checkStatus();
    /*
     * Ask about voices again if the page has never had an answer.
     *
     * A phone that loaded before the chat service was signed in — which is the
     * normal way round, since the editor has its own password — got nothing at
     * startup and would otherwise be stuck with the robotic voice until it was
     * reloaded. The ask is cheap and the server caches its own answer, including
     * the failure.
     */
    if (!voicesAnswered) await loadSpeechVoices();
    openStatus();
  });
  chip.addEventListener('click', () => {
    openStatus();
    hideChip();
  });
  // Straight to the chord, no sheet: a terminal appearing is its own feedback, and
  // pressing it again is what puts Claude back. The extension decides which of
  // those two a press means, since only it can see what is in front.
  document.getElementById('cmo-terminal').addEventListener('click', () => {
    pressChord(KEY_TERMINAL);
  });

  // One line per workbench load, so a phone that reloads itself leaves a trail.
  recordLoad();
  /*
   * A page restored from the back/forward cache is not a load — but the workbench
   * makes it one: its lifecycle service calls location.reload() on
   * `pageshow.persisted`, because the sockets it was holding while suspended are
   * gone. On a phone that is a routine event (switch apps, swipe back, answer a
   * message), and it is invisible from the server, which sees only another dead
   * extension host. So it gets its own line: if this one ever shows up right
   * before a `reload`, the cause is the browser suspending the tab, and no amount
   * of settling the layout on our side will change it.
   */
  // The debounce above must not be what loses the last sentence.
  window.addEventListener('pagehide', writeDictation);
  /*
   * Stop reading when the page goes away, but NOT when it is merely hidden.
   *
   * The workbench reloads itself on this surface, routinely — every bfcache
   * restore — and speech that outlives its own document cannot be stopped by
   * anything, because the button that would stop it has been destroyed. iOS has
   * shipped exactly that bug more than once.
   *
   * Hiding the tab is deliberately not the same thing. Pressing Read aloud and
   * then locking the phone, or switching to something else while it talks, is a
   * reasonable thing to do — it is close to the point of the feature — and
   * cutting it off there would break the one case where hearing it beats reading
   * it. Unlike the recognizer, a synthesiser losing the foreground loses nothing:
   * it either keeps speaking or is resumed by the OS.
   */
  window.addEventListener('pagehide', stopSpeech);
  /*
   * And hang up. Not merely tidiness: the workbench reloads itself on this surface
   * routinely — every bfcache restore — and a WebRTC session whose page has gone has
   * nothing left that could end it, while the microphone stays open and the minutes
   * keep being billed.
   */
  window.addEventListener('pagehide', endTalk);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') writeDictation();
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) recordLoad('bfcache-restore');
  });

  /*
   * Ask on arrival, and ask again whenever this tab comes back.
   *
   * Coming back to the tab is the other half of the same question: you left the
   * phone with Claude working, you return, and what you want to know before
   * anything renders is whether it finished. Polling stops while the tab is
   * hidden — a suspended phone tab must not hold a request open every four
   * seconds — so returning is also when polling has to be picked back up.
   */
  /*
   * Arriving from a tapped notification.
   *
   * The notification was about one conversation, so the window it opens says which —
   * and this is the whole of what the phone can be told, because the panel itself
   * cannot be addressed per conversation (it is a webview with no such URL). Pinning
   * is what turns "the editor for this project" into "the conversation you were
   * buzzed about": the status sheet then shows its last message, its opening prompt
   * and Read aloud, which is what someone woken by a notification wants to see
   * without going hunting through the panel for it.
   *
   * The pin happens *before* the first fetch, below, rather than after it: asking
   * about the guess first would draw a chip for the wrong conversation and replace it
   * a second later.
   */
  const arrivedFor = notifiedSession();
  if (arrivedFor) forgetNotifiedSession();

  /**
   * Pin a conversation and show it, however word of it arrived.
   *
   * Two ways in, one behaviour: `?session=` on a window the worker opened, and a
   * `cw-notification-click` message to a window that was already open — a phone gives
   * an installed app one window, so a second notification lands on the workbench that
   * is already there and there is no navigation to carry the id.
   *
   * `openStatus()` without `auto`, deliberately: this *is* a tap, so the sheet follows
   * the conversation for a while afterwards rather than going still. If the chat
   * service has no answer (its sign-in is separate from the editor's and may have
   * lapsed) the sheet says so, which is better than a tap that appears to do nothing —
   * that was the bug this whole change is about.
   */
  async function showNotified(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') return;
    pinnedSession = sessionId;
    await checkStatus();
    openStatus();
  }

  /*
   * `?.` on both, because this runs on desktop browsers and inside webviews where
   * `navigator.serviceWorker` is absent — an unsupported browser must not throw here
   * and take the rest of the overlay's wiring with it.
   */
  navigator.serviceWorker?.addEventListener?.('message', (event) => {
    const data = event?.data;
    if (!data || data.type !== 'cw-notification-click') return;
    showNotified(data.sessionId);
  });

  if (arrivedFor) showNotified(arrivedFor);
  else checkStatus();
  startStatusHeartbeat();
  /*
   * Which voices this box can read in, asked once and early.
   *
   * Early because the answer has to be in hand before the first tap: iOS refuses
   * audio that a gesture did not start, so a read that had to ask this first would
   * be a read that never happened. It fails silently by design — no server voice
   * means `speechSynthesis`, which needs no answer from anywhere.
   */
  loadSpeechVoices();
  /*
   * Repair a subscription that has gone quiet, silently and without prompting.
   *
   * This is the surface someone who only opens the editor ever loads, so it is the
   * only place their subscription can be re-registered after the server's device
   * list or its keypair changes underneath it. It does nothing at all unless
   * notifications are already on for this device.
   */
  pushRepair();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      stopStatusPoll();
      return;
    }
    statusPollingSince = Date.now();
    checkStatus();
  });
  // Returning to the window is the cheapest signal there is that something may
  // have changed in the panel while attention was elsewhere.
  window.addEventListener('focus', () => {
    if (document.visibilityState === 'visible') refreshStatus({ silent: true });
  });

  /*
   * Long-press either button to flip the bar to the other edge, and remember it.
   * A fixed overlay will eventually sit on top of something that matters, so
   * there has to be a way out without waiting on a redeploy.
   */
  const SIDE_KEY = 'cmo-side';
  function applySide(side) {
    if (side === 'right') {
      fab.style.left = 'auto';
      fab.style.right = 'max(6px, env(safe-area-inset-right))';
    } else {
      fab.style.right = 'auto';
      fab.style.left = 'max(6px, env(safe-area-inset-left))';
    }
  }
  applySide(localStorage.getItem(SIDE_KEY) || 'left');

  fab.querySelectorAll('.cmo-btn').forEach((btn) => {
    let timer = null;
    const begin = () => {
      timer = setTimeout(() => {
        const next = (localStorage.getItem(SIDE_KEY) || 'left') === 'left' ? 'right' : 'left';
        localStorage.setItem(SIDE_KEY, next);
        applySide(next);
        timer = null;
        btn.dataset.moved = '1'; // suppress the click that follows
      }, 550);
    };
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    btn.addEventListener('touchstart', begin, { passive: true });
    btn.addEventListener('touchend', cancel);
    btn.addEventListener('touchmove', cancel, { passive: true });
    btn.addEventListener('mousedown', begin);
    btn.addEventListener('mouseup', cancel);
    btn.addEventListener('mouseleave', cancel);
    btn.addEventListener(
      'click',
      (e) => {
        if (btn.dataset.moved) {
          delete btn.dataset.moved;
          e.stopImmediatePropagation();
          e.preventDefault();
        }
      },
      true,
    );
  });

  // Fade in while interacting so the buttons aren't ghostly when needed.
  fab.addEventListener('touchstart', () => fab.classList.add('cmo-active'), { passive: true });
  document.addEventListener('touchstart', (e) => {
    if (!fab.contains(e.target)) fab.classList.remove('cmo-active');
  }, { passive: true });
})();
