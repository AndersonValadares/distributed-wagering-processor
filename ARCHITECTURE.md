# Arquitetura

## Visão geral

```
HTTP ─┐
      ├─► SubmitTransactionUseCase ─► [1 transação SQL] wallet + transação + ledger + inbox + outbox
SQS ──┘                                         │
                                                ▼
                          OutboxPublisher (SKIP LOCKED) ─► SQS wager-events.fifo
PendingReferenceWorker ─► reaplica REFUND/ROLLBACK quando a referência chega
```

HTTP e SQS reutilizam o mesmo use case. O domínio (`Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `applyTransaction`) não depende de NestJS, ORM nem banco.

## Decisões

**Dinheiro.** `bigint` em centavos no domínio, `bigint` no banco (`balance_cents`), `Money` imutável com escala fixa de 2 casas. Nenhum `number` no caminho. Entrada só aceita string decimal (`"25.00"`); notação científica, negativos e 3+ casas são rejeitados na borda (400).

**Concorrência: lock pessimista por wallet.** `SELECT ... FOR UPDATE` na linha da wallet dentro da transação. Serializa operações da mesma wallet e deixa wallets diferentes em paralelo (sem lock global). Escolhido sobre optimistic locking porque uma wallet quente geraria muitos retries; o custo é manter a transação curta. Defesas no schema: `CHECK (balance_cents >= 0)`, `version` incrementada a cada mudança de saldo. Ordem de locks fixa (wallet, depois transação) em todos os caminhos, evitando deadlock.

**Idempotência persistente.** `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`; o use case insere com `ON CONFLICT DO NOTHING RETURNING`. Se não inseriu, lê a existente: `payload_hash` igual é replay (devolve o resultado original, incluindo o saldo da época, gravado em `balance_after_cents`); diferente é conflito (409). O hash é SHA-256 de um JSON canônico (chaves em ordem alfabética) dos campos de negócio; header e metadados não entram. Nada em memória.

**Hash do payload.** Campos: providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, amount, currency, referenceExternalTransactionId. A `Idempotency-Key` do header é a chave de deduplicação; o mesmo `externalTransactionId` com outra key também cai no replay (ou 409 se o payload mudou), pelo UNIQUE do banco.

**`REJECTED` é commit, não exceção.** Rejeição de negócio é gravada e auditável, gera evento e é idempotente (reenviar devolve a rejeição original, mesmo que o saldo mude depois).

**Ledger imutável.** Trigger bloqueia `UPDATE`/`DELETE`; `UNIQUE (transaction_id)` (um lançamento por transação); `CHECK` da aritmética `antes ± valor = depois`. A mesma conta é validada em `WalletLedgerEntry.create`.

**Reversões.** Índice parcial único em `reference_transaction_id` para REFUND/ROLLBACK `PROCESSED`: uma referência só é revertida uma vez, garantido pelo banco. REFUND só referencia BET; ROLLBACK referencia BET, WIN ou REFUND; valor deve ser igual ao da referência; ROLLBACK é o inverso da direção da referência. Reversão que deixaria saldo negativo é `REVERSAL_WOULD_OVERDRAW` (distinto de `INSUFFICIENT_FUNDS`). Interpretação: o índice único impede qualquer segunda reversão da mesma referência, de qualquer tipo (um REFUND e um ROLLBACK da mesma BET não coexistem), o que é mais restritivo que "o mesmo tipo de operação" do enunciado.

**Outbox transacional.** Eventos são gravados na mesma transação SQL da mudança financeira e publicados por um worker com `FOR UPDATE SKIP LOCKED` (múltiplos publishers sem duplicar trabalho), com backoff exponencial (2s, 4s, ... teto de 5 min). Entrega at-least-once: se o processo morrer entre publicar e commitar, o evento é reenviado; o `MessageDeduplicationId` é o id do evento e o `eventId` é estável para o consumidor deduplicar.

**Inbox.** PK `(consumer_name, message_id)`, inserida na mesma transação financeira. Morte antes do commit: tudo volta e a mensagem é reentregue. Morte depois do commit e antes do ack: a reentrega cai no inbox e é confirmada sem reprocessar.

**Consumer SQS.** Ack só depois do commit. Erro de negócio (inclui `REJECTED` e `PENDING_REFERENCE`) é sucesso e confirma. Erro permanente (JSON/validação inválida, conflito de idempotência, wallet inexistente) não confirma e é reentregue imediatamente até `maxReceiveCount = 5`, quando o SQS move para a DLQ. Transitório: visibilidade com backoff. SIGTERM: termina a mensagem em andamento e devolve as não iniciadas. Erros transitórios usam o mesmo limite: após 5 recebimentos a mensagem vai para a DLQ, mesmo que a causa fosse passageira.

**Filas.** Entrada (`wager-transactions.fifo`, com DLQ) separada da saída (`wager-events.fifo`) para o consumer não ler os próprios eventos. FIFO é otimização de ordem; a correção vem do banco.

**Referências fora de ordem.** REFUND/ROLLBACK sem referência vira `PENDING_REFERENCE` (202). O worker reprocessa com `SKIP LOCKED`, travando a wallet antes (serializa com submissões novas). Limite: 8 tentativas com backoff exponencial (2s, 4s, ... 128s; cerca de 4 minutos no total); depois `REJECTED` com `REFERENCE_NOT_FOUND` e evento. Escolhemos tentativas em vez de TTL fixo porque o backoff já limita a carga.

**ORM.** MikroORM (preferencial). Usamos `EntityManager.transactional()` e SQL explícito via `em.execute`, não o mapeamento de entidades. Motivo: o controle de `FOR UPDATE`, `ON CONFLICT` e `SKIP LOCKED` fica explícito e auditável, e o domínio permanece sem decorators de ORM. Trade-off: perdemos Unit of Work e Identity Map. Money é mapeado para `bigint` (centavos) e reidratado por `Money.fromCents`.

**Taxonomia de `failureCode`** (`src/wagering/failure-code.ts`): cada código traz `providerAction` (`RETRY`, `FIX_PAYLOAD`, `GIVE_UP`) devolvido na resposta 422, para o provedor decidir sem interpretar texto.

| failureCode | providerAction | Quando |
|---|---|---|
| INSUFFICIENT_FUNDS | GIVE_UP | BET sem saldo |
| REVERSAL_WOULD_OVERDRAW | GIVE_UP | reversão deixaria saldo negativo |
| REFERENCE_NOT_FOUND | FIX_PAYLOAD | referência não chegou dentro do limite do worker |
| REFERENCE_MISMATCH | FIX_PAYLOAD | referência de outro provider, player, wallet, moeda ou rodada |
| REFERENCE_NOT_PROCESSED | GIVE_UP | referência foi rejeitada, não há o que reverter |
| INVALID_REFERENCE_KIND | FIX_PAYLOAD | tipo não pode referenciar aquele tipo |
| ALREADY_REVERSED | GIVE_UP | referência já revertida |
| AMOUNT_MISMATCH | FIX_PAYLOAD | valor difere do da referência |
| CURRENCY_MISMATCH | FIX_PAYLOAD | moeda diferente da wallet |
| WALLET_NOT_FOUND | FIX_PAYLOAD | existe no catálogo, mas hoje wallet inexistente vira 404, não REJECTED |
| INTERNAL_ERROR | RETRY | reservado, nenhum caminho o produz hoje |

**Máquina de estados.** `PENDING → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE`; `PENDING_REFERENCE → PROCESSED | REJECTED | FAILED`. Terminais não mudam; tentar é erro de programação (`InvalidTransactionStateError`).

**Autenticação: não implementada.** Fora da pontuação. Ponto de extensão: um `AuthGuard` global do NestJS validando JWT de um IdP externo (Keycloak/Zitadel via OIDC); `/health/*` ficaria público e o `providerId` seria derivado do token. Não há tabela de usuários nem hash de senha por decisão. O ponto de extensão existe no código: src/auth/auth.guard.ts (guard global no-op).

**Health.** `/health/live` não toca em dependências; `/health/ready` checa PostgreSQL e SQS (timeout de 2s) e devolve 503 com o detalhe de cada check.

**Métricas.** `GET /metrics` (formato Prometheus). Valores que vivem no banco (transações por status, outbox pendente e lag, `PENDING_REFERENCE`, inbox) são calculados por consulta e valem para todas as instâncias. Contadores de processo (duplicatas, conflitos de idempotência, retries do consumer, mensagens na DLQ, histograma de latência) ficam em memória por instância e devem ser somados pelo coletor. Conflitos de lock não são medidos diretamente (o lock pessimista espera, não falha); o tempo de espera aparece no histograma de latência.

**Reconciliação.** `POST /wallets/:id/reconciliation` recalcula o saldo pela soma do ledger e compara com o saldo armazenado. Divergência não é corrigida: é logada em JSON, contada em `wager_reconciliation_divergences_total` e sinalizada na resposta (`consistent: false`).

## Mapeamento HTTP

Ver tabela no README. Regra: erros de domínio passam por um único filtro (`DomainExceptionFilter`), consistente entre endpoints; 422 e 202 são respostas do fluxo de negócio.

## Limitações conhecidas

- Erro permanente do consumer depende do redrive do SQS (5 recebimentos) em vez de DLQ explícita.
- SIGTERM verificado manualmente, sem teste automatizado; não há teste automatizado de reinício do serviço inteiro.
- Sem teste de carga e sem double-entry.
- Rejeição por referência de outra wallet/player/provider usa `REFERENCE_MISMATCH`; reversões parciais fora de escopo (conforme enunciado).
- Migrations: o runner aplica `.up.sql` em ordem e `migrate:down` desfaz só a última.
- Observabilidade parcial: logs JSON existem no consumer e na reconciliação; o restante da aplicação usa o logger padrão do NestJS (sem `correlationId` em todas as linhas).
- Em ambiente de teste o outbox acumula eventos pendentes (os testes não rodam o publisher); em produção o publisher roda continuamente.
- Wallet inexistente numa mensagem SQS é tratada como erro permanente (vai para a DLQ após 5 recebimentos), embora uma wallet criada logo depois pudesse resolver o caso.
- Os eventos da outbox usam o envelope (`eventId`, `eventType`, `aggregateId`, `correlationId`, `occurredAt`, `version`, `data`), sem `causationId` e sem subclasses de `IntegrationEvent`.
- O status `FAILED` e o código `INTERNAL_ERROR` existem no modelo, mas nenhum caminho os produz hoje; falhas de infraestrutura são tratadas por retry (consumer) ou 503 (HTTP).
- A métrica `wager_dlq_messages_total` é aproximada: conta erros permanentes a partir do 5º recebimento e não conta erros transitórios que acabam na DLQ.
- O 503 por falha transitória de banco (`DomainExceptionFilter`) não tem teste automatizado; o 503 do readiness foi verificado manualmente.
- Os agregados `InboxMessage` e `OutboxMessage` da seção 6.5 do enunciado não existem como classes de domínio: inbox e outbox são tabelas manipuladas por SQL. `Money` usa `fromDecimal`/`fromCents`/`toDecimal` e não tem `negate`, `isLessThan` nem `toJSON`.
- O inbox guarda `payload_hash`, mas não o compara: a mesma `messageId` com outro corpo é tratada como duplicata.