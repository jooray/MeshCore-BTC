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

export function shortenToBytes(str, maxBytes) {
  if (typeof str !== 'string' || typeof maxBytes !== 'number' || maxBytes < 0) {
    return '';
  }

  const encoder = new TextEncoder();
  const encoded = encoder.encode(str);

  if (encoded.length <= maxBytes) {
    return str;
  }

  const decoder = new TextDecoder('utf-8');
  const truncatedBytes = encoded.slice(0, maxBytes);

  let truncatedString = decoder.decode(truncatedBytes, { stream: true });

  while (encoder.encode(truncatedString).length > maxBytes) {
    truncatedString = truncatedString.slice(0, -1);
  }

  const match = truncatedString.match(/^(.*)\s/s);

  if (match && match[1]) {
    return match[1];
  } else {
    return '';
  }
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
