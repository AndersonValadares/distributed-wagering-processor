import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { asMoney, asObject, asUuid } from '../http/parsers.ts';
import { CreateWalletUseCase } from './create-wallet.ts';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly createWallet: CreateWalletUseCase) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const obj = asObject(body, 'body');
    const result = await this.createWallet.execute({
      playerId: asUuid(obj, 'playerId'),
      initialBalance: asMoney(obj, 'initialBalance'),
    });
    return {
      id: result.id,
      playerId: result.playerId,
      balance: { amount: result.balance.toDecimal(), currency: result.balance.currency },
      version: result.version,
    };
  }
}