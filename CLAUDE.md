# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MeshCore-BTC is a Node.js Bitcoin price bot that runs on a MeshCore LoRaWAN device. It broadcasts daily Bitcoin price updates with trend indicators over a mesh network.

**Data Sources:**
- **CoinGecko API** - Bitcoin price in EUR (`api.coingecko.com`)
- **Alternative.me API** - Fear & Greed Index (optional)
- **Blockchain.info API** - Network hashrate (optional)

**Output:** Messages sent through MeshCore device channels over LoRaWAN mesh network with emoji indicators (📈/📉) showing price trend since previous update.

## Commands

```bash
# Install dependencies
npm install

# Run the bot directly (uses port from config.json)
node index.mjs

# Run with custom serial port
node index.mjs /dev/ttyACM0

# Run under the auto-restart supervisor (recommended for production)
./run.sh
```

**Requirements:** Node.js 22+ (LTS), MeshCore device with Companion USB firmware

## Architecture

```
index.mjs          Main entry point - serial connection, API fetching, message sending
utils.mjs          Utility functions (price formatting, file persistence, scheduling)
run.sh              Supervisor loop - restarts index.mjs whenever it exits (crash or watchdog)
config.json        Configuration (port, channel, alarm time, optional features)
price-history.json Auto-generated file storing last price for trend comparison
```

**Key Data Flow:**
1. Serial connection to MeshCore device → finds configured channel
2. Daily alarm triggers `sendBitcoinUpdate()`
3. Fetches price from CoinGecko, optionally Fear/Greed and hashrate
4. Compares with previous price to determine emoji
5. Sends formatted message, saves new price to file

**Important Functions:**
- `getBitcoinPrice()` - Fetches EUR price from CoinGecko API
- `getFearGreedIndex()` - Fetches sentiment index from Alternative.me
- `getHashrate()` - Fetches network hashrate from Blockchain.info
- `sendBitcoinUpdate()` - Orchestrates data fetching and message formatting
- `sendAlert()` - Sends message via MeshCore with 30-second rate limiting

**Price Persistence:**
- `utils.loadJson()` / `utils.saveJson()` - Read/write price history to file
- Survives bot restarts to maintain accurate trend indicators

**Watchdog / Auto-Restart:**
The MeshCore serial link can go silent without throwing an error (device hang, USB glitch). `index.mjs` tracks the timestamp of the last event emitted by the `connection` object (any push/response code, not just channel messages) via a wrapper around `connection.emit`. A 60-second timer checks the idle time; once it exceeds `config.watchdogTimeoutMinutes` (default 360 = 6h), the process logs a `WATCHDOG:` message and calls `process.exit(42)`.

Exit code `42` has no special meaning to Node itself — it's just how `index.mjs` communicates "I gave up, please restart me" to whatever is supervising it. `run.sh` is that supervisor: it loops forever, restarting `node index.mjs` after any exit (watchdog-triggered or otherwise) with a 10s delay, logging the exit code and timestamp each time. Run the bot via `./run.sh` in production instead of calling `node index.mjs` directly.

## Configuration

```json
{
  "port": "/dev/ttyACM0",
  "bitcoinAlarm": "6:00",
  "channels": { "bitcoin": "Public" },
  "bitcoin": {
    "priceFile": "./price-history.json",
    "showFearGreed": true,
    "showHashrate": true
  },
  "watchdogTimeoutMinutes": 360
}
```

`watchdogTimeoutMinutes` is optional (default 360). See Watchdog / Auto-Restart above.

## Message Format

```
📈 BTC: 94 500 EUR
Fear/Greed: 73 (Greed)
Hashrate: 850 EH/s
```
