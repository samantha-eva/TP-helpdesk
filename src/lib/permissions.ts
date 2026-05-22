export interface User {
  userId: string;
  role: string;
}

export interface Ticket {
  authorId: string;
  status: string;
}

/**
 * Vérifie si un utilisateur peut modifier un ticket.
 * - ADMIN : peut tout modifier
 * - AGENT : peut modifier tous les tickets
 * - USER : peut modifier seulement ses propres tickets, et seulement s'ils ne sont pas CLOSED
 */
export function canEditTicket(user: User, ticket: Ticket): boolean {
  if (user.role === 'ADMIN') return true;
  if (user.role === 'AGENT') return true;
  if (user.role === 'USER') {
    return ticket.authorId === user.userId && ticket.status !== 'CLOSED';
  }
  return false;
}

/**
 * Vérifie si un utilisateur peut supprimer un ticket.
 * Seuls les ADMIN peuvent supprimer.
 */
export function canDeleteTicket(user: User): boolean {
  return user.role === 'ADMIN';
}
