/**
 * Who a bearer token belongs to.
 *
 *   admin  everything: the admin pages, the requests tray, delegations, and all an agent may do
 *   agent  what a local agent needs: send, mark read, follow its events, look up messages and addresses
 *
 * The node asks through `TokenVerifier`, so a wrapper can check tokens
 * against wherever it keeps them.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export type Role = 'admin' | 'agent';

export interface TokenVerifier {
  /** The role a token grants, or null if it grants none. */
  verify(token: string): Role | null | Promise<Role | null>;
}

/** Compares two secrets without leaking, through timing, how much of one matches the other. */
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** Two fixed tokens, as read from the environment or the token files. */
export class StaticTokens implements TokenVerifier {
  constructor(private readonly tokens: { admin: string; agent?: string }) {
    if (tokens.agent !== undefined && tokens.agent === tokens.admin) {
      throw new Error('the agent token must differ from the admin token');
    }
  }

  verify(token: string): Role | null {
    if (token.length === 0) return null;
    // Both comparisons always run, so the answer takes the same time whichever token was tried.
    const admin = sameSecret(token, this.tokens.admin);
    const agent = this.tokens.agent !== undefined && sameSecret(token, this.tokens.agent);
    return admin ? 'admin' : agent ? 'agent' : null;
  }
}
