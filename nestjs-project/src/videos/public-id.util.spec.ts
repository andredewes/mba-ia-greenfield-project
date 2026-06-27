import { generatePublicId, PUBLIC_ID_LENGTH } from './public-id.util';

describe('generatePublicId', () => {
  it('returns a string of the configured length', () => {
    const id = generatePublicId();
    expect(id).toHaveLength(PUBLIC_ID_LENGTH);
  });

  it('produces URL-safe characters only', () => {
    for (let i = 0; i < 100; i++) {
      expect(generatePublicId()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('produces unique ids across a large sample', () => {
    const sample = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      sample.add(generatePublicId());
    }
    expect(sample.size).toBe(10000);
  });
});
