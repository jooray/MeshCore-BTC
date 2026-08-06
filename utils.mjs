import { readFileSync, writeFileSync, existsSync } from 'fs';

export function loadJson(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const data = readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    console.error('Failed to load JSON:', e);
    return null;
  }
}

export function saveJson(filePath, data) {
  try {
    writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.error('Failed to save JSON:', e);
    return false;
  }
}

export function formatPrice(price) {
  return Math.round(price).toLocaleString('en-US').replace(/,/g, ' ');
}

export function formatHashrate(ghPerSec) {
  const ehPerSec = ghPerSec / 1e9;
  return `${ehPerSec.toFixed(0)} EH/s`;
}

// Hard-truncates a string to fit within maxBytes, cutting at a valid UTF-8
// character boundary (never splitting a multi-byte character). Does not
// try to break at whitespace - callers that want a word boundary should
// post-process the result.
function hardCutToBytes(str, maxBytes) {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(str);

  if (encoded.length <= maxBytes) {
    return str;
  }

  const decoder = new TextDecoder('utf-8');
  const truncatedBytes = encoded.slice(0, maxBytes);

  // stream:true means a dangling incomplete byte sequence at the end of the
  // slice is buffered internally (and simply dropped, since we never call
  // decode again) instead of being emitted as replacement characters. This
  // is what guarantees we land on a character boundary.
  let truncatedString = decoder.decode(truncatedBytes, { stream: true });

  while (encoder.encode(truncatedString).length > maxBytes) {
    truncatedString = truncatedString.slice(0, -1);
  }

  return truncatedString;
}

export function shortenToBytes(str, maxBytes) {
  if (typeof str !== 'string' || typeof maxBytes !== 'number' || maxBytes < 0) {
    return '';
  }

  const encoder = new TextEncoder();
  if (encoder.encode(str).length <= maxBytes) {
    return str;
  }

  const truncatedString = hardCutToBytes(str, maxBytes);
  const match = truncatedString.match(/^(.*)\s/s);

  if (match && match[1]) {
    return match[1];
  }

  // No whitespace within the byte budget (e.g. a single long token, or the
  // only whitespace found is a leading one) - fall back to a hard cut at
  // the last valid UTF-8 character boundary instead of returning ''.
  return truncatedString;
}

// Splits str into at most maxParts chunks, each no more than maxBytes bytes
// (UTF-8), preferring to break at whitespace. Whitespace/newlines are first
// collapsed to single spaces. If the content still doesn't fit after
// maxParts chunks, the final chunk is hard-truncated to fit - callers that
// care about data loss should compare byte lengths before/after to detect
// this and log it themselves. Never returns empty-string parts.
export function splitToBytes(str, maxBytes, maxParts = 3) {
  if (typeof str !== 'string' || typeof maxBytes !== 'number' || maxBytes <= 0 || maxParts < 1) {
    return [];
  }

  const encoder = new TextEncoder();
  const normalized = str.replace(/\s+/g, ' ').trim();

  if (normalized.length === 0) {
    return [];
  }

  if (encoder.encode(normalized).length <= maxBytes) {
    return [normalized];
  }

  const parts = [];
  let remaining = normalized;

  while (remaining.length > 0 && parts.length < maxParts) {
    const isFinalAllowedPart = parts.length === maxParts - 1;

    if (encoder.encode(remaining).length <= maxBytes) {
      parts.push(remaining);
      remaining = '';
      break;
    }

    if (isFinalAllowedPart) {
      // This is the last part we're allowed to emit: hard-truncate to fit,
      // dropping whatever's left over. Content loss is expected/OK here.
      const cut = hardCutToBytes(remaining, maxBytes);
      if (cut.length > 0) parts.push(cut);
      remaining = '';
      break;
    }

    // Not the final part yet - prefer breaking at whitespace so we don't
    // chop a word in half.
    const hardCut = hardCutToBytes(remaining, maxBytes);
    const match = hardCut.match(/^(.*)\s/s);

    let chunk;
    let consumedChars;
    if (match && match[1]) {
      chunk = match[1];
      consumedChars = match[0].length; // includes the trailing whitespace
    } else {
      // A single token exceeds maxBytes on its own - hard-cut it.
      chunk = hardCut;
      consumedChars = hardCut.length;
    }

    if (chunk.length === 0) {
      // Defensive: avoid an infinite loop if maxBytes is too small to hold
      // even a single character. Shouldn't happen with realistic budgets.
      break;
    }

    parts.push(chunk);
    remaining = remaining.slice(consumedChars).trimStart();
  }

  return parts.filter(p => p.length > 0);
}

export function sleep(milis) {
  return new Promise(resolve => setTimeout(resolve, milis));
}

export async function fetchWithRetry(url, options = {}) {
  const {
    maxRetries = 3,
    initialDelayMs = 10000,
    maxDelayMs = 120000,
    timeoutMs = 30000,
  } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response;
    } catch (error) {
      console.error(`Attempt ${attempt}/${maxRetries} failed for ${url}: ${error.message}`);

      if (attempt === maxRetries) {
        throw error;
      }

      const delay = Math.min(initialDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      const jitter = delay * 0.2 * Math.random();
      console.log(`Retrying in ${Math.round((delay + jitter) / 1000)}s...`);
      await sleep(delay + jitter);
    }
  }
}

export function setAlarm(time, callback) {
  const [hours, minutes] = time.split(':');

  const seenAlarms = {};
  setInterval(() => {
    const date = new Date();
    const currentDate = date.toISOString().split('T')[0];
    if (!(date.getHours() == hours && date.getMinutes() == minutes && !seenAlarms[currentDate])) return;
    console.debug('alarm triggered', date);
    seenAlarms[currentDate] = 1;
    callback(date);
  }, 30 * 1000);
}

export function formatBorrowRate(rate) {
  return rate.toFixed(1) + '%';
}

// Short hex form of a public key (or key prefix) for log lines - accepts the
// Uint8Array/Buffer the library hands us, or an already-hex string.
export function formatPublicKey(publicKey, bytes = 6) {
  if (!publicKey) return '(unknown)';
  if (typeof publicKey === 'string') return publicKey.slice(0, bytes * 2);
  return Buffer.from(publicKey).subarray(0, bytes).toString('hex');
}
