import { Constants } from '@liamcottle/meshcore.js';

const MAX_QUEUE_LENGTH = 20;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Global FIFO send queue shared by every module's ctx.sendToChannel /
// ctx.sendToContact. The MeshCore radio has very limited airtime, so all
// outgoing messages - regardless of which module produced them - are paced
// through a single worker with a minimum gap between transmissions.
export class SendQueue {
  constructor(connection, { minGapMs = 15000, sendTimeoutMs = 30000 } = {}) {
    this.connection = connection;
    this.minGapMs = minGapMs;
    this.sendTimeoutMs = sendTimeoutMs;
    this.jobs = [];
    this.lastSendAt = 0;
    this.workerRunning = false;
  }

  enqueueChannel(channelIdx, text) {
    return this._enqueue(() => this.connection.sendChannelTextMessage(channelIdx, text));
  }

  enqueueDirect(publicKey, text) {
    return this._enqueue(() => this.connection.sendTextMessage(publicKey, text, Constants.TxtTypes.Plain));
  }

  _enqueue(run) {
    if (this.jobs.length >= MAX_QUEUE_LENGTH) {
      console.error(`[send-queue] queue full (${MAX_QUEUE_LENGTH} jobs pending), dropping message`);
      return Promise.reject(new Error('send queue full'));
    }

    return new Promise((resolve, reject) => {
      this.jobs.push({ run, resolve, reject });
      this._ensureWorker();
    });
  }

  _ensureWorker() {
    if (this.workerRunning) return;
    this.workerRunning = true;
    this._runWorker();
  }

  // connection.sendTextMessage() / sendChannelTextMessage() resolve only when
  // the device answers with Sent or Err - neither has a timeout in the library.
  // A missing answer would otherwise park this worker forever and take every
  // later message from every module down with it, silently. The abandoned
  // promise may still settle later; it just resolves into nothing.
  _runWithTimeout(run) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no send confirmation from the device after ${this.sendTimeoutMs / 1000}s`)),
        this.sendTimeoutMs,
      );
    });
    return Promise.race([run(), timeout]).finally(() => clearTimeout(timer));
  }

  async _runWorker() {
    while (this.jobs.length > 0) {
      const job = this.jobs.shift();

      const wait = this.lastSendAt + this.minGapMs - Date.now();
      if (wait > 0) {
        await sleep(wait);
      }

      try {
        await this._runWithTimeout(job.run);
        this.lastSendAt = Date.now();
        job.resolve();
      } catch (e) {
        this.lastSendAt = Date.now();
        console.error('[send-queue] send failed:', e?.message ?? e);
        job.reject(e);
      }
    }
    this.workerRunning = false;
  }
}
