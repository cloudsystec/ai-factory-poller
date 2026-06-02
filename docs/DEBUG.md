# Debug do billing poller (local)

## F5 no Cursor / VS Code

1. **Run and Debug** → **Poller: Billing (F5)**
2. Breakpoints: `billing-settle-poller.js` (`runBillingSettleTick`), `billing-cursor-match.js`, `billing-settle-service.js`

Attach: `npm run dev:debug` + perfil **Poller: attach :9230**

## Tick manual

```bash
cd ai-factory-poller
node --input-type=module -e "
import 'dotenv/config';
import { runBillingSettleTick } from './src/billing-settle-poller.js';
await runBillingSettleTick();
process.exit(0);
"
```

## Calls elegíveis

```sql
SELECT id, status, source, started_at, ended_at, meta->>'botEmail' AS bot_email,
       COALESCE(ended_at, started_at) AS anchor_at
FROM billing_ai_calls
WHERE status IN ('pending', 'estimated')
  AND source IS DISTINCT FROM 'cursor_admin_api'
  AND COALESCE(ended_at, started_at) + interval '5 seconds' < now()
ORDER BY COALESCE(ended_at, started_at) ASC;
```

Âncora do match no poller: `COALESCE(ended_at, started_at)` (quando o CLI ainda não enviou `PATCH end-call`).
