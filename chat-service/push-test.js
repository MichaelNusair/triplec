/**
 * Web Push, checked against the published vector rather than against itself.
 *
 * Encryption code that is wrong in a way that is *self-consistent* passes any
 * round-trip test you write for it and then fails on every real phone, with no
 * error anywhere: the push service accepts the POST, the browser cannot decrypt
 * it, and the notification simply never appears. The only defence is an
 * independently produced answer, so the first section reproduces the test vector
 * from RFC 8291 §5 byte for byte — same plaintext, same salt, same ephemeral
 * keypair, therefore the same 145-octet body the RFC prints.
 *
 * After that: a decrypt written from the receiver's side (which is what a browser
 * does, and the only way to know a *random* salt and keypair work too), the VAPID
 * signature verified with the public half, the keypair's stability across a
 * restart — a new keypair silently invalidates every device that has already
 * subscribed — and the send loop's handling of a push service that says a
 * subscription is gone.
 *
 * Run: node chat-service/push-test.js
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { once } from 'events';
import { createECDH, createDecipheriv, createHmac, createPublicKey, verify as verifySignature } from 'crypto';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'push-test-'));
const PUSH_DIR = path.join(TMP, 'push');

// Both read at import time. PROJECTS_ROOT because push.js reaches session-manager.js
// for CLAUDE_HOME; CW_PUSH_DIR so nothing here touches the real keypair — writing a
// new one over that would unsubscribe every device on every phone.
process.env.PROJECTS_ROOT = path.join(TMP, 'projects');
process.env.CW_PUSH_DIR = PUSH_DIR;
fs.mkdirSync(process.env.PROJECTS_ROOT, { recursive: true });

const push = await import('./push.js');

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}`);
  }
};
const section = (name) => console.log(`\n${name}`);

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (text) => Buffer.from(String(text), 'base64url');

// --------------------------------------------------------------------------
// The vector, transcribed from RFC 8291 §5 and Appendix A. Every value the RFC
// prints is here, not just the answer, so a failure says *which* step drifted.
const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  padded: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24C',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ecdhSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  prkKey: 'Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  prk: '09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
  // The request body from §5, base64url'd as one blob rather than as two pieces —
  // which is why it cannot be compared against `header + ciphertext` as *strings*.
  // 86 is not a multiple of 3, so the two encodings differ at the join even though
  // the bytes are identical.
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml'
    + 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
    + 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const RECIPIENT = { p256dh: V.uaPublic, auth: V.authSecret };

section('The published vector, reproduced exactly:');
const body = push.encryptPayload(V.plaintext, RECIPIENT, {
  salt: unb64u(V.salt),
  asPrivate: unb64u(V.asPrivate),
});

ok(
  body.equals(unb64u(V.body)),
  'the encrypted body is not the one RFC 8291 §5 prints — no phone will decrypt this',
);
// 144, not the 145 the RFC's own `Content-Length` claims: its example body blob
// decodes to 144 octets, and 86 + 42 + 16 is 144. The header says otherwise because
// the RFC says so, not because anything here is off by one.
ok(body.length === 144, `the body is ${body.length} octets, not the 144 of the RFC's example`);

// The pieces, so a mismatch above localises instead of just going red.
ok(b64u(body.subarray(0, 86)) === V.header, 'the 86-octet header does not match the RFC');
ok(b64u(body.subarray(86)) === V.ciphertext, 'the ciphertext does not match the RFC');
ok(b64u(body.subarray(0, 16)) === V.salt, 'the salt is not written at the front of the header');
ok(body.readUInt32BE(16) === 4096, `the record size field says ${body.readUInt32BE(16)}, not 4096`);
ok(body[20] === 65, `the key id length says ${body[20]}, not the 65 octets of a P-256 point`);
ok(b64u(body.subarray(21, 86)) === V.asPublic, "the header does not carry the sender's public key");

section('Each derivation step, so a break says which one:');
{
  // Independently derived here from the RFC's own inputs. If push.js and this
  // section disagree with each other, the section above has already failed; if
  // both agree but disagree with the RFC, these say where.
  const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
  const info = (label) => Buffer.concat([Buffer.from(label, 'utf8'), Buffer.alloc(1)]);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(unb64u(V.asPrivate));

  ok(b64u(ecdh.getPublicKey()) === V.asPublic, "the sender's private key does not produce the RFC's public key");
  const shared = ecdh.computeSecret(unb64u(V.uaPublic));
  ok(b64u(shared) === V.ecdhSecret, 'ECDH(as_private, ua_public) is not the RFC ecdh_secret');

  const prkKey = hmac(unb64u(V.authSecret), shared);
  ok(b64u(prkKey) === V.prkKey, 'PRK_key is not HMAC(auth_secret, ecdh_secret)');

  const keyInfo = Buffer.concat([info('WebPush: info'), unb64u(V.uaPublic), unb64u(V.asPublic)]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  ok(b64u(ikm) === V.ikm, 'IKM is wrong — check the order of the two public keys in key_info');

  const prk = hmac(unb64u(V.salt), ikm);
  ok(b64u(prk) === V.prk, 'PRK is not HMAC(salt, IKM)');

  const cek = hmac(prk, Buffer.concat([info('Content-Encoding: aes128gcm'), Buffer.from([1])])).subarray(0, 16);
  ok(b64u(cek) === V.cek, 'the content encryption key is not the RFC CEK');

  const nonce = hmac(prk, Buffer.concat([info('Content-Encoding: nonce'), Buffer.from([1])])).subarray(0, 12);
  ok(b64u(nonce) === V.nonce, 'the nonce is not the RFC nonce');
}

// --------------------------------------------------------------------------
/**
 * Decrypt the way a browser does: from the receiver's keys, reading the salt and
 * the sender's key back out of the header rather than being told them.
 */
function decryptAsBrowser(payload, { uaPrivate, uaPublic, authSecret }) {
  const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
  const info = (label) => Buffer.concat([Buffer.from(label, 'utf8'), Buffer.alloc(1)]);

  const salt = payload.subarray(0, 16);
  const idLen = payload[20];
  const asPublic = payload.subarray(21, 21 + idLen);
  const sealed = payload.subarray(21 + idLen);

  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(unb64u(uaPrivate));
  const prkKey = hmac(unb64u(authSecret), ecdh.computeSecret(asPublic));
  const keyInfo = Buffer.concat([info('WebPush: info'), unb64u(uaPublic), asPublic]);
  const prk = hmac(salt, hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])])));
  const cek = hmac(prk, Buffer.concat([info('Content-Encoding: aes128gcm'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([info('Content-Encoding: nonce'), Buffer.from([1])])).subarray(0, 12);

  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  // Strip the RFC 8188 padding delimiter, which must be 0x02 on the last record.
  ok(plain[plain.length - 1] === 2, 'the padding delimiter is not 0x02, so the browser rejects the record');
  return plain.subarray(0, plain.length - 1).toString('utf8');
}

section('A real payload, with a real random salt, comes back out:');
{
  const message = JSON.stringify({ title: 'Claude finished · triplec', body: 'Deployed. 144/144 checks passed.' });
  const sealed = push.encryptPayload(message, RECIPIENT);
  ok(
    decryptAsBrowser(sealed, { uaPrivate: V.uaPrivate, uaPublic: V.uaPublic, authSecret: V.authSecret }) === message,
    'a payload encrypted with a fresh salt and keypair does not decrypt',
  );

  // The ephemeral keypair must be per message: the nonce is derived from it, and a
  // repeated key/nonce pair under AES-GCM leaks the plaintexts of both messages.
  const again = push.encryptPayload(message, RECIPIENT);
  ok(
    !sealed.subarray(21, 86).equals(again.subarray(21, 86)),
    'two messages reused one ephemeral keypair, which reuses the AES-GCM nonce',
  );
  ok(!sealed.equals(again), 'two encryptions of the same text produced identical bytes');

  const unicode = 'Готово — ✅ 完了';
  ok(
    decryptAsBrowser(push.encryptPayload(unicode, RECIPIENT), {
      uaPrivate: V.uaPrivate,
      uaPublic: V.uaPublic,
      authSecret: V.authSecret,
    }) === unicode,
    'a payload outside ASCII does not survive the round trip',
  );
}

section('Refuses what a push service would silently drop:')
{
  // 3993 is what RFC 8291 §4 leaves for plaintext once the header, the padding
  // delimiter and the AEAD tag have their share of the 4096 octets a push service
  // is required to carry.
  const limit = (n) => {
    try {
      push.encryptPayload('x'.repeat(n), RECIPIENT);
      return null;
    } catch (e) {
      return e.message;
    }
  };
  ok(limit(3993) === null, 'the largest payload the spec allows is refused');
  ok(/limit is 3993/.test(limit(3994) || ''), 'an over-long payload is encrypted anyway and lost in transit');

  const bad = (recipient) => {
    try {
      push.encryptPayload('hi', recipient);
      return null;
    } catch (e) {
      return e.message;
    }
  };
  ok(/P-256/.test(bad({ p256dh: b64u(Buffer.alloc(20)), auth: V.authSecret }) || ''), 'a truncated device key is accepted');
  ok(/16 bytes/.test(bad({ p256dh: V.uaPublic, auth: b64u(Buffer.alloc(8)) }) || ''), 'a short auth secret is accepted');
}

section('A Topic is always legal, whatever it is made from:');
{
  const long = push.topicFor('/workspace/projects/triplec|9f0c1b2a-3d4e-5f60-7182-93a4b5c6d7e8');
  ok(/^[A-Za-z0-9_-]{1,32}$/.test(long), `topicFor produced ${long}, which a push service answers 400 to`);
  ok(push.topicFor('a') === push.topicFor('a'), 'the same conversation gets a different topic each time, so notifications stack');
  ok(push.topicFor('a') !== push.topicFor('b'), 'two conversations share a topic, so one replaces the other');
}

// --------------------------------------------------------------------------
section('The VAPID signature, verified with the public half:');
const publicKey = await push.vapidPublicKey();
{
  const raw = unb64u(publicKey);
  ok(raw.length === 65 && raw[0] === 4, 'the application server key is not an uncompressed P-256 point');
  ok(publicKey === (await push.vapidPublicKey()), 'the key changes between calls');

  const header = await push.vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc123?x=1');
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  ok(Boolean(match), `the Authorization header is not the RFC 8292 form: ${header.slice(0, 40)}…`);
  const [, token, k] = match || [, '', ''];
  ok(k === publicKey, 'the k= parameter is not the key the browser subscribed with');

  const [h, p, sig] = token.split('.');
  const claims = JSON.parse(unb64u(p).toString('utf8'));
  ok(JSON.parse(unb64u(h).toString('utf8')).alg === 'ES256', 'the JWT is not signed with ES256');
  ok(claims.aud === 'https://fcm.googleapis.com', `aud is ${claims.aud} — it must be the push service origin, with no path`);
  ok(claims.sub.startsWith('mailto:') || claims.sub.startsWith('https:'), `sub is ${claims.sub}, which RFC 8292 does not allow`);
  const hours = (claims.exp - Date.now() / 1000) / 3600;
  ok(hours > 0 && hours <= 24, `exp is ${hours.toFixed(1)}h away; a push service rejects anything over 24h`);

  // The signature must be raw r||s (64 bytes), not DER. A DER signature is the
  // classic VAPID mistake: it verifies nowhere and every push service answers 401.
  const signature = unb64u(sig);
  ok(signature.length === 64, `the signature is ${signature.length} bytes, so it is DER rather than raw r||s`);
  const keyObject = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) },
    format: 'jwk',
  });
  const verify = (data, sigBytes) =>
    verifySignature('sha256', Buffer.from(data), { key: keyObject, dsaEncoding: 'ieee-p1363' }, sigBytes);
  ok(verify(`${h}.${p}`, signature), 'the signature does not verify against the public key that is sent with it');
  ok(!verify(`${h}.${p}x`, signature), 'a tampered token still verifies');

  const other = await push.vapidAuthorization('https://updates.push.services.mozilla.com/wpush/v2/xyz');
  const otherAud = JSON.parse(unb64u(other.split('.')[1]).toString('utf8')).aud;
  ok(otherAud === 'https://updates.push.services.mozilla.com', `aud is ${otherAud} for a second service, so one token is replayable at another`);
}

section('The keypair survives a restart, because subscriptions are bound to it:');
{
  const file = path.join(PUSH_DIR, 'vapid.json');
  const before = fs.readFileSync(file, 'utf8');
  const mode = fs.statSync(file).mode & 0o777;
  ok(mode === 0o600, `vapid.json is mode ${mode.toString(8)}; the private key should not be group- or world-readable`);

  // A separate process, which is what a deploy or a crash produces. If it mints its
  // own keypair, every phone that has already subscribed goes quiet with no error.
  const child = spawn(process.execPath, ['-e', "import('./push.js').then((m) => m.vapidPublicKey()).then((k) => console.log(k))"], {
    cwd: import.meta.dirname,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let errOut = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { errOut += d; });
  await once(child, 'exit');
  ok(out.trim() === publicKey, `a second process reported a different key (${out.trim().slice(0, 12)}…): ${errOut.slice(0, 120)}`);
  ok(fs.readFileSync(file, 'utf8') === before, 'reading the keypair rewrote it');
}

// --------------------------------------------------------------------------
section('The device list:');
const DEVICE = (n) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`,
  keys: { p256dh: V.uaPublic, auth: V.authSecret },
});
{
  await push.addSubscription(DEVICE(1), { ua: 'Pixel' });
  await push.addSubscription(DEVICE(2));
  ok((await push.listSubscriptions()).length === 2, 'two devices did not both stick');

  await push.addSubscription(DEVICE(1), { ua: 'Pixel again' });
  const list = await push.listSubscriptions();
  ok(list.length === 2, 're-subscribing the same endpoint added a duplicate, so every notification arrives twice');
  ok(list.find((s) => s.endpoint === DEVICE(1).endpoint).ua === 'Pixel again', 'the newer record did not replace the older one');

  await push.removeSubscription(DEVICE(2).endpoint);
  ok((await push.listSubscriptions()).length === 1, 'turning the switch off left the device subscribed');

  const rejected = async (subscription) => {
    try {
      await push.addSubscription(subscription);
      return null;
    } catch (e) {
      return e.message;
    }
  };
  ok(await rejected({ endpoint: 'not-a-url', keys: DEVICE(1).keys }), 'a non-URL endpoint was stored');
  ok(await rejected({ endpoint: 'http://fcm.example/send/1', keys: DEVICE(1).keys }), 'a plaintext endpoint was stored');
  ok(await rejected({ endpoint: DEVICE(3).endpoint, keys: { p256dh: 'abc', auth: V.authSecret } }), 'a device key that is not a P-256 point was stored');
  ok(await rejected({ endpoint: DEVICE(3).endpoint }), 'a subscription with no keys at all was stored');
  ok((await push.listSubscriptions()).length === 1, 'a rejected subscription still changed the list');

  // Written through, not just held: the switch is tapped once per phone, and a
  // restart that forgets the list costs another permission prompt on each.
  const saved = JSON.parse(fs.readFileSync(path.join(PUSH_DIR, 'subscriptions.json'), 'utf8'));
  ok(saved.subscriptions.length === 1 && saved.subscriptions[0].endpoint === DEVICE(1).endpoint, 'the list on disk is not the list in memory');

  for (let n = 10; n < 35; n += 1) await push.addSubscription(DEVICE(n));
  const capped = await push.listSubscriptions();
  ok(capped.length === 20, `the list grew to ${capped.length}; stale subscriptions accumulate forever`);
  ok(capped.some((s) => s.endpoint === DEVICE(34).endpoint), 'the cap dropped the device that just subscribed');
}

// --------------------------------------------------------------------------
/** A stand-in push service: records what arrives, answers however the path says. */
function pushService() {
  const seen = [];
  const held = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      if (req.url.startsWith('/gone')) res.writeHead(410).end();
      else if (req.url.startsWith('/oops')) res.writeHead(500).end('nope');
      else if (req.url.startsWith('/slow')) held.push(res); // never answered
      else res.writeHead(201).end();
    });
  });
  return { server, seen, held };
}

section('Sending: what reaches the push service, and what it says back:');
const { server, seen, held } = pushService();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const at = (p) => ({ endpoint: `${base}${p}`, keys: { p256dh: V.uaPublic, auth: V.authSecret } });
{
  const payload = { title: 'Claude finished · triplec', body: 'All three features are in.' };
  const topic = push.topicFor('/workspace/projects/triplec|abc');
  const result = await push.sendPush(at('/ok/1'), payload, { topic });
  ok(result.ok && result.status === 201 && !result.gone, `a 201 was not reported as sent: ${JSON.stringify(result)}`);

  const sent = seen.at(-1);
  ok(/^vapid t=.+, k=.+$/.test(sent.headers.authorization || ''), 'the request carried no VAPID authorization');
  ok(sent.headers['content-encoding'] === 'aes128gcm', `Content-Encoding is ${sent.headers['content-encoding']}, which the browser cannot read`);
  ok(sent.headers['content-type'] === 'application/octet-stream', `Content-Type is ${sent.headers['content-type']}`);
  ok(Number(sent.headers['content-length']) === sent.body.length, `Content-Length says ${sent.headers['content-length']} but ${sent.body.length} octets arrived`);
  ok(Number(sent.headers.ttl) > 0, 'no TTL header, which some push services reject outright');
  ok(sent.headers.topic === topic, `Topic is ${sent.headers.topic}, so a second finish will not replace the first`);
  ok(
    decryptAsBrowser(sent.body, { uaPrivate: V.uaPrivate, uaPublic: V.uaPublic, authSecret: V.authSecret }) === JSON.stringify(payload),
    'what arrived at the push service does not decrypt to what was sent',
  );

  let topicErr = null;
  try {
    await push.sendPush(at('/ok/2'), payload, { topic: 'a topic with spaces and rather more than thirty-two characters' });
  } catch (e) {
    topicErr = e;
  }
  ok(topicErr && /topicFor/.test(topicErr.message), 'an illegal Topic is sent anyway, and the notification silently never appears');

  ok((await push.sendPush(at('/gone/1'), payload)).gone, 'a 410 was not recognised as a dead subscription');
  ok((await push.sendPush(at('/oops/1'), payload)).gone === false, 'a 500 was treated as a dead subscription, unsubscribing a live phone');
  const broken = await push.sendPush({ endpoint: `http://127.0.0.1:1/x`, keys: at('/ok').keys }, payload);
  ok(!broken.ok && broken.status === 0 && broken.error, 'an unreachable push service did not report an error');

  const slow = await push.sendPush(at('/slow/1'), payload, { timeoutMs: 150 });
  ok(!slow.ok && /abort/i.test(slow.error || ''), `a push service that never answers was not timed out: ${JSON.stringify(slow)}`);
}

section('Notifying every device, and forgetting the ones that are gone:');
{
  // Written straight to the file because `addSubscription` will not store an http
  // endpoint — correctly, since a real one is always https. This is the only way to
  // point the send loop at a local server.
  fs.writeFileSync(
    path.join(PUSH_DIR, 'subscriptions.json'),
    JSON.stringify({ subscriptions: [at('/ok/live'), at('/gone/dead'), at('/ok/other')] }),
  );
  await push.resetForTest({ keepFiles: true });

  const before = seen.length;
  /*
   * The log is captured, because its silence is what made a real outage unreadable: a
   * device dropped for a 410 was the one outcome that wrote nothing, so the list
   * emptied itself over a day and every log on the box agreed that all was well.
   */
  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  let summary;
  try {
    summary = await push.notifyAll({ title: 'Claude finished', body: 'done' }, { topic: push.topicFor('x') });
  } finally {
    console.error = realError;
  }
  ok(summary.devices === 3, `notifyAll reported ${summary.devices} devices, not 3`);
  ok(summary.sent === 2, `${summary.sent} of 3 were sent`);
  ok(summary.failed === 1, `${summary.failed} failures reported for one dead subscription`);
  ok(summary.pruned === 1, 'the dead subscription was not pruned, so it is retried forever');
  ok(seen.length - before === 3, 'not every device was sent to');
  ok(logged.length === 1, `${logged.length} lines logged for one refusal among three sends`);
  ok(/forgotten by the push service/.test(logged[0] || ''), `dropping a device said nothing legible: ${JSON.stringify(logged)}`);
  ok(/410/.test(logged[0] || ''), 'the log does not say what the push service answered');

  /*
   * Per-device results. Without these the only answer the API can give is a total,
   * and a total is how the switch on a phone came to report a test notification as
   * sent one second after that very phone's endpoint had been refused: the desktop
   * received it, so `sent` was 1.
   */
  ok(summary.results.length === 3, `results described ${summary.results.length} devices, not 3`);
  const live = summary.results.find((r) => r.endpoint === at('/ok/live').endpoint);
  const dead = summary.results.find((r) => r.endpoint === at('/gone/dead').endpoint);
  ok(live && live.ok && live.status === 201, `a device that received the push cannot tell from its own result: ${JSON.stringify(live)}`);
  ok(dead && dead.gone && !dead.ok, `a refused device is not told that it was refused: ${JSON.stringify(dead)}`);

  // Remembered, so /api/push/subscribe can tell that phone the one thing it has no
  // way to find out — and remembered once, because it then has a new endpoint.
  ok(push.wasGone(at('/gone/dead').endpoint), 'the refusal was not remembered, so the device re-offers the dead endpoint forever');
  ok(!push.wasGone(at('/gone/dead').endpoint), 'the record outlived being read, so the replacement subscription is refused too');
  ok(!push.wasGone(at('/ok/live').endpoint), 'a device that is working was told to resubscribe');

  const left = await push.listSubscriptions();
  ok(left.length === 2 && !left.some((s) => s.endpoint.includes('/gone/')), 'the pruned device is still in the list');
  ok(JSON.parse(fs.readFileSync(path.join(PUSH_DIR, 'subscriptions.json'), 'utf8')).subscriptions.length === 2, 'the pruning was not written to disk');

  /*
   * Dropping the *last* device is a different event from dropping one of several, and
   * the one worth waking up for: from here on every send returns `devices: 0` without
   * a network call and turn-watcher.js stops reading transcripts at all. That is the
   * state this box sat in for two days, and the journal for those two days contains no
   * line about push whatsoever — there was no device left to fail.
   */
  fs.writeFileSync(
    path.join(PUSH_DIR, 'subscriptions.json'),
    JSON.stringify({ subscriptions: [at('/gone/last')] }),
  );
  await push.resetForTest({ keepFiles: true });
  const lastWords = [];
  console.error = (...args) => lastWords.push(args.join(' '));
  try {
    await push.notifyAll({ title: 'Claude finished', body: 'done' }, { topic: push.topicFor('x') });
  } finally {
    console.error = realError;
  }
  ok(lastWords.length === 2, `${lastWords.length} lines logged for the prune that emptied the list`);
  ok(/last device/.test(lastWords[1] || ''), `emptying the device list did not say so: ${JSON.stringify(lastWords)}`);
  ok(!(await push.listSubscriptions()).length, 'the last device survived being forgotten by the push service');

  // A device with unusable keys must not take the batch down with it.
  fs.writeFileSync(
    path.join(PUSH_DIR, 'subscriptions.json'),
    JSON.stringify({ subscriptions: [{ endpoint: `${base}/ok/fine`, keys: { p256dh: 'nonsense', auth: V.authSecret } }, at('/ok/healthy')] }),
  );
  await push.resetForTest({ keepFiles: true });
  const mixed = await push.notifyAll({ title: 'x', body: 'y' });
  ok(mixed.sent === 1 && mixed.failed === 1, `a corrupt record changed the outcome for the healthy device: ${JSON.stringify(mixed)}`);

  await push.resetForTest({ keepFiles: true });
  fs.writeFileSync(path.join(PUSH_DIR, 'subscriptions.json'), '{ not json');
  await push.resetForTest({ keepFiles: true });
  const none = await push.notifyAll({ title: 'x', body: 'y' });
  ok(none.devices === 0, 'a corrupt subscriptions file was not survived');
  // Shaped the same with nothing to send to, so the caller can read `results` without
  // asking whether there were any devices.
  ok(Array.isArray(none.results) && none.results.length === 0, 'the no-devices answer has no results array, so every caller needs a special case');
}

section('Naming a device in one line, for a log nobody wants to read twice:');
{
  const android = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36';
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
  ok(push.describeDevice(android) === 'Linux; Android 10', `the phone is described as "${push.describeDevice(android)}"`);
  ok(push.describeDevice(mac) === 'Macintosh; Intel Mac OS X 10_15_7', `the desktop is described as "${push.describeDevice(mac)}"`);
  // The question these lines answer is "which of my two devices stopped", so the two
  // must not describe themselves the same way.
  ok(push.describeDevice(android) !== push.describeDevice(mac), 'the phone and the desktop are described identically, which is the one thing the line is for');
  ok(push.describeDevice('') === 'an unrecognised device', 'a device that sent no user agent is described as nothing at all');
  ok(push.describeDevice(undefined) === 'an unrecognised device', 'a missing user agent throws rather than describing anything');
  ok(push.describeDevice('curl/8.4.0') === 'an unrecognised device', 'a user agent with no platform is described as nothing at all');
}

for (const res of held) res.destroy();
server.closeAllConnections();
server.close();
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
