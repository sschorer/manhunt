import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  HEARTBEAT,
  isEventFrame,
  isReplyFrame,
  isRequestFrame,
  parseFrame,
  type ClientFrame,
  type EventFrame,
  type ReplyFrame,
  type RequestFrame,
  type ServerEventFrame,
} from './frames.ts';
import type { ClaimCatchPayload, GameOverEvent, LobbyUpdateEvent } from './messages.ts';

describe('parseFrame', () => {
  it('parses an event frame', () => {
    const frame = parseFrame('{"t":"lobby_update","d":{"game":null}}');
    expect(frame).toEqual({ t: 'lobby_update', d: { game: null } });
    expect(frame && isEventFrame(frame)).toBe(true);
  });

  it('parses a request frame', () => {
    const frame = parseFrame('{"t":"claim_catch","id":7,"d":{"targetId":"p2"}}');
    expect(frame).toEqual({ t: 'claim_catch', id: 7, d: { targetId: 'p2' } });
    expect(frame && isRequestFrame(frame)).toBe(true);
    expect(frame && isEventFrame(frame)).toBe(false);
  });

  it('parses a reply frame', () => {
    const frame = parseFrame('{"re":7,"d":{"ok":true}}');
    expect(frame).toEqual({ re: 7, d: { ok: true } });
    expect(frame && isReplyFrame(frame)).toBe(true);
    expect(frame && isEventFrame(frame)).toBe(false);
  });

  it.each([
    ['not JSON', '{'],
    ['the heartbeat', HEARTBEAT.ping],
    ['an array', '[1,2]'],
    ['a primitive', '42'],
    ['null', 'null'],
    ['a missing type', '{"d":{}}'],
    ['an empty type', '{"t":"","d":{}}'],
    ['a non-string type', '{"t":3,"d":{}}'],
    ['a non-integer request id', '{"t":"claim_catch","id":"7","d":{}}'],
    ['a fractional reply id', '{"re":1.5,"d":{}}'],
  ])('rejects %s', (_label, text) => {
    expect(parseFrame(text)).toBeUndefined();
  });
});

describe('frame types', () => {
  it('discriminates server events by their name', () => {
    expectTypeOf<Extract<ServerEventFrame, { t: 'game_over' }>>().toEqualTypeOf<
      EventFrame<'game_over', GameOverEvent>
    >();
    expectTypeOf<Extract<ServerEventFrame, { t: 'lobby_update' }>['d']>().toEqualTypeOf<LobbyUpdateEvent>();
  });

  it('lets a client message be an event or a request', () => {
    expectTypeOf<Extract<ClientFrame, { t: 'claim_catch' }>>().toEqualTypeOf<
      EventFrame<'claim_catch', ClaimCatchPayload> | RequestFrame<'claim_catch', ClaimCatchPayload>
    >();
  });

  it('gives a reply only a correlation id and a body', () => {
    expectTypeOf<ReplyFrame<{ ok: true }>>().toEqualTypeOf<{ re: number; d: { ok: true } }>();
  });
});
