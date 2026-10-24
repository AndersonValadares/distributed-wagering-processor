import { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../shared/money.ts';
import { SubmitTransactionUseCase } from '../wagering/submit-transaction.ts';

// Uso: bun run instance-runner.ts <modo> <walletId> <playerId> <providerId> <instancia> <quantidade>
const [mode, walletId, playerId, providerId, instance, count] = process.argv.slice(2) as [
  string, string, string, string, string, string,
];

const orm = await MikroORM.init({
  clientUrl: process.env.DATABASE_URL,
  entities: [],
  discovery: { warnWhenNoEntities: false },
});
const useCase = new SubmitTransactionUseCase(orm);

const jobs = Array.from({ length: Number(count) }, (_, i) => {
  // "distinct": cada aposta é única. "same": todas as instâncias enviam a MESMA aposta.
  const ext = mode === 'same' ? 'aposta-unica' : `aposta-${instance}-${i}`;
  return useCase
    .execute({
      providerId,
      externalTransactionId: ext,
      idempotencyKey: `${providerId}:${ext}`,
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: Money.fromDecimal('10.00', 'BRL'),
      referenceExternalTransactionId: undefined,
    })
    .then((r) => r.status + (r.idempotentReplay ? ':replay' : ''))
    .catch((e) => 'ERRO:' + (e as Error).name);
});

const results = await Promise.all(jobs);
const tally: Record<string, number> = {};
for (const r of results) tally[r] = (tally[r] ?? 0) + 1;
console.log(JSON.stringify(tally));
await orm.close();