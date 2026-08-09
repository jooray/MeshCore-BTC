import * as utils from '../utils.mjs';

const DEFAULTS = {
  ollamaUrl: 'http://localhost:11434',
  model: 'gemma4:12b-mlx',
  requestTimeoutSeconds: 240,
  historyLength: 6,
  channelHistoryLength: 12,
  maxParts: 3,
  channels: {},
  systemPromptExtra: '',
};

const UNAVAILABLE_MESSAGE = 'AI unavailable right now';
const MAX_PENDING_OLLAMA_CALLS = 5;

// In-memory conversation history, keyed `dm:<pubkeyhex>` / `ch:<channelIdx>`.
// Deliberately not persisted - a restart wipes it (see README).
const history = new Map();

// Promise-chain mutex serializing Ollama calls, with a small pending-backlog
// cap so a burst of messages can't queue up unbounded work.
let chain = Promise.resolve();
let pendingCount = 0;

function serializeOllamaCall(fn) {
  if (pendingCount >= MAX_PENDING_OLLAMA_CALLS) {
    return Promise.reject(new Error('ai: pending backlog full, dropping request'));
  }
  pendingCount++;
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  // .finally() returns a *new* promise that rejects when run rejects, and that
  // one had no handler - so any failed Ollama call (a timeout abort, say) was an
  // unhandled rejection and killed the process. Decrement via then(a, b), which
  // handles both outcomes.
  const done = () => { pendingCount--; };
  run.then(done, done);
  return run;
}

// Byte budget for a reply. prefixLen accounts for the "{i}/{n} " numbering
// prefix added to each part when a reply must be split into multiple
// messages (4 bytes for maxParts <= 9, e.g. "3/3 ").
export function computeBudget(limit, maxParts) {
  const prefixLen = Buffer.byteLength(`${maxParts}/${maxParts} `);
  const partLimit = limit - prefixLen;
  const maxTotal = maxParts * partLimit;
  return { prefixLen, partLimit, maxTotal };
}

export function buildSystemPrompt({ selfName, limit, maxParts, prefixLen, maxTotal, target, systemPromptExtra }) {
  const targetLine = target.kind === 'channel'
    ? `You are replying in the public channel "${target.name}"; incoming messages are prefixed with the sender's name. `
      + `You also see messages that were not addressed to you - treat them as background, and answer only the last message directed at you.`
    : `You are in a private chat with ${target.senderName ?? 'the user'}.`;

  let prompt = `You are ${selfName}, a bot on a slow LoRa mesh radio network. Airtime is extremely scarce and every byte counts.
- Answer in ONE message of at most ${limit} bytes. Prefer plain ASCII: emoji and accented characters cost 2-4 bytes each.
- No greetings, no markdown, no filler. Just the direct answer, extremely concise.
- Answer in the same language the user writes in.
- Only if one message is truly impossible, write up to ${maxParts} short parts; they will be numbered automatically ("1/${maxParts} "), costing ${prefixLen} bytes per part. Never exceed ${maxTotal} bytes total.
${targetLine}`;

  if (systemPromptExtra) {
    prompt += `\n${systemPromptExtra}`;
  }

  return prompt;
}

// Turns a raw model answer into the final list of wire-ready strings to
// send (already numbered if more than one part). Returns how many bytes had
// to be dropped to hard-truncation, if any, so the caller can log it.
export function prepareParts(answer, { limit, maxParts }) {
  const trimmed = answer.trim();

  if (Buffer.byteLength(trimmed, 'utf8') <= limit) {
    return { parts: [trimmed], truncatedBytes: 0 };
  }

  const { partLimit } = computeBudget(limit, maxParts);
  const rawParts = utils.splitToBytes(trimmed, partLimit, maxParts);

  if (rawParts.length <= 1) {
    return { parts: rawParts, truncatedBytes: computeTruncatedBytes(trimmed, rawParts) };
  }

  const numbered = rawParts.map((p, i) => `${i + 1}/${rawParts.length} ${p}`);
  return { parts: numbered, truncatedBytes: computeTruncatedBytes(trimmed, rawParts) };
}

function computeTruncatedBytes(originalTrimmed, parts) {
  const normalizedTotal = Buffer.byteLength(originalTrimmed.replace(/\s+/g, ' ').trim(), 'utf8');
  const kept = parts.reduce((sum, p) => sum + Buffer.byteLength(p, 'utf8'), 0);
  return Math.max(0, normalizedTotal - kept);
}

// How much of a conversation to keep, in entries. A channel keeps more because
// its history also carries messages the bot wasn't addressed in.
export function historyLimits(cfg, kind) {
  const exchanges = kind === 'channel'
    ? (cfg.channelHistoryLength ?? DEFAULTS.channelHistoryLength)
    : (cfg.historyLength ?? DEFAULTS.historyLength);
  return { cap: exchanges * 2, maxLines: exchanges };
}

// Consecutive user turns are folded into one entry so the roles stay strictly
// alternating - Gemma's chat template expects that, and channel chatter would
// otherwise produce long runs of user turns. maxLines bounds how much untagged
// chatter can accumulate between two things the bot actually replied to.
function withUserMessage(hist, userContent, maxLines) {
  const out = hist.map(m => ({ ...m }));
  const last = out[out.length - 1];

  if (last?.role === 'user') {
    last.content = `${last.content}\n${userContent}`.split('\n').slice(-maxLines).join('\n');
  } else {
    out.push({ role: 'user', content: userContent });
  }

  return out;
}

function storeHistory(historyKey, hist, cap) {
  while (hist.length > cap) {
    hist.shift();
  }
  history.set(historyKey, hist);
}

export function buildMessages(systemPrompt, historyKey, userContent, maxLines) {
  const hist = history.get(historyKey) ?? [];
  return [
    { role: 'system', content: systemPrompt },
    ...withUserMessage(hist, userContent, maxLines),
  ];
}

export function appendExchange(historyKey, { cap, maxLines }, userContent, assistantContent) {
  const hist = withUserMessage(history.get(historyKey) ?? [], userContent, maxLines);
  hist.push({ role: 'assistant', content: assistantContent });
  storeHistory(historyKey, hist, cap);
}

// A channel message the bot wasn't addressed in: remembered, not answered, so
// that a later mention is read in the context of what was being discussed.
export function appendPassive(historyKey, { cap, maxLines }, userContent) {
  storeHistory(historyKey, withUserMessage(history.get(historyKey) ?? [], userContent, maxLines), cap);
}

async function callOllama(cfg, messages) {
  const ollamaUrl = cfg.ollamaUrl ?? DEFAULTS.ollamaUrl;
  const model = cfg.model ?? DEFAULTS.model;
  const timeoutMs = (cfg.requestTimeoutSeconds ?? DEFAULTS.requestTimeoutSeconds) * 1000;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, messages }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Ollama HTTP ${res.status}`);
    }

    const json = await res.json();
    const answer = json.message?.content;
    if (!answer || !answer.trim()) {
      throw new Error('Ollama returned an empty reply');
    }

    return answer.trim();
  } finally {
    clearTimeout(timeoutId);
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Strips the first occurrence of selfName (case-insensitive) from text, along
// with the decoration around it: "@bot hi" -> "hi". The MeshCore apps write
// mentions as "@[Name] text" (confirmed live, and the name keeps its emoji),
// so the brackets have to go too or the model is handed a leading "@[ ]".
function stripMention(text, selfName) {
  const re = new RegExp(`@?\\[?${escapeRegExp(selfName)}\\]?@?`, 'i');
  return text.replace(re, ' ').replace(/\s+/g, ' ').trim();
}

async function replyWith(ctx, cfg, { limit, maxParts, historyKey, limits, systemPrompt, userContent, send }) {
  const messages = buildMessages(systemPrompt, historyKey, userContent, limits.maxLines);
  const answer = await serializeOllamaCall(() => callOllama(cfg, messages));

  const { parts, truncatedBytes } = prepareParts(answer, { limit, maxParts });
  if (truncatedBytes > 0) {
    ctx.log(`reply exceeded budget, dropped ${truncatedBytes} bytes to fit ${maxParts} part(s)`);
  }

  for (const part of parts) {
    await send(part);
  }

  appendExchange(historyKey, limits, userContent, answer);
}

async function handleDirect(msg, ctx) {
  const cfg = ctx.moduleConfig;

  // The device only needs the 6-byte key prefix to route a reply, and that
  // prefix comes with the message - so an unresolved contact (full contact
  // storage, or a sender the node has never met) costs us the display name,
  // not the conversation.
  const replyTo = msg.contact?.publicKey ?? msg.pubKeyPrefix;
  if (!replyTo) {
    ctx.log('direct message with no usable public key - skipping');
    return;
  }

  const limit = ctx.limits.directMessageBytes;
  const maxParts = cfg.maxParts ?? DEFAULTS.maxParts;
  const budget = computeBudget(limit, maxParts);
  const historyKey = `dm:${ctx.utils.formatPublicKey(msg.pubKeyPrefix)}`;
  const senderName = msg.senderName ?? msg.contact?.advName ?? null;

  const systemPrompt = buildSystemPrompt({
    selfName: ctx.self.name,
    limit,
    maxParts,
    prefixLen: budget.prefixLen,
    maxTotal: budget.maxTotal,
    target: { kind: 'dm', senderName },
    systemPromptExtra: cfg.systemPromptExtra ?? DEFAULTS.systemPromptExtra,
  });

  try {
    await replyWith(ctx, cfg, {
      limit,
      maxParts,
      historyKey,
      limits: historyLimits(cfg, 'dm'),
      systemPrompt,
      userContent: msg.text,
      send: (part) => ctx.sendToContact(replyTo, part),
    });
  } catch (e) {
    ctx.logError('Ollama call failed for direct message:', e?.message ?? e);
    try {
      await ctx.sendToContact(replyTo, UNAVAILABLE_MESSAGE);
    } catch (sendErr) {
      ctx.logError('failed to send "unavailable" notice:', sendErr?.message ?? sendErr);
    }
  }
}

async function handleChannel(msg, ctx) {
  const cfg = ctx.moduleConfig;
  const channels = cfg.channels ?? DEFAULTS.channels;
  const channelName = msg.channel.name;
  const mode = channelName ? channels[channelName] : undefined;

  if (!mode) return; // unlisted/unknown channel
  if (msg.fromSelf) return;
  if (mode !== 'mention' && mode !== 'all') return; // unrecognized mode

  const historyKey = `ch:${msg.channel.channelIdx}`;
  const limits = historyLimits(cfg, 'channel');
  const withSender = (text) => (msg.senderName ? `${msg.senderName}: ${text}` : text);

  let effectiveText = msg.body;

  if (mode === 'mention') {
    const selfName = ctx.self.name;
    if (!selfName) return; // can't match a mention against an unknown name
    if (effectiveText.toLowerCase().indexOf(selfName.toLowerCase()) === -1) {
      // Not addressed to us: remember it, don't answer it. The next mention is
      // then read in the context of what the channel was actually discussing.
      if (effectiveText.trim()) {
        appendPassive(historyKey, limits, withSender(effectiveText));
      }
      return;
    }
    effectiveText = stripMention(effectiveText, selfName);
  }

  if (!effectiveText || !effectiveText.trim()) return;

  const limit = ctx.limits.channelMessageBytes;
  const maxParts = cfg.maxParts ?? DEFAULTS.maxParts;
  const budget = computeBudget(limit, maxParts);

  const systemPrompt = buildSystemPrompt({
    selfName: ctx.self.name,
    limit,
    maxParts,
    prefixLen: budget.prefixLen,
    maxTotal: budget.maxTotal,
    target: { kind: 'channel', name: channelName },
    systemPromptExtra: cfg.systemPromptExtra ?? DEFAULTS.systemPromptExtra,
  });

  try {
    await replyWith(ctx, cfg, {
      limit,
      maxParts,
      historyKey,
      limits,
      systemPrompt,
      userContent: withSender(effectiveText),
      send: (part) => ctx.sendToChannel(msg.channel.channelIdx, part),
    });
  } catch (e) {
    // Channel failures are silent (no error message posted to the channel),
    // logged only - per spec, to avoid spamming shared airtime.
    ctx.logError('Ollama call failed for channel message:', e?.message ?? e);
  }
}

export default {
  name: 'ai',

  async init(ctx) {
    const cfg = ctx.moduleConfig;
    ctx.log(`ready (model=${cfg.model ?? DEFAULTS.model}, ollama=${cfg.ollamaUrl ?? DEFAULTS.ollamaUrl})`);
  },

  onDirectMessage: handleDirect,
  onChannelMessage: handleChannel,
};
