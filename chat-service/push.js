/**
 * Web Push: VAPID, payload encryption, and the list of devices to send to.
 *
 * Why this is hand-rolled rather than a dependency. The encryption is a fixed,
 * fully specified recipe — RFC 8291 for the key agreement, RFC 8188 for the
 * content encoding, RFC 8292 for the signed request — and every primitive it
 * needs is in node's crypto. What a library would add here is not cryptography
 * but a supply chain, on a box whose whole job is running shell commands for
 * whoever is signed in. The published test vector is reproduced exactly in
 * push-test.js, which is a stronger statement about correctness than a version
 * number is.
 *
 * The shape of the thing, in the order a message goes through it:
 *
 *   a device subscribes in the browser, and hands back an endpoint URL and two
 *   keys: `p256dh` (its ECDH public key) and `auth` (a 16-byte secret);
 *
 *   the payload is encrypted *to that device* — the push service in the middle
 *   (Google's, Apple's, Mozilla's) carries it without being able to read it, and
 *   that is the point of the whole ceremony rather than a bonus;
 *
 *   the POST is signed with a keypair that identifies this box, so the push
 *   service can rate-limit and contact the sender. That keypair has to be stable:
 *   a subscription is bound to the public key it was created with, so generating
 *   a new one silently invalidates every device. It is therefore written once,
 *   under CLAUDE_HOME (which lives on the workspace volume and survives a
 *   deploy), and never rewritten.
 *
 * Nothing here knows what a notification is *about*. See turn-watcher.js.
 */
import { createHmac, createHash, createECDH, randomBytes, createCipheriv, generateKeyPairSync, createPrivateKey, sign as signPayload } from 'crypto';
import { readFile, writeFile, mkdir, rename, unlink } from 'fs/promises';
import { join } from 'path';
import { CLAUDE_HOME } from './session-manager.js';

/*
 * Where the keypair and the device list live.
 *
 * Under CLAUDE_HOME rather than beside the code: /opt/claude-web is replaced
 * wholesale on every deploy, and both of these have to outlive that — the keypair
 * because subscriptions are bound to it, the device list because re-subscribing
 * needs a permission tap on each phone.
 */
const PUSH_DIR = process.env.CW_PUSH_DIR || join(CLAUDE_HOME, 'push');
const KEY_FILE = () => join(PUSH_DIR, 'vapid.json');
const SUBS_FILE = () => join(PUSH_DIR, 'subscriptions.json');

/*
 * Who the push service should contact about this sender, per RFC 8292: a `mailto:`
 * or `https:` URI, used for rate-limit complaints and nothing else. This box has no
 * public identity of its own to offer — its hostname is deployment-specific and
 * lives in a config file that is deliberately not committed — so the default is
 * inert and overridable.
 */
const SUBJECT = process.env.CW_PUSH_SUBJECT || 'mailto:triplec@localhost';

/** Twelve hours: comfortably inside the 24 the spec allows, and re-signed per send. */
const TOKEN_TTL_S = 12 * 60 * 60;

/*
 * How long the push service should hold a message for a phone that is off.
 *
 * An hour. "Claude finished" is worth waking a phone for now and worth nothing
 * tomorrow morning — a notification that arrives long after the fact is a lie
 * about what just happened, and the status sheet answers the question properly
 * anyway.
 */
const TTL_S = 60 * 60;

/** A push service that has not answered in this long is not going to. */
const SEND_TIMEOUT_MS = 8000;

/*
 * The record size the payload is encrypted under, and the most plaintext that
 * leaves room for.
 *
 * A push service is only required to carry 4096 octets of body, and the body is
 * more than the plaintext: 86 octets of header, one padding delimiter, and 16 of
 * AEAD tag. RFC 8291 §4 does this subtraction itself and arrives at 3993, which is
 * the number to enforce — encrypting more produces a body a push service is
 * entitled to reject, and a rejection here is a notification that never appears.
 */
const RECORD_SIZE = 4096;
const MAX_PLAINTEXT = RECORD_SIZE - 86 - 1 - 16;

/*
 * How many devices to remember.
 *
 * A subscription is per browser *installation*, and a phone that is reinstalled,
 * cleared, or restored from a backup produces a new one without retiring the old.
 * Dead ones are pruned when the push service says they are gone, but that only
 * happens if something is sent to them, so the list is bounded here as well.
 */
const MAX_SUBSCRIPTIONS = 20;

/*
 * How many refused endpoints to remember.
 *
 * Small on purpose. This exists to catch a device re-posting the endpoint that was
 * just refused, which it does on its next page load — not next week.
 */
const MAX_GONE = 50;

/*
 * How many devices' last receipt to keep, and for how long a receipt answers for a
 * notification. Short on both counts: the question it answers is "did the one I just
 * asked for arrive", and an old receipt answering that is worse than none.
 */
const MAX_RECEIPTS = 50;
const RECEIPT_FRESH_MS = 2 * 60 * 1000;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (text) => Buffer.from(String(text || ''), 'base64url');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
/** `label` as bytes, NUL-terminated: the "info" strings in RFC 8188 and RFC 8291. */
const info = (label) => Buffer.concat([Buffer.from(label, 'utf8'), Buffer.alloc(1)]);

// --------------------------------------------------------------- the keypair
let keysPromise = null;

/**
 * The box's own keypair, made once and then read.
 *
 * Concurrency is handled by letting the filesystem decide: the writer uses `wx`,
 * so if two callers race the loser reads what the winner wrote instead of
 * overwriting it. Overwriting is the one outcome that matters, because it would
 * quietly invalidate every subscription on every device.
 */
async function loadKeys() {
  await mkdir(PUSH_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const saved = JSON.parse(await readFile(KEY_FILE(), 'utf8'));
      if (!saved.x || !saved.y || !saved.d) throw new Error('vapid.json is missing a key');
      return {
        // The JWK is what node can import; the raw point is what a browser wants
        // as `applicationServerKey`, and what goes in the `k=` parameter.
        privateKey: createPrivateKey({
          key: { kty: 'EC', crv: 'P-256', x: saved.x, y: saved.y, d: saved.d },
          format: 'jwk',
        }),
        publicRaw: Buffer.concat([Buffer.from([4]), unb64u(saved.x), unb64u(saved.y)]),
      };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' });
    try {
      await writeFile(
        KEY_FILE(),
        `${JSON.stringify({ x: jwk.x, y: jwk.y, d: jwk.d, createdAt: new Date().toISOString() }, null, 2)}\n`,
        { mode: 0o600, flag: 'wx' },
      );
    } catch (err) {
      // Someone else wrote it first. Go round again and read theirs.
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('could not read or create the VAPID keypair');
}

function keys() {
  if (!keysPromise) keysPromise = loadKeys().catch((err) => {
    keysPromise = null; // a transient failure must not be cached forever
    throw err;
  });
  return keysPromise;
}

/** The application server key a browser subscribes with, base64url. */
export async function vapidPublicKey() {
  return b64u((await keys()).publicRaw);
}

/**
 * The `Authorization` header for one endpoint.
 *
 * The audience is the push service's origin and nothing else — a token signed for
 * one service must not be replayable at another — and the signature is raw
 * `r || s` rather than DER, which is what `ieee-p1363` asks node for. Getting that
 * wrong produces a token every push service rejects with a 401 and no explanation.
 */
export async function vapidAuthorization(endpoint, { now = Date.now(), subject = SUBJECT } = {}) {
  const { privateKey, publicRaw } = await keys();
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(
    JSON.stringify({
      aud: new URL(endpoint).origin,
      exp: Math.floor(now / 1000) + TOKEN_TTL_S,
      sub: subject,
    }),
  );
  const signature = b64u(
    signPayload('sha256', Buffer.from(`${header}.${body}`), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }),
  );
  return `vapid t=${header}.${body}.${signature}, k=${b64u(publicRaw)}`;
}

// ------------------------------------------------------------- the encryption
/**
 * Encrypt one message for one device: RFC 8291 key agreement, RFC 8188 framing.
 *
 * The recipe, which is worth reading alongside the code because every step of it
 * is load-bearing and none of it is negotiable:
 *
 *   ecdh_secret = ECDH(as_private, ua_public)          -- 32 bytes
 *   PRK_key     = HMAC(auth_secret, ecdh_secret)
 *   key_info    = "WebPush: info" 0x00 ua_public as_public
 *   IKM         = HMAC(PRK_key, key_info 0x01)
 *   PRK         = HMAC(salt, IKM)
 *   CEK         = HMAC(PRK, "Content-Encoding: aes128gcm" 0x00 0x01)[0..16]
 *   NONCE       = HMAC(PRK, "Content-Encoding: nonce" 0x00 0x01)[0..12]
 *
 * The `auth` secret is what makes this end-to-end rather than merely encrypted:
 * without it the push service, which knows both public keys, could derive the
 * key itself. And the ephemeral sender keypair is per *message* — reusing one
 * across messages to the same device reuses the nonce, which is the one mistake
 * AES-GCM does not survive.
 *
 * `salt` and `asPrivate` exist to be injected by the test, so the published test
 * vector can be reproduced byte for byte. Nothing else should pass them.
 */
export function encryptPayload(plaintext, { p256dh, auth }, { salt, asPrivate } = {}) {
  const body = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  if (body.length > MAX_PLAINTEXT) {
    throw new Error(`push payload is ${body.length} bytes; the limit is ${MAX_PLAINTEXT}`);
  }
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('p256dh is not an uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('auth secret is not 16 bytes');

  const ecdh = createECDH('prime256v1');
  if (asPrivate) ecdh.setPrivateKey(asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const prkKey = hmac(authSecret, sharedSecret);
  const keyInfo = Buffer.concat([info('WebPush: info'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));

  const useSalt = salt || randomBytes(16);
  const prk = hmac(useSalt, ikm);
  const cek = hmac(prk, Buffer.concat([info('Content-Encoding: aes128gcm'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([info('Content-Encoding: nonce'), Buffer.from([1])])).subarray(0, 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 is the padding delimiter for the *last* record, and there is only ever
  // one record here. 0x01 would say "more records follow" and the browser would
  // reject the message rather than show it.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([body, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(RECORD_SIZE);
  // The header the receiver reads the salt and the sender's key back out of:
  // salt(16) | rs(4) | idlen(1) | keyid(65).
  return Buffer.concat([useSalt, recordSize, Buffer.from([asPublic.length]), asPublic, sealed]);
}

// ---------------------------------------------------------------- the devices
/**
 * Enough of a stored user agent to tell two of the operator's devices apart.
 *
 * A log line carrying 120 octets of `Mozilla/5.0 (…) AppleWebKit/…` boilerplate is
 * one nobody reads to the end, and the only question being asked of it is "which
 * device stopped getting notifications" — which the platform answers on its own.
 */
export function describeDevice(ua) {
  const platform = /\(([^)]*)\)/.exec(String(ua || ''))?.[1] || '';
  return platform.split(';').slice(0, 2).join(';').trim() || 'an unrecognised device';
}

/*
 * Endpoints the push service has told us are gone, since this process started.
 *
 * This breaks a loop that is otherwise both silent and permanent. When a phone's
 * registration expires at the push service, the browser goes on handing the app the
 * same PushSubscription — it still looks healthy, and its application server key
 * still matches ours, so neither side can tell it is dead. The app therefore
 * re-posts that endpoint on every load, the next notification is refused, it is
 * pruned, and round it goes: the switch reads "on" and the phone never buzzes.
 *
 * Remembering the refusal lets /api/push/subscribe say so, which is the one piece
 * of information the device is missing and cannot obtain for itself. In memory
 * rather than on disk because it is a hint, not a fact worth surviving a restart —
 * and bounded, because the keys are strings a browser chooses.
 */
const goneEndpoints = new Set();

function markGone(endpoint) {
  goneEndpoints.add(String(endpoint));
  // Insertion-ordered, so the first key is the oldest.
  while (goneEndpoints.size > MAX_GONE) goneEndpoints.delete(goneEndpoints.values().next().value);
}

/**
 * Has the push service already refused this endpoint?
 *
 * Answering true *consumes* the record. The caller's job is to tell one device once
 * — it then makes a genuinely new subscription with a different endpoint — and a
 * flag that stayed set would refuse to store the replacement if the browser ever
 * handed back the same string again.
 */
export function wasGone(endpoint) {
  return goneEndpoints.delete(String(endpoint));
}

/*
 * The last thing each device said about a notification it was sent.
 *
 * This exists because the receipt had nowhere to go but the journal, and the person
 * who needs it is holding the phone. The sequence it has to serve is: tap the switch,
 * a test is sent, and a few seconds later the device itself has an answer — the worker
 * ran, or it did not; the platform displayed, or it accepted and showed nothing. Until
 * now the app could only report what the *push service* said, which is "201 accepted"
 * in every one of those cases, so the switch said "sent a test one to this device"
 * about notifications that never appeared. For two days, truthfully, and nobody could
 * see the one line that disagreed.
 *
 * In memory and deliberately short-lived, like `goneEndpoints` above: a receipt is
 * evidence about one notification, not state. A restart losing them reads as "no
 * receipt yet", which is the honest answer rather than a stale yes.
 */
const receipts = new Map();

/** Remember what a device reported, keyed by the endpoint the notification went to. */
export function recordReceipt(endpoint, { shown, held, error, at = Date.now() } = {}) {
  const key = String(endpoint || '');
  if (!key) return;
  // Re-inserting keeps the map insertion-ordered by recency, so the first key is the
  // least recently heard from and is the right one to drop.
  receipts.delete(key);
  receipts.set(key, {
    at,
    shown: shown !== false,
    held: Number.isInteger(held) ? held : null,
    error: error ? String(error).slice(0, 200) : '',
  });
  while (receipts.size > MAX_RECEIPTS) receipts.delete(receipts.keys().next().value);
}

/**
 * What this device last said, or null if it has not said anything lately.
 *
 * Unlike `wasGone` this does not consume the record: the caller polls until an answer
 * appears, and a one-shot read would hand the answer to whichever poll happened to
 * land first and nothing to the one that asked.
 */
export function lastReceipt(endpoint, { now = Date.now() } = {}) {
  const found = receipts.get(String(endpoint || ''));
  if (!found) return null;
  if (now - found.at > RECEIPT_FRESH_MS) {
    receipts.delete(String(endpoint));
    return null;
  }
  return { ...found };
}

let subsPromise = null;

async function readSubscriptions() {
  try {
    const parsed = JSON.parse(await readFile(SUBS_FILE(), 'utf8'));
    return Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // A corrupt list must not stop the service booting or silence every later
      // notification; an empty list costs one permission tap per device.
      console.error(`push: cannot read ${SUBS_FILE()}: ${err.message}`);
    }
    return [];
  }
}

/**
 * The list, loaded once and then held.
 *
 * This process is the only writer, so a cache is honest. Serialised through one
 * promise because two subscribe requests arriving together would otherwise
 * read-modify-write over each other and lose a device.
 */
function withSubscriptions(mutate) {
  const next = (subsPromise || readSubscriptions()).then(async (current) => {
    if (!mutate) return current;
    const updated = await mutate([...current]);
    if (!updated) return current;
    await mkdir(PUSH_DIR, { recursive: true });
    // Written aside and renamed: a truncated file here is a list of devices that
    // cannot be parsed, and the cost of that is a permission tap on every phone.
    const temp = `${SUBS_FILE()}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify({ subscriptions: updated }, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, SUBS_FILE());
    return updated;
  });
  subsPromise = next.catch(() => readSubscriptions());
  return next;
}

/** Every device currently subscribed. */
export function listSubscriptions() {
  return withSubscriptions(null);
}

/**
 * Remember a device, replacing any earlier record of the same endpoint.
 *
 * Validated rather than trusted, even though reaching this needs a session: an
 * endpoint that is not a URL, or a key of the wrong length, would throw inside the
 * send loop instead — where the failure is a notification that silently never
 * arrives for anybody.
 */
export function addSubscription(subscription, { ua = '' } = {}) {
  const endpoint = String(subscription?.endpoint || '');
  const p256dh = subscription?.keys?.p256dh;
  const auth = subscription?.keys?.auth;
  let origin;
  try {
    origin = new URL(endpoint);
  } catch {
    throw new Error('endpoint is not a URL');
  }
  if (origin.protocol !== 'https:') throw new Error('endpoint must be https');
  if (unb64u(p256dh).length !== 65) throw new Error('keys.p256dh is not a P-256 point');
  if (unb64u(auth).length !== 16) throw new Error('keys.auth is not 16 bytes');

  return withSubscriptions((current) => {
    const kept = current.filter((s) => s.endpoint !== endpoint);
    kept.push({ endpoint, keys: { p256dh, auth }, ua: String(ua).slice(0, 200), at: Date.now() });
    // Oldest first, so the cap drops the least recently registered device rather
    // than refusing the one in front of the person tapping the switch.
    return kept.sort((a, b) => a.at - b.at).slice(-MAX_SUBSCRIPTIONS);
  });
}

/** Forget one device: the switch being turned off, or the push service saying it is gone. */
export function removeSubscription(endpoint) {
  return withSubscriptions((current) => current.filter((s) => s.endpoint !== String(endpoint)));
}

/**
 * Drop the in-memory copies, and optionally the files behind them.
 *
 * Only the test has a reason to. `{ keepFiles: true }` is how it checks that what
 * was written is what comes back — and how it points a send at a local server
 * without http endpoints having to be acceptable to `addSubscription`.
 */
export async function resetForTest({ keepFiles = false } = {}) {
  keysPromise = null;
  subsPromise = null;
  goneEndpoints.clear();
  receipts.clear();
  if (keepFiles) return;
  await unlink(KEY_FILE()).catch(() => {});
  await unlink(SUBS_FILE()).catch(() => {});
}

// ------------------------------------------------------------------ the send
/** A legal `Topic`: RFC 8030 allows at most 32 characters, from the base64url set. */
const TOPIC_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * A `Topic` for one conversation, from any string.
 *
 * Callers want to say "this is about /workspace/projects/foo, session abc", which
 * is neither short enough nor made of the right characters. A push service answers
 * 400 to an illegal Topic, and a 400 here is a notification that silently never
 * appears, so the name is hashed rather than trimmed — same input, same topic,
 * always legal.
 */
export function topicFor(key) {
  return createHash('sha256').update(String(key)).digest('base64url').slice(0, 24);
}

/**
 * Send one encrypted message to one device.
 *
 * Answers rather than throws, because the caller is a loop over devices and one
 * unreachable phone must not stop the rest. `gone` is the only answer that means
 * anything permanent: 404 and 410 are the push service saying this subscription
 * will never work again, which is the signal to forget it.
 */
export async function sendPush(subscription, payload, { topic, ttl = TTL_S, urgency = 'normal', timeoutMs = SEND_TIMEOUT_MS } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const body = encryptPayload(text, subscription.keys);
  const headers = {
    Authorization: await vapidAuthorization(subscription.endpoint),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(body.length),
    TTL: String(ttl),
    Urgency: urgency,
  };
  // One notification per conversation at a time: a second finish replaces the
  // first while it is still queued, rather than stacking on the lock screen.
  if (topic) {
    // Loud rather than dropped: an illegal Topic is a 400 from the push service,
    // and a 400 is indistinguishable from "the phone was asleep" from the outside.
    if (!TOPIC_RE.test(topic)) throw new Error(`topic ${JSON.stringify(topic)} is not 1-32 base64url characters; use topicFor()`);
    headers.Topic = topic;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch (err) {
    return { ok: false, status: 0, gone: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send to every subscribed device, and forget the ones that are gone.
 *
 * Every device gets its own encryption — the payload is encrypted *to* a device,
 * so there is nothing to reuse between them — and every failure is swallowed and
 * counted. The caller is a filesystem watcher on a timer; nothing up there can do
 * anything useful with a rejection.
 *
 * `results` carries the outcome per endpoint, because the totals cannot answer the
 * question the caller of /api/push/test is actually asking. That caller is one
 * device asking about *itself*, and a sum over every device says "sent" as long as
 * some other phone is healthy — which is exactly how a phone comes to be told its
 * test notification was sent one second after the push service refused it.
 */
export async function notifyAll(payload, { topic } = {}) {
  const devices = await listSubscriptions();
  if (!devices.length) return { sent: 0, failed: 0, pruned: 0, devices: 0, results: [] };

  const results = await Promise.all(
    devices.map(async (device) => {
      try {
        return { device, result: await sendPush(device, payload, { topic }) };
      } catch (err) {
        // A device with unusable keys, or a payload too big to encrypt. Counted and
        // logged below like any other failure — one bad record in the list must not
        // stop the notification reaching the phone in the person's hand.
        return { device, result: { ok: false, status: 0, gone: false, error: err.message } };
      }
    }),
  );
  const gone = results.filter((r) => r.result.gone).map((r) => r.device.endpoint);
  for (const endpoint of gone) {
    markGone(endpoint);
    await removeSubscription(endpoint);
  }

  const sent = results.filter((r) => r.result.ok).length;
  const failed = results.length - sent;
  /*
   * Every failure says so, including the prunes.
   *
   * A prune used to be the one outcome that logged nothing, on the reasoning that it
   * is routine housekeeping rather than an error. It is not: "the push service has
   * forgotten this device" is precisely the event behind a phone that has silently
   * stopped buzzing, and skipping it meant the failure everyone was looking for was
   * the only one that left no trace anywhere — not here, not in the device list, and
   * not on the phone, whose switch still read "on".
   */
  for (const { device, result } of results) {
    if (result.ok) continue;
    const who = `${new URL(device.endpoint).host} (${describeDevice(device.ua)})`;
    if (result.gone) {
      console.error(`push: ${who} answered ${result.status} — forgotten by the push service, dropping it`);
    } else {
      console.error(`push: ${who} answered ${result.status}${result.error ? ` (${result.error})` : ''}`);
    }
  }
  /*
   * The prune that leaves nothing behind, in a line of its own.
   *
   * Dropping one device of several is housekeeping. Dropping the *last* one is the
   * whole feature switching itself off: every send after this returns `devices: 0`
   * without touching the network, and turn-watcher.js stops reading transcripts
   * altogether. That state held here for two days and the only evidence of it
   * anywhere was an absence — no device left to fail, so nothing left to log, while
   * the switch on the phone still read "on". An outage that logs nothing is one
   * nobody can be told about, so the transition says so itself.
   */
  if (gone.length && !(await listSubscriptions()).length) {
    console.error(
      'push: that was the last device — nothing is subscribed now, so no notification will be '
      + 'sent until a device opens the app again',
    );
  }
  return {
    sent,
    failed,
    pruned: gone.length,
    devices: results.length,
    results: results.map(({ device, result }) => ({
      endpoint: device.endpoint,
      ok: result.ok,
      status: result.status,
      gone: result.gone,
    })),
  };
}
