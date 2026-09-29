## Description
Node.js Bitcoin price bot using meshcore.js and companion-usb. Broadcasts daily BTC/EUR price updates with trend indicators (📈/📉) over MeshCore network.

<!-- jooray-links:start -->
### More from me

**Related projects**

- [MeshCore-BitChat](https://github.com/jooray/MeshCore-BitChat): bridge between MeshCore and BitChat mesh networks
- [roadstr](https://github.com/jooray/roadstr): road-event reporting over Nostr and MeshCore

**Full project showcase:** Part of [MeshCore-Bitchat Bridge](https://juraj.bednar.io/showcase/#RF-01) in my project showcase, or [all my projects](https://juraj.bednar.io/showcase/).

I write about building things on [my blog](https://juraj.bednar.io/en/blog-en/). I also wrote a cypherpunk novel, [Tamers of Entropy](https://tamersofentropy.net/), and there is a [trailer](https://tamersofentropy.net/#trailer).
<!-- jooray-links:end -->

## Features
- Daily Bitcoin price in EUR (CoinGecko API)
- Price trend emoji based on previous day's price
- Optional Fear & Greed Index (Alternative.me API)
- Optional network hashrate (Blockchain.info API)
- Price for EUR and USD loans on Aave, for shorting fiat

## Requirements
- Node.js 22 or higher (LTS recommended)
- MeshCore device with Companion USB firmware connected to computer

## Installation
```sh
git clone https://github.com/jooray/MeshCore-BTC.git
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


```

The bot remembers the previous price in `price-history.json` and shows 📈 if price is up or 📉 if price is down since last update.
