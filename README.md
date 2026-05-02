# Simple Stock Market
 
A simplified, highly available stock exchange REST API.
 
## Stack
 
  - API: Node.js + TypeScript (Express) 
  - State: Redis - shared across all instances 
  - Load balancer: Nginx - `least_conn` + automatic failover 
  - Orchestration: Docker Compose - 3 independent API replicas 
 
Atomic buy/sell operations are implemented as a Redis Lua script to prevent race conditions under concurrent load.
 
## Prerequisites
 
Docker must be installed and running. No other runtime is required.
 
## Start
 
**Linux / macOS**
```bash
chmod +x start.sh
./start.sh 3000
```
 
**Windows**
```cmd
start.cmd 3000
```
 
The API is available at `http://localhost:3000`.
 
To stop: `docker-compose down`
 
## High Availability
 
Three API instances run behind Nginx. When `/chaos` kills one instance:
- Nginx detects the failure via `proxy_next_upstream` and retries on a healthy instance
- Docker restarts the killed container automatically (`restart: unless-stopped`)
- All state lives in Redis, so any instance can serve any request
Killing one instance does not interrupt the service.
 
## API
 
### Bank
 
#### `GET /stocks`
Returns current bank inventory.
```json
{ "stocks": [{ "name": "Apple", "quantity": 100 }] }
```
 
#### `POST /stocks`
Replaces the entire bank state.
```json
{ "stocks": [{ "name": "Apple", "quantity": 100 }, { "name": "Google", "quantity": 50 }] }
```
Returns `200 Bank state updated`.
 
### Wallets
 
#### `POST /wallets/{wallet_id}/stocks/{stock_name}`
Buy or sell one unit of a stock. Creates the wallet if it does not exist.
 
Body:
```json
{ "type": "buy" }
```
 
| Status | Reason |
| `200` | Success |
| `400` | No stock in bank (buy) / no stock in wallet (sell) |
| `404` | Stock does not exist in the bank |
 
#### `GET /wallets/{wallet_id}`
Returns full wallet state.
```json
{ "id": "alice", "stocks": [{ "name": "Apple", "quantity": 3 }] }
```
 
#### `GET /wallets/{wallet_id}/stocks/{stock_name}`
Returns a single quantity number.
```
3
```
 
### Audit Log
 
#### `GET /log`
Returns all successful trade operations in order of occurrence. Bank resets are not logged.
```json
{
  "log": [
    { "type": "buy",  "wallet_id": "alice", "stock_name": "Apple" },
    { "type": "sell", "wallet_id": "bob",   "stock_name": "Apple" }
  ]
}
```
 
### Chaos
 
#### `POST /chaos`
Kills the instance that served the request. The remaining two instances continue handling traffic.
