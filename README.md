## Description
Node.js Bitcoin price bot using meshcore.js and companion-usb. Broadcasts daily BTC/EUR price updates with trend indicators (📈/📉) over LoRaWAN mesh network.

## Features
- Daily Bitcoin price in EUR (CoinGecko API)
- Price trend emoji based on previous day's price
- Optional Fear & Greed Index (Alternative.me API)
- Optional network hashrate (Blockchain.info API)

## Requirements
- Node.js 22 or higher (LTS recommended)
- MeshCore device with Companion USB firmware connected to computer

## Installation
```sh
git clone https://github.com/recrof/MeshCore-BTC.git
cd MeshCore-BTC
npm install
```

## Usage
1. Connect MeshCore companion USB to your computer
2. Edit `config.json`:
```json
{
  "port": "/dev/ttyACM0",
  "bitcoinAlarm": "6:00",
  "channels": {
    "bitcoin": "Public"
  },
  "bitcoin": {
    "priceFile": "./price-history.json",
    "showFearGreed": true,
    "showHashrate": true
  }
}
```
3. Run:
```
node index.mjs
```

## Message Format
```
📈 BTC: 94 500 EUR
Fear/Greed: 73 (Greed)
Hashrate: 850 EH/s
```

The bot remembers the previous price in `price-history.json` and shows 📈 if price is up or 📉 if price is down since last update.
