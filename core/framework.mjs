import { Constants, NodeJSSerialConnection } from '@liamcottle/meshcore.js';
import * as utils from '../utils.mjs';
import { SendQueue } from './send-queue.mjs';
import { startWatchdog } from './watchdog.mjs';

// Single seam for creating the transport connection. Serial is all that's
// implemented today; a future TCP/network transport would plug in here
// without touching anything else in the framework.
function createConnection(config) {
  const transportType = config.transport?.type ?? 'serial';

  if (transportType === 'serial') {
    const port = process.argv[2] ?? config.port;
    console.log(`Connecting to ${port}`);
    return new NodeJSSerialConnection(port);
  }

  throw new Error(`Unsupported transport type "${transportType}" - only "serial" is currently implemented`);
}

// MeshCore channel messages embed the sender as a "SenderName: message" prefix
// (confirmed against live traffic, though not documented by the library). Sender
// names may contain emoji and bodies may span multiple lines, hence the /s flag.
// Still parsed defensively - a message without the prefix yields senderName null.
function normalizeChannelMessage(channelMessage, { self, channelsByIdx }) {
  const text = channelMessage.text ?? '';
  const match = text.match(/^(.{1,40}?): (.*)$/s);
  const senderName = match ? match[1] : null;
  const body = match ? match[2] : text;
  const fromSelf = senderName !== null && senderName === self.name;
  const channelInfo = channelsByIdx.get(channelMessage.channelIdx) ?? null;

  return {
    kind: 'channel',
    channel: { channelIdx: channelMessage.channelIdx, name: channelInfo?.name ?? null },
    text,
    senderName,
    body,
    fromSelf,
    raw: channelMessage,
  };
}

class TimeoutError extends Error {}

// Races a promise the library may never settle. The loser keeps running - these
// library calls have no cancel - but with the contact cache below we only ever
// pay for that once per unknown sender.
function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function normalizeDirectMessage(contactMessage, lookupContact) {
  const pubKeyPrefix = contactMessage.pubKeyPrefix;
  const contact = await lookupContact(pubKeyPrefix);

  return {
    kind: 'direct',
    contact,
    senderName: contact?.advName ?? null,
    pubKeyPrefix,
    text: contactMessage.text ?? '',
    raw: contactMessage,
  };
}

function buildCtx(moduleName, { config, self, channelsByName, channelsByIdx, sendQueue, connection, limits }) {
  const log = (...args) => console.log(`[${moduleName}]`, ...args);
  const logError = (...args) => console.error(`[${moduleName}]`, ...args);

  const getChannelByName = (name) => {
    if (!name) return null;
    const c = channelsByName.get(name);
    return c ? { channelIdx: c.channelIdx, name: c.name } : null;
  };

  const getChannelByIdx = (idx) => {
    const c = channelsByIdx.get(idx);
    return c ? { channelIdx: c.channelIdx, name: c.name } : null;
  };

  // Logged before the await, not after: a send that never gets its confirmation
  // frame back from the device is exactly the case worth seeing in the log, and
  // failures are reported separately by the send queue.
  const sendToChannel = async (channelIdx, text) => {
    const truncated = utils.shortenToBytes(text, limits.channelMessageBytes);
    const name = channelsByIdx.get(channelIdx)?.name;
    log(`-> channel ${channelIdx}${name ? ` "${name}"` : ''}: ${truncated}`);
    return sendQueue.enqueueChannel(channelIdx, truncated);
  };

  const sendToContact = async (publicKey, text) => {
    const truncated = utils.shortenToBytes(text, limits.directMessageBytes);
    log(`-> DM ${utils.formatPublicKey(publicKey)}: ${truncated}`);
    return sendQueue.enqueueDirect(publicKey, truncated);
  };

  const registerAlarm = (timeHHMM, cb) => utils.setAlarm(timeHHMM, cb);

  return {
    config,
    moduleConfig: config[moduleName] ?? {},
    self,
    limits,
    log,
    logError,
    utils,
    getChannelByName,
    getChannelByIdx,
    sendToChannel,
    sendToContact,
    registerAlarm,
    connection,
  };
}

export async function startBot(config, modules) {
  const connection = createConnection(config);

  // Start the watchdog before connecting so a hang during the initial
  // connect/handshake is also caught.
  startWatchdog(connection, {
    timeoutMinutes: config.watchdogTimeoutMinutes ?? 360,
    exitCode: 42,
  });

  const limits = {
    channelMessageBytes: config.limits?.channelMessageBytes ?? 155,
    directMessageBytes: config.limits?.directMessageBytes ?? 160,
  };

  const sendQueue = new SendQueue(connection, {
    minGapMs: (config.sendIntervalSeconds ?? 15) * 1000,
    sendTimeoutMs: (config.sendTimeoutSeconds ?? 30) * 1000,
  });

  let activeModules = [...modules];
  const moduleCtx = new Map();

  let initialized = false;
  let self = { name: null, publicKey: null };
  let channelsByName = new Map();
  let channelsByIdx = new Map();

  let draining = false;
  let drainAgain = false;
  let modulesReady = false;

  async function dispatch(hookName, msg) {
    for (const module of activeModules) {
      const hook = module[hookName];
      if (!hook) continue;
      const ctx = moduleCtx.get(module.name);
      if (!ctx) continue; // module not initialized yet (shouldn't normally happen)
      try {
        await hook(msg, ctx);
      } catch (e) {
        console.error(`[framework] module "${module.name}" ${hookName} threw:`, e);
      }
    }
  }

  // connection.getWaitingMessages() loops syncNextMessage(), and that promise
  // has no timeout in the library - it settles only on a message frame or on
  // NoMoreMessages. A frame the library can't parse (e.g. a V3 message frame)
  // therefore hangs the drain forever: `draining` stays true, every later
  // MsgWaiting push is swallowed by the drainAgain flag, and the bot goes
  // silently deaf while the connection still looks healthy to the watchdog.
  // Bound it and exit(42) so the supervisor restarts us instead.
  const drainTimeoutMs = (config.drainTimeoutSeconds ?? 120) * 1000;

  async function fetchWaitingMessages() {
    return withTimeout(connection.getWaitingMessages(), drainTimeoutMs, 'message drain');
  }

  // connection.getChannels() probes slot after slot until one errors, and each
  // of those probes waits forever for its answer - so a single unanswered slot
  // parks startup before any module is initialized, with nothing logged past
  // "self identity". Walk the slots ourselves with a timeout on each, and log
  // what we find and how long it took.
  const channelQueryTimeoutMs = (config.channelQueryTimeoutSeconds ?? 60) * 1000;
  const maxChannelSlots = config.maxChannelSlots ?? 8;

  async function loadChannels() {
    const channels = [];
    const startedAt = Date.now();

    for (let channelIdx = 0; channelIdx < maxChannelSlots; channelIdx++) {
      const slotStartedAt = Date.now();
      let channel;

      try {
        channel = await withTimeout(connection.getChannel(channelIdx), channelQueryTimeoutMs, `channel ${channelIdx}`);
      } catch (e) {
        if (e instanceof TimeoutError) {
          console.error(`WATCHDOG: ${e.message} during startup, exiting for a restart`);
          process.exit(42);
        }
        break; // the device rejects past the last configured slot - that's the end of the list
      }

      const seconds = ((Date.now() - slotStartedAt) / 1000).toFixed(1);
      console.log(`[framework] channel ${channelIdx}: "${channel?.name ?? '(unnamed)'}" (${seconds}s)`);
      if (channel) channels.push(channel);
    }

    console.log(`[framework] ${channels.length} channels in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    return channels;
  }

  // Resolving a sender means connection.getContacts(), which enumerates the
  // whole contact table and - like syncNextMessage - waits forever for its
  // terminating EndOfContacts frame. On this node that call reliably stalls,
  // so it must never sit in the path of an incoming message.
  //
  // Instead the table is mirrored locally: refreshed in the background, kept
  // on disk so a restart starts with names already known, and looked up as a
  // plain map. A miss costs nothing - it just schedules a refresh and reports
  // the sender as unnamed. Replying doesn't need the table at all, only the
  // 6-byte key prefix the message already carries.
  const contactLookupTimeoutMs = (config.contactLookupTimeoutSeconds ?? 15) * 1000;
  const contactsRefreshIntervalMs = (config.contactsRefreshIntervalSeconds ?? 300) * 1000;
  const contactsCacheFile = config.contactsCacheFile ?? './contacts-cache.json';

  // Every abandoned refresh leaves a listener registered inside the library's
  // getContacts(), so on a node that never answers, retrying every 5 minutes
  // forever is a slow leak. Back off exponentially, up to an hour.
  const MAX_CONTACTS_BACKOFF_MS = 60 * 60 * 1000;

  let contactsByPrefix = new Map();
  let contactsRefreshing = false;
  let contactsRefreshedAt = 0;
  let contactsBackoffMs = contactsRefreshIntervalMs;

  function contactRecord(publicKeyHex, advName) {
    return { publicKey: Buffer.from(publicKeyHex, 'hex'), publicKeyHex, advName };
  }

  function loadContactsCache() {
    const cached = utils.loadJson(contactsCacheFile);
    if (!Array.isArray(cached)) return;
    contactsByPrefix = new Map(cached
      .filter(c => typeof c?.publicKey === 'string')
      .map(c => [utils.formatPublicKey(c.publicKey), contactRecord(c.publicKey, c.advName ?? null)]));
    console.log(`[framework] loaded ${contactsByPrefix.size} contacts from ${contactsCacheFile}`);
  }

  async function refreshContacts() {
    if (contactsRefreshing) return;
    contactsRefreshing = true;
    try {
      const contacts = await withTimeout(connection.getContacts(), contactLookupTimeoutMs, 'contact refresh');
      const records = contacts
        .filter(c => c?.publicKey)
        .map(c => contactRecord(Buffer.from(c.publicKey).toString('hex'), c.advName ?? null));
      contactsByPrefix = new Map(records.map(c => [utils.formatPublicKey(c.publicKey), c]));
      utils.saveJson(contactsCacheFile, records.map(c => ({ publicKey: c.publicKeyHex, advName: c.advName })));
      console.log(`[framework] refreshed ${records.length} contacts from the device`);
      contactsBackoffMs = contactsRefreshIntervalMs;
    } catch (e) {
      contactsBackoffMs = Math.min(contactsBackoffMs * 2, MAX_CONTACTS_BACKOFF_MS);
      console.error(`[framework] contact refresh failed: ${e?.message ?? e}`
        + ` (next attempt in at least ${Math.round(contactsBackoffMs / 60000)}min)`);
    } finally {
      contactsRefreshedAt = Date.now();
      contactsRefreshing = false;
    }
  }

  function scheduleContactRefresh() {
    if (Date.now() - contactsRefreshedAt < contactsBackoffMs) return;
    refreshContacts().catch(e => console.error('[framework] contact refresh threw:', e));
  }

  // Never awaits the device - a miss returns null and refreshes in the
  // background, so the message is dispatched immediately either way.
  async function lookupContact(pubKeyPrefix) {
    const key = utils.formatPublicKey(pubKeyPrefix);
    const hit = contactsByPrefix.get(key);
    if (hit) return hit;
    scheduleContactRefresh();
    return null;
  }

  loadContactsCache();

  async function drainOnce() {
    let waitingMessages;
    try {
      waitingMessages = await fetchWaitingMessages();
    } catch (e) {
      if (e instanceof TimeoutError) {
        // Can't just log and carry on: the abandoned getWaitingMessages() loop
        // is still parked on its once() listeners, which would steal frames
        // from any drain we start next. Hand the problem to the supervisor.
        console.error(`WATCHDOG: message drain stalled for ${drainTimeoutMs / 1000}s, exiting for a restart`);
        process.exit(42);
      }
      console.error('[framework] failed to fetch waiting messages:', e?.message ?? e);
      return;
    }

    for (const wrapper of waitingMessages) {
      if (wrapper.contactMessage) {
        console.debug('[framework] raw direct message:', wrapper.contactMessage);
        const msg = await normalizeDirectMessage(wrapper.contactMessage, lookupContact);
        console.log(`[framework] direct message from ${msg.senderName ?? '(unknown contact)'} `
          + `[${utils.formatPublicKey(msg.pubKeyPrefix)}]: ${msg.text}`);
        await dispatch('onDirectMessage', msg);
      } else if (wrapper.channelMessage) {
        console.debug('[framework] raw channel message:', wrapper.channelMessage);
        const msg = normalizeChannelMessage(wrapper.channelMessage, { self, channelsByIdx });
        await dispatch('onChannelMessage', msg);
      }
      // wrapper.channelData (raw telemetry pushes) is intentionally ignored.
    }
  }

  async function drain() {
    // The MsgWaiting handler is live from the moment we connect, but module
    // init runs afterwards and can take minutes on this device (getChannels
    // enumerates the whole table). Draining before then pulls messages off the
    // device and drops them, since dispatch has no ctx to hand them to. Leave
    // them queued - the drain that follows init picks them up.
    if (!modulesReady) return;

    if (draining) {
      drainAgain = true;
      return;
    }
    draining = true;
    try {
      await drainOnce();
    } finally {
      draining = false;
    }
    if (drainAgain) {
      drainAgain = false;
      await drain();
    }
  }

  connection.on('connected', async () => {
    if (initialized) return; // guard against re-fire on reconnect events
    initialized = true;

    const port = process.argv[2] ?? config.port;
    console.log(`Connected to ${port}`);

    try {
      self = await withTimeout(connection.getSelfInfo(), channelQueryTimeoutMs, 'self info query');
    } catch (e) {
      if (e instanceof TimeoutError) {
        console.error(`WATCHDOG: ${e.message} during startup, exiting for a restart`);
        process.exit(42);
      }
      console.error('[framework] getSelfInfo failed:', e?.message ?? e);
    }
    console.log(`[framework] self identity: ${self.name}`);

    const channels = await loadChannels();
    channelsByName = new Map(channels.map(c => [c.name, c]));
    channelsByIdx = new Map(channels.map(c => [c.channelIdx, c]));

    for (const module of [...activeModules]) {
      const ctx = buildCtx(module.name, { config, self, channelsByName, channelsByIdx, sendQueue, connection, limits });
      moduleCtx.set(module.name, ctx);
      try {
        await module.init?.(ctx);
      } catch (e) {
        console.error(`[framework] module "${module.name}" init failed, disabling module:`, e);
        activeModules = activeModules.filter(m => m !== module);
      }
    }

    console.log(`[framework] ready with modules: ${activeModules.map(m => m.name).join(', ') || '(none)'}`);
    modulesReady = true;

    // Not awaited: if the device stalls on this, messages still flow - we just
    // report senders by key prefix until a later refresh succeeds.
    refreshContacts().catch(e => console.error('[framework] initial contact refresh threw:', e));

    // Messages may have queued up on the device while we were offline or
    // still initializing - do one drain pass now instead of waiting for the
    // next MsgWaiting push.
    drain().catch(e => console.error('[framework] initial drain failed:', e));
  });

  connection.on(Constants.PushCodes.MsgWaiting, () => {
    drain().catch(e => console.error('[framework] drain failed:', e));
  });

  await connection.connect();
}
