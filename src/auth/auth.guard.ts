import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

/**
 * Ponto de extensão de autenticação. HOJE É NO-OP (libera tudo): o desafio não pontua auth.
 * Para ativar: validar o JWT (OIDC de um IdP externo, ex.: Keycloak/Zitadel) aqui, derivar o
 * providerId do token e liberar as rotas /health/* (que devem continuar públicas).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}