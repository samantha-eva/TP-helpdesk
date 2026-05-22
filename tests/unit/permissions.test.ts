import { describe, it, expect } from 'vitest';
import { canEditTicket, canDeleteTicket } from '@/lib/permissions';

const admin = { userId: '1', role: 'ADMIN' };
const agent = { userId: '2', role: 'AGENT' };
const user = { userId: '3', role: 'USER' };
const otherUser = { userId: '4', role: 'USER' };

const openTicket = { authorId: '3', status: 'OPEN' };
const closedTicket = { authorId: '3', status: 'CLOSED' };

describe('permissions.ts — canEditTicket', () => {
  it('un ADMIN peut modifier n\'importe quel ticket', () => {
    expect(canEditTicket(admin, openTicket)).toBe(true);
    expect(canEditTicket(admin, closedTicket)).toBe(true);
  });

  it('un AGENT peut modifier n\'importe quel ticket', () => {
    expect(canEditTicket(agent, openTicket)).toBe(true);
  });

  it('un USER peut modifier son propre ticket OPEN', () => {
    expect(canEditTicket(user, openTicket)).toBe(true);
  });

  it('un USER ne peut pas modifier son propre ticket CLOSED', () => {
    expect(canEditTicket(user, closedTicket)).toBe(false);
  });

  it('un USER ne peut pas modifier le ticket d\'un autre', () => {
    expect(canEditTicket(otherUser, openTicket)).toBe(false);
  });
});

describe('permissions.ts — canDeleteTicket', () => {
  it('seul un ADMIN peut supprimer un ticket', () => {
    expect(canDeleteTicket(admin)).toBe(true);
    expect(canDeleteTicket(agent)).toBe(false);
    expect(canDeleteTicket(user)).toBe(false);
  });
});
