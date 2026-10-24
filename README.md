# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) de múltiplos provedores, com idempotência persistente, concorrência segura entre instâncias, ledger imutável e mensageria via SQS.

Stack: Bun, TypeScript estrito, NestJS, MikroORM, PostgreSQL 16, SQS (MiniStack).

## Pré-requisitos

- Bun 1.x
- Docker e Docker Compose

## Como subir

```bash
cp .env.example .env        # ajuste se quiser
bun install
docker compose up -d        # PostgreSQL + MiniStack (SQS)
bun run migrate             # aplica as migrations em ordem
bun run start               # API em http://localhost:3000
```

As filas (`wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wager-events.fifo`) são criadas automaticamente na inicialização. Variáveis opcionais: `PORT` (3000), `SQS_ENDPOINT` (http://localhost:4566), `AWS_REGION` (us-east-1). O `.env.example` já traz um `DATABASE_URL` coerente com o `docker-compose.yml`. Para rodar os testes, o banco precisa estar migrado (`bun run migrate`).

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | API + consumer SQS + publisher da outbox + worker de PENDING_REFERENCE |
| `bun run migrate` | aplica as migrations pendentes |
| `bun run migrate:down` | desfaz a última migration aplicada |
| `bun test` | todos os testes (exigem Postgres e MiniStack no ar) |
| `bun run typecheck` | `tsc --noEmit` em modo estrito |

## Endpoints

| Método e rota | Descrição |
|---|---|
| `POST /wallets` | cria wallet (saldo inicial gera OPENING + ledger CREDIT) |
| `GET /wallets/:walletId` | consulta wallet |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | ledger paginado por cursor opaco |
| `POST /wallets/:walletId/reconciliation` | compara saldo armazenado com o ledger |
| `POST /wagering/transactions` | submete transação (header `Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | consulta por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | consulta por id do provedor |
| `GET /health/live`, `GET /health/ready` | liveness e readiness (sem autenticação) |
| `GET /metrics` | métricas em formato Prometheus |

### Status HTTP

| Situação | Status |
|---|---|
| Processada (nova ou replay) | 200 |
| Aceita, aguardando referência (`PENDING_REFERENCE`) | 202 |
| Payload inválido, `Idempotency-Key` ausente | 400 |
| Wallet/transação inexistente | 404 |
| Mesma key com payload diferente; wallet duplicada | 409 |
| Rejeição de negócio (`REJECTED`), com `failureCode` e `providerAction` | 422 |
| Falha transitória de infraestrutura | 503 com `Retry-After` |

## Exemplo

```bash
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -i -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<ID_DA_WALLET>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

## Testes

Os testes usam PostgreSQL e SQS reais (sem mocks). Destaques:

- duas apostas de 80.00 sobre saldo 100.00: uma `PROCESSED`, uma `REJECTED`, saldo 20.00
- a mesma aposta 50 vezes em paralelo: um único débito
- **3 processos `bun` separados** disputando a mesma wallet (`src/testing/multi-instance.test.ts`)
- dois publishers concorrentes sobre a mesma outbox e dois workers concorrentes sobre as mesmas transações em `PENDING_REFERENCE`
- worker morto depois do commit e antes do ack (simulado: o use case é chamado direto e a mensagem continua na fila): a reentrega é ignorada pelo inbox
- mensagem inválida segue para a DLQ após 5 recebimentos
- invariante final: saldo da wallet = saldo reconstruído pelo ledger

Os testes isolam dados por provider aleatório; `clearPending()` em `outbox-publisher.test.ts` marca eventos pendentes como publicados e **só deve rodar em banco de teste**.

Não há teste automatizado de reinício do serviço inteiro nem de SIGTERM (verificado manualmente); veja as limitações no ARCHITECTURE.md.

Decisões e limitações: veja [ARCHITECTURE.md](ARCHITECTURE.md).