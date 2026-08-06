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

async function normalizeDirectMessage(contactMessage, connection) {
  const pubKeyPrefix = contactMessage.pubKeyPrefix;
  let contact = null;
  try {
    contact = (await connection.findContactByPublicKeyPrefix(pubKeyPrefix)) ?? null;
  } catch (e) {
    console.error('[framework] findContactByPublicKeyPrefix failed:', e?.message ?? e);
  }

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

  const sendToChannel = async (channelIdx, text) => {
    const truncated = utils.shortenToBytes(text, limits.channelMessageBytes);
    const result = await sendQueue.enqueueChannel(channelIdx, truncated);
    const name = channelsByIdx.get(channelIdx)?.name;
    log(`sent to channel ${channelIdx}${name ? ` "${name}"` : ''}: ${truncated}`);
    return result;
  };

  const sendToContact = async (publicKey, text) => {
    const truncated = utils.shortenToBytes(text, limits.directMessageBytes);
    const result = await sendQueue.enqueueDirect(publicKey, truncated);
    log(`sent DM to ${utils.formatPublicKey(publicKey)}: ${truncated}`);
    return result;
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
  });

  let activeModules = [...modules];
  const moduleCtx = new Map();

  let initialized = false;
  let self = { name: null, publicKey: null };
  let channelsByName = new Map();
  let channelsByIdx = new Map();

  let draining = false;
  let drainAgain = false;

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
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), drainTimeoutMs);
    });
    try {
      return await Promise.race([connection.getWaitingMessages(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function drainOnce() {
    let waitingMessages;
    try {
      waitingMessages = await fetchWaitingMessages();
    } catch (e) {
      if (e?.message === 'timeout') {
        console.error(`WATCHDOG: message drain stalled for ${drainTimeoutMs / 1000}s, exiting for a restart`);
        process.exit(42);
      }
      console.error('[framework] failed to fetch waiting messages:', e?.message ?? e);
      return;
    }

    for (const wrapper of waitingMessages) {
      if (wrapper.contactMessage) {
        console.debug('[framework] raw direct message:', wrapper.contactMessage);
        const msg = await normalizeDirectMessage(wrapper.contactMessage, connection);
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
      self = await connection.getSelfInfo();
    } catch (e) {
      console.error('[framework] getSelfInfo failed:', e?.message ?? e);
    }
    console.log(`[framework] self identity: ${self.name}`);

    try {
      const channels = await connection.getChannels();
      channelsByName = new Map(channels.map(c => [c.name, c]));
      channelsByIdx = new Map(channels.map(c => [c.channelIdx, c]));
    } catch (e) {
      console.error('[framework] getChannels failed:', e?.message ?? e);
    }

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
