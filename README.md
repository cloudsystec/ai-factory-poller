# AI Factory — Billing Poller

Processo dedicado que faz settle incremental de calls AI: consulta a Cursor Admin API, faz match 1:1 com eventos de uso e propaga custo para jobs/tenants.

## Desenvolvimento local

Dois processos — API e poller:

```bash
# Terminal 1 — API + WebSocket
cd ai-factory-back && npm run dev

# Terminal 2 — poller
cd ai-factory-poller && npm run dev
```

Variáveis: copiar `.env.example` para `.env` (mesmo `DATABASE_URL`, `ENCRYPTION_KEY` e `REDIS_URL` da API).

## Deploy Railway

Root Directory: **`ai-factory-poller`**, config `railway.json`.

Ver também [`ai-factory-back/docs/DEPLOY-RAILWAY.md`](../ai-factory-back/docs/DEPLOY-RAILWAY.md).

## Debug

Ver [`docs/DEBUG.md`](docs/DEBUG.md).
