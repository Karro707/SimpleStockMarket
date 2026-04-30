import express, { Request, Response } from 'express';
import Redis from 'ioredis';

const app = express();
app.use(express.json());

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
});

redis.on('error', (err) => {
    console.error('Redis connection error:', err);
});

const VALID_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function isValidId(value: string): boolean {
    return VALID_ID_RE.test(value);
}

//Lua script for atomic buy/sell operation
const tradeLuaScript = `
local bankKey   = KEYS[1]
local walletKey = KEYS[2]
local logKey    = KEYS[3]
local stockName = ARGV[1]
local walletId  = ARGV[2]
local action    = ARGV[3]

local bankExists = redis.call('HEXISTS', bankKey, stockName)
if bankExists == 0 then return -1 end

if action == "buy" then
    local available = tonumber(redis.call('HGET', bankKey, stockName))
    if available < 1 then return -2 end
    redis.call('HINCRBY', bankKey,   stockName, -1)
    redis.call('HINCRBY', walletKey, stockName,  1)
    local entry = cjson.encode({type="buy", wallet_id=walletId, stock_name=stockName})
    redis.call('RPUSH', logKey, entry)
    return 1

elseif action == "sell" then
    local inWallet = tonumber(redis.call('HGET', walletKey, stockName) or '0')
    if inWallet < 1 then return -3 end
    redis.call('HINCRBY', walletKey, stockName, -1)
    redis.call('HINCRBY', bankKey,   stockName,  1)
    local entry = cjson.encode({type="sell", wallet_id=walletId, stock_name=stockName})
    redis.call('RPUSH', logKey, entry)
    return 1
end

return -4
`;

declare module 'ioredis' {
    interface Redis {
        executeTrade(
            bankKey: string,
            walletKey: string,
            logKey: string,
            stockName: string,
            walletId: string,
            action: string
        ): Promise<number>;
    }
}

redis.defineCommand('executeTrade', {
    numberOfKeys: 3,
    lua: tradeLuaScript,
});

const BANK_KEY = 'bank:stocks';
const LOG_KEY  = 'audit_log';

function walletKey(walletId: string): string {
    return `wallet:${walletId}:stocks`;
}

app.post('/wallets/:wallet_id/stocks/:stock_name', async (req: Request, res: Response) => {
    const { wallet_id, stock_name } = req.params;
    const { type } = req.body as { type?: string };

    if (!isValidId(wallet_id) || !isValidId(stock_name)) 
    {
        return res.status(400).send('Invalid wallet_id or stock_name');
    }

    if (type !== 'buy' && type !== 'sell') 
    {
        return res.status(400).send('Invalid type: must be "buy" or "sell"');
    }

    try 
    {
        const result = await redis.executeTrade(
            BANK_KEY,
            walletKey(wallet_id),
            LOG_KEY,
            stock_name,
            wallet_id,
            type
        );

        if (result === -1) return res.status(404).send('Stock does not exist');
        if (result === -2) return res.status(400).send('No stock available in the bank');
        if (result === -3) return res.status(400).send('No stock available in the wallet');
        if (result === 1)  return res.status(200).send('Success');

        return res.status(500).send('Internal error');
    } 
    catch (err) 
    {
        console.error('Trade error:', err);
        return res.status(500).send('Database error');
    }
});

app.get('/wallets/:wallet_id', async (req: Request, res: Response) => {
    const { wallet_id } = req.params;

    if (!isValidId(wallet_id)) 
    {
        return res.status(400).send('Invalid wallet_id');
    }

    try 
    {
        const data = await redis.hgetall(walletKey(wallet_id));
        const stocks = Object.entries(data)
            .map(([name, qty]) => ({ name, quantity: parseInt(qty, 10) }))
            .filter((s) => s.quantity > 0);

        return res.status(200).json({ id: wallet_id, stocks });
    } 
    catch (err) 
    {
        console.error('Get wallet error:', err);
        return res.status(500).send('Database error');
    }
});

app.get('/wallets/:wallet_id/stocks/:stock_name', async (req: Request, res: Response) => {
    const { wallet_id, stock_name } = req.params;

    if (!isValidId(wallet_id) || !isValidId(stock_name)) 
    {
        return res.status(400).send('Invalid wallet_id or stock_name');
    }

    try 
    {
        const qty = await redis.hget(walletKey(wallet_id), stock_name);
        return res.status(200).send(qty ?? '0');
    } 
    catch (err) 
    {
        console.error('Get wallet stock error:', err);
        return res.status(500).send('Database error');
    }
});

app.get('/stocks', async (_req: Request, res: Response) => {
    try 
    {
        const data = await redis.hgetall(BANK_KEY);
        const stocks = Object.entries(data).map(([name, qty]) => ({
            name,
            quantity: parseInt(qty, 10),
        }));
        return res.status(200).json({ stocks });
    } 
    catch (err) 
    {
        console.error('Get stocks error:', err);
        return res.status(500).send('Database error');
    }
});

app.post('/stocks', async (req: Request, res: Response) => {
    const { stocks } = req.body as { stocks?: unknown };

    if (!Array.isArray(stocks)) 
    {
        return res.status(400).send('Invalid format: "stocks" must be an array');
    }

    const validStocks = (stocks as unknown[]).filter(
        (s): s is { name: string; quantity: number } =>
            typeof s === 'object' &&
            s !== null &&
            typeof (s as Record<string, unknown>).name === 'string' &&
            isValidId((s as Record<string, unknown>).name as string) &&
            typeof (s as Record<string, unknown>).quantity === 'number' &&
            Number.isInteger((s as Record<string, unknown>).quantity) &&
            ((s as Record<string, unknown>).quantity as number) >= 0
    );

    try 
    {
        const multi = redis.multi();
        multi.del(BANK_KEY);
        for (const stock of validStocks) {
            multi.hset(BANK_KEY, stock.name, stock.quantity);
        }
        await multi.exec();
        return res.status(200).send('Bank state updated');
    } 
    catch (err) 
    {
        console.error('Post stocks error:', err);
        return res.status(500).send('Database error');
    }
});

app.get('/log', async (_req: Request, res: Response) => {
    try 
    {
        const raw = await redis.lrange(LOG_KEY, 0, -1);
        const log = raw.map((entry) => JSON.parse(entry) as Record<string, string>);
        return res.status(200).json({ log });
    } 
    catch (err) 
    {
        console.error('Get log error:', err);
        return res.status(500).send('Database error');
    }
});

app.post('/chaos', (_req: Request, res: Response) => {
    res.status(200).send('Instance killed!');
    const instance = process.env.INSTANCE_ID ?? process.pid.toString();
    console.log(`Chaos monkey executed! Terminating instance ${instance}`);
    setTimeout(() => process.exit(1), 100);
});

const PORT = parseInt(process.env.PORT ?? '8080', 10);
app.listen(PORT, () => {
    const instance = process.env.INSTANCE_ID ?? process.pid.toString();
    console.log(`[${instance}] Listening on port ${PORT}`);
});