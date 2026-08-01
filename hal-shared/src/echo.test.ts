import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { EchoReply, formatEcho } from './echo.ts';

describe('formatEcho', () => {
  it('trims surrounding whitespace', () => {
    expect(formatEcho('  hello  ')).toBe('hello');
  });

  it('collapses internal whitespace runs', () => {
    expect(formatEcho('hello \n\t  world')).toBe('hello world');
  });

  it('leaves already-clean text untouched', () => {
    expect(formatEcho('hello world')).toBe('hello world');
  });
});

describe('EchoReply', () => {
  const decode = Schema.decodeSync(EchoReply);

  it('decodes a well-formed reply', () => {
    expect(decode({ text: 'hello', seq: 1, sessionId: 'abc' })).toEqual({
      text: 'hello',
      seq: 1,
      sessionId: 'abc',
    });
  });

  it('rejects a reply whose seq is not a number', () => {
    expect(() => decode({ text: 'hello', seq: '1', sessionId: 'abc' } as never)).toThrow();
  });
});
