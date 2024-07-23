const express = require('express');
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getAssociatedTokenAddress, getAssociatedTokenAddressSync } = require('@solana/spl-token');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const port = 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Set up EJS
app.set('view engine', 'ejs');
app.set('views', './views');

// Solana connection using environment variable
const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');

// $PRINT token address and TOKEN_PROGRAM_ID from environment variables
const TOKEN_MINT_ADDRESS = new PublicKey(process.env.TOKEN_MINT_ADDRESS);
const TOKEN_PROGRAM_ID = new PublicKey(process.env.TOKEN_PROGRAM_ID);

const walletConnectionMode = process.env.WALLET_CONNECTION_MODE === '1' ? 1 : 0;
const loggingEnabled = process.env.LOGGING_ENABLED === '1';

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Ensure logs directory exists
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)){
    fs.mkdirSync(logsDir);
}

// Logging function
function logWalletAccess(req) {
  if (loggingEnabled && req.query.address) {
    const dateTime = new Date().toISOString();
    const ipAddress = req.ip || req.connection.remoteAddress;
    const walletAddress = req.query.address;
    const logEntry = `${dateTime},${ipAddress},${walletAddress}\n`;
    
    const logFilePath = path.join(logsDir, 'wallet_access.csv');
    
    fs.appendFile(logFilePath, logEntry, (err) => {
      if (err) {
        console.error('Error writing to log file:', err);
      }
    });
  }
}

app.get('/', (req, res) => {
  res.render('index', { walletConnectionMode: process.env.WALLET_CONNECTION_MODE === '1' ? 1 : 0 });
});

app.get('/get-wallet-info', async (req, res) => {
  try {
    const walletAddress = new PublicKey(req.query.address);
    
    // Log wallet access only for this route
    logWalletAccess(req);

    console.log('Fetching info for wallet:', walletAddress.toString());

    // Derive ATA for PRINT token
    const ata = await getAssociatedTokenAddressSync(
      TOKEN_MINT_ADDRESS,
      walletAddress,
      false,
      TOKEN_PROGRAM_ID
    );

    console.log('Derived ATA:', ata.toString());

    // Fetch all token accounts
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletAddress, {
      programId: TOKEN_PROGRAM_ID
    });

    console.log(`Found ${tokenAccounts.value.length} token accounts`);

    // Filter and process token accounts
    const printToken = tokenAccounts.value
      .find(accountInfo => accountInfo.account.data.parsed.info.mint === TOKEN_MINT_ADDRESS.toString());

    let significantTokens = [];
    if (printToken) {
      const parsedInfo = printToken.account.data.parsed.info;
      significantTokens.push({
        mint: parsedInfo.mint,
        amount: Number(parsedInfo.tokenAmount.amount) / Math.pow(10, parsedInfo.tokenAmount.decimals),
        decimals: parsedInfo.tokenAmount.decimals,
        tokenAccountAddress: printToken.pubkey.toString()
      });
    }

    res.json({ 
      walletAddress: walletAddress.toString(),
      derivedATA: ata.toString(),
      significantTokens: significantTokens
    });
  } catch (error) {
    console.error('Error fetching wallet info:', error);
    res.status(500).json({ error: 'Error fetching wallet info', details: error.message });
  }
});

app.get('/get-daily-transfer-totals', async (req, res) => {
  try {
    if (!req.query.address) {
      throw new Error('No address provided');
    }

    const walletAddress = new PublicKey(req.query.address);

    console.log('Fetching daily totals for wallet:', walletAddress.toString());

    const sourceAddress = new PublicKey('DiSTRMum3xVhZkLE2LEF49Db7aVmcaViLQKs52XRT1s');
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60);

    console.log('Fetching signatures...');
    const signatures = await connection.getSignaturesForAddress(walletAddress, {
      limit: 1000,
    });
    console.log(`Fetched ${signatures.length} signatures`);

    if (signatures.length === 0) {
      return res.json({ dailyTotals: [] });
    }

    const dailyTotals = {};

    for (const sig of signatures) {
      if (sig.blockTime && sig.blockTime < sevenDaysAgo) {
        continue;
      }

      console.log(`Processing signature: ${sig.signature}`);
      const tx = await connection.getParsedTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
      });

      if (tx && tx.meta) {
        const walletIndex = tx.transaction.message.accountKeys.findIndex(
          key => key.pubkey.toString() === walletAddress.toString()
        );
        const sourceIndex = tx.transaction.message.accountKeys.findIndex(
          key => key.pubkey.toString() === sourceAddress.toString()
        );

        if (walletIndex !== -1 && sourceIndex !== -1) {
          const preBalance = tx.meta.preBalances[walletIndex];
          const postBalance = tx.meta.postBalances[walletIndex];
          const transferAmount = (postBalance - preBalance) / LAMPORTS_PER_SOL;

          if (transferAmount > 0) {
            const date = new Date(sig.blockTime * 1000).toISOString().split('T')[0];
            if (dailyTotals[date]) {
              dailyTotals[date].total += transferAmount;
            } else {
              dailyTotals[date] = { total: transferAmount, from: sourceAddress.toString() };
            }
            console.log(`Added transfer of ${transferAmount} SOL on ${date} from ${sourceAddress.toString()}`);
          }
        }
      }
    }

    const sortedDailyTotals = Object.entries(dailyTotals)
      .sort(([dateA], [dateB]) => dateB.localeCompare(dateA))
      .map(([date, data]) => ({ date, total: data.total, from: data.from }));

    console.log('Returning daily totals:', sortedDailyTotals);
    res.json({ dailyTotals: sortedDailyTotals });
  } catch (error) {
    console.error('Error fetching daily transfer totals:', error);
    res.status(500).json({ error: 'Error fetching daily transfer totals', details: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});