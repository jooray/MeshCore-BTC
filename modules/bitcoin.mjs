import { ethers } from 'ethers';
import * as utils from '../utils.mjs';

const AAVE_POOL_ABI = [
  'function getReserveData(address asset) view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt)'
];

const TOKEN_ADDRESSES = {
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  EURC: '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c'
};

// Module-local state, populated by init().
let ctx = null;
let channel = null;
let cfg = null;
let priceHistory = null;

async function getBitcoinPrice() {
  try {
    const res = await utils.fetchWithRetry('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur&include_24hr_change=true');
    const data = await res.json();
    return {
      price: data.bitcoin.eur,
      change24h: data.bitcoin.eur_24h_change
    };
  } catch (e) {
    ctx.logError('Failed to fetch Bitcoin price after retries:', e.message);
    return null;
  }
}

async function getFearGreedIndex() {
  try {
    const res = await utils.fetchWithRetry('https://api.alternative.me/fng/?limit=1');
    const data = await res.json();
    return {
      value: parseInt(data.data[0].value),
      classification: data.data[0].value_classification
    };
  } catch (e) {
    ctx.logError('Failed to fetch Fear & Greed Index after retries:', e.message);
    return null;
  }
}

async function getHashrate() {
  try {
    const res = await utils.fetchWithRetry('https://blockchain.info/q/hashrate');
    const text = await res.text();
    return parseInt(text);
  } catch (e) {
    ctx.logError('Failed to fetch hashrate after retries:', e.message);
    return null;
  }
}

async function getBorrowRates() {
  const rpcUrls = ctx.config.ethereum?.rpcUrls || [];
  const poolAddress = ctx.config.ethereum?.aavePoolAddress;

  if (!poolAddress || rpcUrls.length === 0) {
    ctx.logError('Ethereum RPC or Aave pool address not configured');
    return null;
  }

  for (const rpcUrl of rpcUrls) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const poolContract = new ethers.Contract(poolAddress, AAVE_POOL_ABI, provider);

        const [eurcData, usdcData] = await Promise.all([
          poolContract.getReserveData(TOKEN_ADDRESSES.EURC),
          poolContract.getReserveData(TOKEN_ADDRESSES.USDC)
        ]);

        // Convert from RAY (10^27) to percentage with decimal precision
        const RAY = 1e27;
        const eurcRate = Number(eurcData.currentVariableBorrowRate) * 100 / RAY;
        const usdcRate = Number(usdcData.currentVariableBorrowRate) * 100 / RAY;

        return { eurc: eurcRate, usdc: usdcRate };
      } catch (e) {
        ctx.logError(`Attempt ${attempt}/3 failed for ${rpcUrl}: ${e.message}`);
        if (attempt < 3) {
          const delay = 10000 * Math.pow(2, attempt - 1);
          const jitter = delay * 0.2 * Math.random();
          ctx.log(`Retrying in ${Math.round((delay + jitter) / 1000)}s...`);
          await utils.sleep(delay + jitter);
        }
      }
    }
    ctx.logError(`All retries failed for ${rpcUrl}, trying next RPC...`);
  }

  ctx.logError('All RPC endpoints failed for borrow rates after retries');
  return null;
}

async function sendUpdate() {
  const priceData = await getBitcoinPrice();
  if (!priceData) {
    ctx.logError('Bitcoin update failed: could not fetch price after retries');
    return;
  }

  let trendEmoji = '';
  if (priceHistory.lastPrice !== null) {
    trendEmoji = priceData.price > priceHistory.lastPrice ? '📈' : '📉';
  }

  let parts = [`${trendEmoji}BTC: ${utils.formatPrice(priceData.price)}€`];

  if (cfg.showFearGreed) {
    const fng = await getFearGreedIndex();
    if (fng) {
      const fngEmoji = fng.value >= 50 ? '🤑' : '😨';
      parts.push(`${fngEmoji}${fng.value}`);
    } else {
      ctx.log('Fear & Greed unavailable after retries');
    }
  }

  if (cfg.showHashrate) {
    const hashrate = await getHashrate();
    if (hashrate) {
      parts.push(`⛏${utils.formatHashrate(hashrate)}`);
    } else {
      ctx.log('Hashrate unavailable after retries');
    }
  }

  if (cfg.showBorrowRates) {
    const rates = await getBorrowRates();
    if (rates) {
      parts.push(`💸€${utils.formatBorrowRate(rates.eurc)} $${utils.formatBorrowRate(rates.usdc)}`);
    } else {
      ctx.log('Borrow rates unavailable after retries');
    }
  }

  const message = parts.join(' ');
  await ctx.sendToChannel(channel.channelIdx, message); // logs the send itself

  // Save current price for next comparison
  priceHistory.lastPrice = priceData.price;
  priceHistory.lastUpdate = new Date().toISOString();
  utils.saveJson(cfg.priceFile, priceHistory);
}

export default {
  name: 'bitcoin',

  async init(moduleCtx) {
    ctx = moduleCtx;
    cfg = ctx.moduleConfig;

    // Legacy config keys (`channels.bitcoin` / `bitcoinAlarm`) keep working
    // as fallbacks for anyone who hasn't migrated their config.json yet.
    const channelName = cfg.channel ?? ctx.config.channels?.bitcoin;
    channel = ctx.getChannelByName(channelName);
    if (!channel) {
      ctx.logError(`Channel "${channelName}" not found - bitcoin module disabled`);
      throw new Error(`bitcoin: channel "${channelName}" not found`);
    }

    const alarm = cfg.alarm ?? ctx.config.bitcoinAlarm;

    priceHistory = utils.loadJson(cfg.priceFile) || { lastPrice: null, lastUpdate: null };
    ctx.log('Loaded price history:', priceHistory);

    ctx.registerAlarm(alarm, sendUpdate);
    ctx.log(`ready, will broadcast to "${channel.name}" at ${alarm}`);
  },
};
