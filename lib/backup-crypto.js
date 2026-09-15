/* Tvara — backup file cryptography.
 *
 * Shared by the Recall page and the background worker so exactly one
 * implementation decides what a `.lctbackup` file is. The file is the only copy
 * of the archive that ever leaves the browser profile, so it is treated as
 * hostile-environment storage: assume it lands in Downloads, a cloud sync
 * folder, a backup tape and an attacker's hands.
 *
 * Envelope v2
 *   KEK  = PBKDF2-SHA256(passphrase, salt32, iterations >= 600k)   never stored
 *   FK   = 32 random bytes, fresh per file                          the bulk key
 *   file = AES-256-GCM(FK, payload) with the header as AAD
 *   FK   = AES-256-GCM(KEK, FK)     with the header as AAD
 *
 * Why two layers: the passphrase never touches the bulk data, and the header
 * (KDF name, iteration count, compression, version) is authenticated by BOTH
 * layers. Editing `iterations` down to 1 to make a dictionary attack cheap, or
 * swapping the compression field to steer the parser, breaks the GCM tag
 * instead of being honoured. v1 files carry no such binding — they are still
 * readable, and re-saving upgrades them.
 *
 * What this does NOT protect: the live archive inside the browser profile.
 * Anything that can read extension storage can already read the plaintext
 * IndexedDB, so no key kept there could add security. The passphrase is the
 * only secret, it is never persisted, and it is never recoverable.
 */
(() => {
  "use strict";

  const FORMAT = "lct-backup";
  const PAYLOAD_FORMAT = "lct-backup-payload";
  const VERSION = 3;   // v3 carries an entitlement stamp; v1/v2 still readable
  const KDF_ITERATIONS = 1000000;
  // A file claiming fewer rounds than this is refused outright. Reading the
  // count from the envelope is required for forward compatibility; trusting it
  // without a floor would let an attacker hand back a 1-round file and
  // brute-force the passphrase offline.
  const KDF_MIN_ITERATIONS = 600000;
  const KDF_MAX_ITERATIONS = 10000000;
  const SALT_BYTES = 32;
  const IV_BYTES = 12;
  const KEY_BYTES = 32;
  const MIN_PASSPHRASE = 12;
  // A JSON envelope is ~1.4x its ciphertext; refuse anything that cannot be a
  // real archive before allocating for it.
  const MAX_FILE_BYTES = 512 * 1024 * 1024;

  /* Two kinds of file, one format. "passphrase" is everything above. "none" is
     the user deciding they want to read their own archive in a text editor:
     secrecy is gone by construction, integrity is not — the licence stamp signs
     a digest of the snapshot, so an edited file is refused on restore instead
     of being imported as though it were theirs. Absent field means passphrase;
     every file written before this existed is one. */
  const PROTECTION_NONE = "none";
  const PROTECTION_PASSPHRASE = "passphrase";

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function bytesToBase64(bytes) {
    const parts = [];
    for (let i = 0; i < bytes.length; i += 0x8000) {
      parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
    }
    return btoa(parts.join(""));
  }

  function base64ToBytes(value) {
    const raw = atob(String(value || ""));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  /* Key order is not part of what a snapshot means, but it IS part of what
     JSON.stringify emits, and a digest that moved when a parser reordered keys
     would report an untouched file as altered. Sorted recursively, at both
     ends, so the hash depends on the data and nothing else. */
  function canonical(value) {
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    if (value && typeof value === "object") {
      return "{" + Object.keys(value).sort().map((k) =>
        JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
    }
    return JSON.stringify(value === undefined ? null : value);
  }

  async function digestOf(value) {
    const mac = await crypto.subtle.digest("SHA-256", encoder.encode(canonical(value)));
    return bytesToBase64(new Uint8Array(mac));
  }

  /* Constant-time over the compared bytes: a digest check that returned early
     on the first wrong character would leak the target one byte at a time. */
  function sameDigest(a, b) {
    const x = String(a || ""), y = String(b || "");
    if (x.length !== y.length || !x.length) return false;
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
    return diff === 0;
  }

  /* Best-effort scrub. JS strings are immutable and the GC owns their copies,
     so this only covers the buffers we control — worth doing, not a guarantee. */
  function wipe(bytes) {
    if (bytes && bytes.fill) { try { bytes.fill(0); } catch { /* frozen view */ } }
  }

  /* ---------- passphrase policy ---------- */

  const WEAK = [/^(.)\1+$/, /^(012|123|234|345|456|567|678|789|890)+/, /password/i,
    /qwerty/i, /letmein/i, /^abc(def)?/i, /longchat/i, /^chatgpt/i];

  /** Score 0-4 with a human reason. Enforced on create, never on read. */
  function ratePassphrase(passphrase) {
    const value = String(passphrase || "");
    if (value.length < MIN_PASSPHRASE) {
      return { ok: false, score: 0, reason: `Use at least ${MIN_PASSPHRASE} characters. This passphrase is the only thing standing between the file and whoever finds it.` };
    }
    if (WEAK.some((re) => re.test(value))) {
      return { ok: false, score: 0, reason: "That is a guessable passphrase. Anyone who gets the file gets every chat in it." };
    }
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
    const distinct = new Set(value).size;
    if (classes < 2 && distinct < 12) {
      return { ok: false, score: 1, reason: "Mix in another character type, or use a longer multi-word passphrase." };
    }
    let score = 1;
    if (value.length >= 16) score++;
    if (value.length >= 24 || classes >= 3) score++;
    if (value.length >= 32 && classes >= 3) score++;
    return { ok: true, score: Math.min(4, score), reason: "" };
  }

  /* 25 characters drawn from a 32-symbol alphabet is 125 bits of entropy —
     past the point where the KDF matters at all, because no iteration count,
     GPU farm or wordlist touches a uniform 2^125. Crockford's alphabet without
     I, L, O and U, so nothing is misread off a piece of paper, and grouped
     because that is what makes a long secret typeable twice without error. */
  const PASS_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

  function generatePassphrase(groups = 5, size = 5) {
    const total = Math.max(1, Math.floor(groups)) * Math.max(1, Math.floor(size));
    const bytes = crypto.getRandomValues(new Uint8Array(total));
    let out = "";
    // 32 divides 256, so the mask is uniform and needs no rejection sampling.
    for (let i = 0; i < total; i++) {
      out += PASS_ALPHABET[bytes[i] & 31];
      if ((i + 1) % size === 0 && i + 1 < total) out += "-";
    }
    wipe(bytes);
    return out;
  }

  /* ---------- key schedule ---------- */

  async function deriveKek(passphrase, salt, iterations) {
    const secret = encoder.encode(String(passphrase));
    let material;
    try {
      material = await crypto.subtle.importKey("raw", secret, "PBKDF2", false, ["deriveKey"]);
      return await crypto.subtle.deriveKey(
        { name: "PBKDF2", hash: "SHA-256", salt, iterations },
        material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    } finally {
      wipe(secret);
    }
  }

  /* PBKDF2-SHA256 is the only stretcher every engine ships natively: no WASM
     to download, no SIMD to detect, the same code path on a five-year-old phone
     as on a workstation. What differs between them is how many rounds they can
     afford, so it is measured rather than assumed. KDF_ITERATIONS is the floor
     — the slowest device still gets today's strength — and a fast machine
     spends its speed on rounds the attacker must also pay for. The count is
     written into the envelope and re-checked against that floor on open, so a
     file cannot talk a reader into a cheap derivation.

     Measured once per context: the answer does not change while the page is
     open, and the probe itself costs a tenth of a real derivation. */
  let calibrated = 0;

  async function calibrateIterations(targetMs = 1200) {
    if (calibrated) return calibrated;
    const probe = 100000;
    const clock = (typeof self !== "undefined" && self.performance) ? self.performance : Date;
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    let wanted;
    try {
      const started = clock.now();
      await deriveKek("calibration probe, not a secret", salt, probe);
      const spent = Math.max(1, clock.now() - started);
      wanted = Math.round((probe / spent) * targetMs);
    } catch { wanted = KDF_ITERATIONS; }
    calibrated = Math.min(KDF_MAX_ITERATIONS,
      Math.max(KDF_ITERATIONS, Math.round(wanted / 100000) * 100000));
    return calibrated;
  }

  /**
   * What the KEK layer authenticates: the KDF parameters, and nothing that
   * varies per file. Binding `iterations` and `salt` here is the point — an
   * edited iteration count breaks the unwrap instead of being obeyed. Keeping
   * it file-independent is what lets a scheduled backup reuse one wrap blob
   * without ever holding the passphrase.
   */
  function wrapAad(envelope) {
    return encoder.encode(JSON.stringify({
      format: envelope.format, version: envelope.version, purpose: "key-wrap",
      kdf: { name: envelope.kdf.name, hash: envelope.kdf.hash, iterations: envelope.kdf.iterations, salt: envelope.kdf.salt },
      wrapIv: envelope.wrap.iv
    }));
  }

  /**
   * What the bulk layer authenticates: the whole header including the wrapped
   * key, so a file cannot be recombined from parts of two different backups.
   * `payload` is excluded — it is what the tag already covers.
   */
  function bodyAad(envelope) {
    return encoder.encode(JSON.stringify({
      format: envelope.format, version: envelope.version, createdAt: envelope.createdAt,
      kdf: { name: envelope.kdf.name, hash: envelope.kdf.hash, iterations: envelope.kdf.iterations, salt: envelope.kdf.salt },
      wrap: { name: envelope.wrap.name, iv: envelope.wrap.iv, key: envelope.wrap.key },
      cipher: { name: envelope.cipher.name, iv: envelope.cipher.iv },
      compression: envelope.compression,
      ent: envelope.ent || null
    }));
  }

  async function compress(bytes) {
    if (!("CompressionStream" in self)) return { compression: "none", bytes };
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
    return { compression: "gzip", bytes: new Uint8Array(await new Response(stream).arrayBuffer()) };
  }

  async function decompress(bytes, compression) {
    if (compression === "none") return bytes;
    if (compression !== "gzip") throw new Error("This backup uses an unsupported compression format");
    if (!("DecompressionStream" in self)) throw new Error("This browser cannot read this backup compression format");
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /* ---------- entitlement stamp ---------- */

  /**
   * Proof the sealer held a licence. HMAC over the header under a per-licence
   * secret only the entitlement Worker can derive, so a file sealed from a
   * locked DevTools console cannot carry a valid one — and therefore cannot be
   * restored by any install, including someone else's. That is the point: the
   * bypass stops being distributable.
   *
   * It is NOT a secrecy mechanism. The passphrase alone protects the contents.
   */
  function stampAad(envelope) {
    /* An unprotected file has no KDF and no IVs to bind, and its body is the
       thing worth binding instead — so the digest goes under the same
       signature. `protection` is signed too: without it a stamp could be lifted
       from one kind of file onto the other. */
    if (envelope.protection === PROTECTION_NONE) {
      return encoder.encode(JSON.stringify({
        format: envelope.format, version: envelope.version, createdAt: envelope.createdAt,
        sub: envelope.ent.sub, protection: PROTECTION_NONE, digest: envelope.digest
      }));
    }
    return encoder.encode(JSON.stringify({
      format: envelope.format, version: envelope.version, createdAt: envelope.createdAt,
      sub: envelope.ent.sub,
      kdf: { name: envelope.kdf.name, iterations: envelope.kdf.iterations, salt: envelope.kdf.salt },
      wrapIv: envelope.wrap.iv, cipherIv: envelope.cipher.iv
    }));
  }

  async function signStamp(key, envelope) {
    const mac = await crypto.subtle.sign("HMAC", key, stampAad(envelope));
    return bytesToBase64(new Uint8Array(mac));
  }

  /** True only for a v3 file whose stamp verifies under this install's key. */
  async function verifyStamp(envelope, key) {
    if (!envelope || envelope.version < 3) return true;        // legacy, pre-stamp
    const ent = envelope.ent;
    if (!ent || typeof ent.mac !== "string" || typeof ent.sub !== "string") return false;
    if (!key) return false;
    try {
      return await crypto.subtle.verify("HMAC", key, base64ToBytes(ent.mac), stampAad(envelope));
    } catch { return false; }
  }

  /* ---------- seal ---------- */

  /**
   * @param {object} payload  the snapshot object (chats, ledger, profile)
   * @param {object} secret   `{ passphrase }` — mints a fresh file key, or
   *                          `{ keyring }` — the blob from mintKeyring(), which
   *                          carries an already-wrapped file key so the worker
   *                          can seal a scheduled backup with no passphrase in
   *                          memory. Opening the file still requires it.
   */
  async function seal(payload, secret) {
    if (!payload || payload.format !== PAYLOAD_FORMAT) throw new Error("Refusing to encrypt an unrecognised snapshot");
    const stampKey = secret && secret.stampKey;
    const stampSub = String((secret && secret.stampSub) || "");
    if (!stampKey) throw new Error("Creating a backup is a Pro feature");
    const createdAt = Number(payload.createdAt) || Date.now();
    const packed = await compress(encoder.encode(JSON.stringify(payload)));

    let fileKeyBytes, kdf, wrapIv, wrappedKey = null, kek;
    if (secret && secret.keyring) {
      const keyring = secret.keyring;
      if (!keyring.fileKey || !keyring.wrap || !keyring.wrap.key) throw new Error("Automatic backup is not set up");
      fileKeyBytes = base64ToBytes(keyring.fileKey);
      kdf = keyring.kdf;
      wrapIv = base64ToBytes(keyring.wrap.iv);
      wrappedKey = base64ToBytes(keyring.wrap.key);
    } else {
      const rated = ratePassphrase(secret && secret.passphrase);
      if (!rated.ok) throw new Error(rated.reason);
      fileKeyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
      const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
      // Caller-supplied only upwards: calibrateIterations() can raise this on a
      // fast device, nothing can lower it below the floor every reader enforces.
      const iterations = Math.min(KDF_MAX_ITERATIONS,
        Math.max(KDF_ITERATIONS, Math.floor(Number(secret.iterations) || KDF_ITERATIONS)));
      kdf = { name: "PBKDF2", hash: "SHA-256", iterations, salt: bytesToBase64(salt) };
      wrapIv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    }

    const cipherIv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const envelope = {
      format: FORMAT, version: VERSION, createdAt,
      kdf,
      wrap: { name: "AES-GCM", iv: bytesToBase64(wrapIv), key: "" },
      cipher: { name: "AES-GCM", iv: bytesToBase64(cipherIv) },
      compression: packed.compression,
      ent: { v: 1, sub: stampSub, mac: "" },
      payload: ""
    };
    envelope.ent.mac = await signStamp(stampKey, envelope);

    try {
      if (!wrappedKey) {
        kek = await deriveKek(secret.passphrase, base64ToBytes(kdf.salt), kdf.iterations);
        wrappedKey = new Uint8Array(await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: wrapIv, additionalData: wrapAad(envelope) }, kek, fileKeyBytes));
      }
      envelope.wrap.key = bytesToBase64(wrappedKey);
      const fileKey = await crypto.subtle.importKey("raw", fileKeyBytes, "AES-GCM", false, ["encrypt"]);
      const body = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: cipherIv, additionalData: bodyAad(envelope) }, fileKey, packed.bytes);
      envelope.payload = bytesToBase64(new Uint8Array(body));
      // The keyring is returned so a manual backup can double as auto-backup
      // setup without deriving the KEK a second time.
      const keyring = { version: 1, fileKey: bytesToBase64(fileKeyBytes), kdf, wrap: { ...envelope.wrap } };
      return { envelope, json: JSON.stringify(envelope), keyring };
    } finally {
      wipe(fileKeyBytes);
      wipe(packed.bytes);
    }
  }

  /**
   * The same snapshot with no passphrase, written as readable JSON because that
   * is what the user asked for when they turned protection off. Everything the
   * encrypted path gives up here is secrecy — the file is plaintext and must be
   * kept like the chats themselves. What it keeps is provenance and integrity:
   * the licence stamp signs a digest of the snapshot, so this file still cannot
   * be forged by an unlicensed copy, and cannot be edited without the restore
   * refusing it.
   */
  async function sealPlain(payload, secret) {
    if (!payload || payload.format !== PAYLOAD_FORMAT) throw new Error("Refusing to write an unrecognised snapshot");
    const stampKey = secret && secret.stampKey;
    if (!stampKey) throw new Error("Creating a backup is a Pro feature");
    const envelope = {
      format: FORMAT, version: VERSION, protection: PROTECTION_NONE,
      createdAt: Number(payload.createdAt) || Date.now(),
      warning: "NOT ENCRYPTED. Anyone who opens this file can read every chat in it.",
      digest: await digestOf(payload),
      ent: { v: 1, sub: String((secret && secret.stampSub) || ""), mac: "" },
      snapshot: payload
    };
    envelope.ent.mac = await signStamp(stampKey, envelope);
    // Indented on purpose: this file exists to be opened and read.
    return { envelope, json: JSON.stringify(envelope, null, 2), keyring: null };
  }

  /* ---------- open ---------- */

  function checkEnvelope(envelope) {
    if (!envelope || typeof envelope !== "object" || envelope.format !== FORMAT) {
      throw new Error("This is not a Tvara backup");
    }
    if (![1, 2, 3].includes(envelope.version)) {
      throw new Error("This backup was written by a newer version of the extension");
    }
    if (envelope.protection === PROTECTION_NONE) {
      if (typeof envelope.digest !== "string" || !envelope.digest) {
        throw new Error("This backup is missing its integrity digest");
      }
      if (!envelope.snapshot || typeof envelope.snapshot !== "object") throw new Error("This backup is empty");
      return { protection: PROTECTION_NONE, iterations: 0, salt: new Uint8Array(0) };
    }
    const kdf = envelope.kdf, cipher = envelope.cipher;
    if (!kdf || !cipher || kdf.name !== "PBKDF2" || kdf.hash !== "SHA-256" || cipher.name !== "AES-GCM") {
      throw new Error("This backup uses unsupported encryption");
    }
    if (typeof envelope.payload !== "string" || !envelope.payload) throw new Error("This backup is empty");
    const iterations = Math.floor(Number(kdf.iterations) || 0);
    if (!(iterations >= KDF_MIN_ITERATIONS && iterations <= KDF_MAX_ITERATIONS)) {
      // v1 hardcoded 600k on both sides and some files omit the field.
      if (!(envelope.version === 1 && !kdf.iterations)) {
        throw new Error("This backup declares unsafe encryption settings and will not be opened");
      }
    }
    if (envelope.version >= 2 && (!envelope.wrap || envelope.wrap.name !== "AES-GCM" ||
        typeof envelope.wrap.key !== "string" || typeof envelope.wrap.iv !== "string")) {
      throw new Error("This backup is missing its key envelope");
    }
    return {
      iterations: iterations >= KDF_MIN_ITERATIONS ? iterations : KDF_MIN_ITERATIONS,
      salt: base64ToBytes(kdf.salt)
    };
  }

  /** Parse without decrypting — used to show what a file holds before asking for the passphrase. */
  function inspect(text) {
    if (typeof text !== "string" || text.length > MAX_FILE_BYTES) throw new Error("This file is too large to be a backup");
    let envelope;
    try { envelope = JSON.parse(text); }
    catch { throw new Error("This is not a valid Tvara backup"); }
    checkEnvelope(envelope);
    return { envelope, version: envelope.version, createdAt: Number(envelope.createdAt) || 0,
      protection: envelope.protection === PROTECTION_NONE ? PROTECTION_NONE : PROTECTION_PASSPHRASE };
  }

  async function open(text, passphrase, opts) {
    const { envelope } = inspect(text);
    const { iterations, salt } = checkEnvelope(envelope);
    const unprotected = envelope.protection === PROTECTION_NONE;
    if (!unprotected && !passphrase) throw new Error("Enter the backup passphrase");
    // Checked before any key derivation: an unstamped file is refused without
    // spending a passphrase attempt on it.
    /* More than one key can be right. The trial archive secret was re-keyed
       once, and a file sealed before that verifies only under the old one, so
       every key this install holds is tried before the file is refused.
       Sealing is unaffected — seal() still takes the single current key. */
    const stampKeys = [];
    if (opts && opts.stampKey) stampKeys.push(opts.stampKey);
    if (opts && Array.isArray(opts.stampKeys)) {
      for (const k of opts.stampKeys) if (k && !stampKeys.includes(k)) stampKeys.push(k);
    }
    let stamped = false;
    if (!stampKeys.length) {
      stamped = await verifyStamp(envelope, null);        // legacy files only
    } else {
      for (const key of stampKeys) {
        if (await verifyStamp(envelope, key)) { stamped = true; break; }
      }
    }
    if (!stamped) {
      /* What is true when no key verifies: the file was sealed under an account
         or licence this install does not hold. That is almost always a person
         on the wrong Google account or with no licence activated yet, and
         "not a licensed copy" told them their own backup was a forgery. */
      throw new Error("This backup was made under a different Tvara account or licence. " +
        "Sign in with the Google account, or activate the licence, you used when you made it, then try again.");
    }
    if (unprotected) {
      /* Fails closed like every other path here: a body that no longer matches
         the digest the licence key signed is refused outright, never partially
         imported. */
      if (!sameDigest(await digestOf(envelope.snapshot), envelope.digest)) {
        throw new Error("This backup has been altered and cannot be trusted");
      }
      const snap = envelope.snapshot;
      if (!snap || snap.format !== PAYLOAD_FORMAT || !Array.isArray(snap.chats)) {
        throw new Error("The backup contents are incomplete");
      }
      return snap;
    }

    const kek = await deriveKek(passphrase, salt, iterations);

    let plaintext;
    if (envelope.version === 1) {
      // No key wrapping and no AAD: the passphrase key encrypted the body
      // directly. Accepted for reading only.
      try {
        plaintext = new Uint8Array(await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: base64ToBytes(envelope.cipher.iv) }, kek, base64ToBytes(envelope.payload)));
      } catch { throw new Error("Wrong passphrase, or this backup has been altered"); }
    } else {
      let fileKeyBytes;
      try {
        fileKeyBytes = new Uint8Array(await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: base64ToBytes(envelope.wrap.iv), additionalData: wrapAad(envelope) },
          kek, base64ToBytes(envelope.wrap.key)));
      } catch { throw new Error("Wrong passphrase, or this backup has been altered"); }
      if (fileKeyBytes.length !== KEY_BYTES) { wipe(fileKeyBytes); throw new Error("This backup has been altered"); }
      try {
        const fileKey = await crypto.subtle.importKey("raw", fileKeyBytes, "AES-GCM", false, ["decrypt"]);
        plaintext = new Uint8Array(await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: base64ToBytes(envelope.cipher.iv), additionalData: bodyAad(envelope) },
          fileKey, base64ToBytes(envelope.payload)));
      } catch { throw new Error("This backup has been altered and cannot be trusted"); }
      finally { wipe(fileKeyBytes); }
    }

    let snapshot;
    try { snapshot = JSON.parse(decoder.decode(await decompress(plaintext, envelope.compression))); }
    catch { throw new Error("The encrypted backup could not be read"); }
    finally { wipe(plaintext); }
    if (!snapshot || snapshot.format !== PAYLOAD_FORMAT || !Array.isArray(snapshot.chats)) {
      throw new Error("The backup contents are incomplete");
    }
    return snapshot;
  }

  /**
   * Mint the keyring that unattended backups run on: one random file key,
   * wrapped under the passphrase once, here, while the passphrase is briefly in
   * hand. The wrap AAD is deliberately file-independent, so the same blob seals
   * every later backup without re-deriving anything. The passphrase is never
   * stored and never recoverable — the file still opens only with it.
   *
   * The raw file key does sit in extension-local storage. That is not a
   * downgrade: whatever can read it can read the plaintext IndexedDB archive
   * beside it. It buys scheduled backups at no cost to the file's secrecy
   * anywhere else.
   */
  async function mintKeyring(passphrase) {
    const rated = ratePassphrase(passphrase);
    if (!rated.ok) throw new Error(rated.reason);
    const fileKeyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const wrapIv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const kdf = { name: "PBKDF2", hash: "SHA-256", iterations: KDF_ITERATIONS, salt: bytesToBase64(salt) };
    const draft = { format: FORMAT, version: VERSION, kdf, wrap: { name: "AES-GCM", iv: bytesToBase64(wrapIv) } };
    try {
      const kek = await deriveKek(passphrase, salt, kdf.iterations);
      const wrapped = new Uint8Array(await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: wrapIv, additionalData: wrapAad(draft) }, kek, fileKeyBytes));
      return { version: 1, fileKey: bytesToBase64(fileKeyBytes), kdf,
        wrap: { name: "AES-GCM", iv: draft.wrap.iv, key: bytesToBase64(wrapped) } };
    } finally { wipe(fileKeyBytes); }
  }

  /** Does this blob still look like something seal() can use? */
  function validKeyring(keyring) {
    return !!(keyring && keyring.version === 1 && typeof keyring.fileKey === "string" &&
      keyring.kdf && keyring.kdf.name === "PBKDF2" &&
      Math.floor(Number(keyring.kdf.iterations) || 0) >= KDF_MIN_ITERATIONS &&
      keyring.wrap && typeof keyring.wrap.key === "string" && keyring.wrap.key &&
      typeof keyring.wrap.iv === "string");
  }

  self.LCTBackupCrypto = {
    FORMAT, PAYLOAD_FORMAT, VERSION, KDF_ITERATIONS, KDF_MIN_ITERATIONS, KDF_MAX_ITERATIONS,
    MIN_PASSPHRASE, MAX_FILE_BYTES, PROTECTION_NONE, PROTECTION_PASSPHRASE,
    bytesToBase64, base64ToBytes, ratePassphrase, generatePassphrase, calibrateIterations,
    seal, sealPlain, open, inspect, mintKeyring, validKeyring, wipe,
    verifyStamp, signStamp
  };
})();
