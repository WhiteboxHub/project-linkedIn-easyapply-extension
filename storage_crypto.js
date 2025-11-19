// storage_crypto.js
const _sc_encoder = new TextEncoder();
const _sc_decoder = new TextDecoder();

async function _sc_deriveKey(passphrase, salt) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    _sc_encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptCredentials(plaintext, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await _sc_deriveKey(passphrase, salt);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, _sc_encoder.encode(plaintext));
  // pack: salt(16) + iv(12) + cipher
  const result = new Uint8Array(16 + 12 + cipher.byteLength);
  result.set(salt, 0);
  result.set(iv, 16);
  result.set(new Uint8Array(cipher), 28);
  return result.buffer;
}

// decryptCredentials takes base64 string which was created from encryptCredentials result
async function decryptCredentials(base64Str, passphrase) {
  const raw = _sc_base64ToArrayBuffer(base64Str);
  const data = new Uint8Array(raw);
  const salt = data.slice(0, 16);
  const iv = data.slice(16, 28);
  const cipher = data.slice(28);
  const key = await _sc_deriveKey(passphrase, salt);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return _sc_decoder.decode(plainBuf);
}

function _sc_arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function _sc_base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// expose helpers (global)
self.encryptCredentials = encryptCredentials;
self.decryptCredentials = decryptCredentials;
self._sc_arrayBufferToBase64 = _sc_arrayBufferToBase64;
self._sc_base64ToArrayBuffer = _sc_base64ToArrayBuffer;
