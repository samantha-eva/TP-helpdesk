import { describe, it, expect } from 'vitest';
import { loginSchema, ticketUpdateSchema } from '@/lib/validators';

describe('validators.ts — loginSchema', () => {
  it('accepte un login valide', () => {
    const result = loginSchema.safeParse({
      email: 'test@example.io',
      password: 'monmotdepasse',
    });
    expect(result.success).toBe(true);
  });

  it('rejette un email vide', () => {
    const result = loginSchema.safeParse({
      email: '',
      password: 'monmotdepasse',
    });
    expect(result.success).toBe(false);
  });

  it('rejette un mot de passe vide', () => {
    const result = loginSchema.safeParse({
      email: 'test@example.io',
      password: '',
    });
    expect(result.success).toBe(false);
  });
});

describe('validators.ts — ticketUpdateSchema', () => {
  it('accepte une mise à jour partielle (juste le status)', () => {
    const result = ticketUpdateSchema.safeParse({
      status: 'RESOLVED',
    });
    expect(result.success).toBe(true);
  });

  it('rejette un status invalide', () => {
    const result = ticketUpdateSchema.safeParse({
      status: 'INVALID',
    });
    expect(result.success).toBe(false);
  });

  it('rejette un titre trop court', () => {
    const result = ticketUpdateSchema.safeParse({
      title: 'ab',
    });
    expect(result.success).toBe(false);
  });

  it('accepte un assigneeId null (désassigner)', () => {
    const result = ticketUpdateSchema.safeParse({
      assigneeId: null,
    });
    expect(result.success).toBe(true);
  });
});
