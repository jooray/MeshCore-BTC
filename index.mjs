import { Constants, NodeJSSerialConnection } from "@liamcottle/meshcore.js";
import { ethers } from 'ethers';
import * as utils from './utils.mjs';
import config from './config.json' with { type: 'json' };

const AAVE_POOL_ABI = [
  'function getReserveData(address asset) view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt)'
];

const TOKEN_ADDRESSES = {
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  EURC: '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c'
};

const port = process.argv[2] ?? config.port;

const channels = {
  bitcoin: null
};

let priceHistory = null;

console.log(`Connecting to ${port}`);
const connection = new NodeJSSerialConnection(port);

connection.on('connected', async () => {
  console.log(`Connected to ${port}`);

  for (const [channelType, channel] of Object.entries(config.channels)) {
    channels[channelType] = await connection.findChannelByName(channel);
    if (!channels[channelType]) {
      console.log(`Channel ${channelType}: "${channel}" not found!`);
      connection.close();
      return;
    }
  }

  // Load previous price from file
  priceHistory = utils.loadJson(config.bitcoin.priceFile) || { lastPrice: null, lastUpdate: null };
  console.log('Loaded price history:', priceHistory);

  utils.setAlarm(config.bitcoinAlarm, sendBitcoinUpdate);

  console.log('bitcoinBot ready.');
});

connection.on(Constants.PushCodes.MsgWaiting, async () => {
  try {
    const waitingMessages = await connection.getWaitingMessages();
    for (const message of waitingMessages) {
      if (message.contactMessage) {
        console.log('Received contact message', message.contactMessage);
      } else if (message.channelMessage) {
        console.log('Received channel message', message.channelMessage);
      }
    }
  } catch (e) {
    console.log(e);
  }
});

async function getBitcoinPrice() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur&include_24hr_change=true');
    const data = await res.json();
    return {
      price: data.bitcoin.eur,
      change24h: data.bitcoin.eur_24h_change
    };
  } catch (e) {
    console.error('Failed to fetch Bitcoin price:', e);
    return null;
  }
}

async function getFearGreedIndex() {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1');
    const data = await res.json();
    return {
      value: parseInt(data.data[0].value),
      classification: data.data[0].value_classification
    };
  } catch (e) {
    console.error('Failed to fetch Fear & Greed Index:', e);
    return null;
  }
}

async function getHashrate() {
  try {
    const res = await fetch('https://blockchain.info/q/hashrate');
    const text = await res.text();
    return parseInt(text);
  } catch (e) {
    console.error('Failed to fetch hashrate:', e);
    return null;
  }
}

async function getBorrowRates() {
  const rpcUrls = config.ethereum?.rpcUrls || [];
  const poolAddress = config.ethereum?.aavePoolAddress;

  if (!poolAddress || rpcUrls.length === 0) {
    console.error('Ethereum RPC or Aave pool address not configured');
    return null;
  }

  for (const rpcUrl of rpcUrls) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
      const poolContract = new ethers.Contract(poolAddress, AAVE_POOL_ABI, provider);

      const [eurcData, usdcData] = await Promise.all([
        poolContract.getReserveData(TOKEN_ADDRESSES.EURC),
        poolContract.getReserveData(TOKEN_ADDRESSES.USDC)
      ]);

      // Convert from RAY (10^27) to percentage with decimal precision
      const RAY = 1e27;
      const eurcRate = Number(eurcData.currentVariableBorrowRate.toBigInt()) * 100 / RAY;
      const usdcRate = Number(usdcData.currentVariableBorrowRate.toBigInt()) * 100 / RAY;

      return { eurc: eurcRate, usdc: usdcRate };
    } catch (e) {
      console.error(`Failed to fetch borrow rates from ${rpcUrl}:`, e.message);
    }
  }

  console.error('All RPC endpoints failed for borrow rates');
  return null;
}

async function sendBitcoinUpdate() {
  const priceData = await getBitcoinPrice();
  if (!priceData) return;

  let trendEmoji = '';
  if (priceHistory.lastPrice !== null) {
    trendEmoji = priceData.price > priceHistory.lastPrice ? '📈' : '📉';
  }

  let parts = [`${trendEmoji}BTC: ${utils.formatPrice(priceData.price)}€`];

  if (config.bitcoin.showFearGreed) {
    const fng = await getFearGreedIndex();
    if (fng) {
      const fngEmoji = fng.value >= 50 ? '🤑' : '😨';
      parts.push(`${fngEmoji}${fng.value}`);
    }
  }

  if (config.bitcoin.showHashrate) {
    const hashrate = await getHashrate();
    if (hashrate) {
      parts.push(`⛏${utils.formatHashrate(hashrate)}`);
    }
  }

  if (config.bitcoin.showBorrowRates) {
    const rates = await getBorrowRates();
    if (rates) {
      parts.push(`💸€${utils.formatBorrowRate(rates.eurc)} $${utils.formatBorrowRate(rates.usdc)}`);
    }
  }

  const message = parts.join(' ');
  await sendAlert(message, channels.bitcoin);

  // Save current price for next comparison
  priceHistory.lastPrice = priceData.price;
  priceHistory.lastUpdate = new Date().toISOString();
  utils.saveJson(config.bitcoin.priceFile, priceHistory);
}

async function sendAlert(message, channel) {
  await connection.sendChannelTextMessage(
    channel.channelIdx,
    utils.shortenToBytes(message, 155)
  );
  console.log(`Sent out [${channel.name}]: ${message}`);
  await utils.sleep(30 * 1000);
}

await connection.connect();
