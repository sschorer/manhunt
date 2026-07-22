import { describe, expect, it } from 'vitest';
import {
  canStart,
  createMemoryLobby,
  LobbyError,
  MAX_NAME_LENGTH,
  normalizeRoomCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from './rooms.ts';

describe('createMemoryLobby', () => {
  it('creates a room with an unambiguous code and a host', () => {
    const lobby = createMemoryLobby();
    const { game, player } = lobby.createGame('Ada');

    expect(game.status).toBe('lobby');
    expect(game.roomCode).toHaveLength(ROOM_CODE_LENGTH);
    expect([...game.roomCode]).toEqual(
      [...game.roomCode].filter((c) => ROOM_CODE_ALPHABET.includes(c)),
    );
    expect(game.players).toHaveLength(1);
    expect(player).toMatchObject({ name: 'Ada', role: 'hunter', ready: false, isHost: true });
    expect(lobby.getByCode(game.roomCode)?.id).toBe(game.id);
  });

  it('mints distinct codes for distinct rooms', () => {
    const lobby = createMemoryLobby();
    const codes = new Set<string>();
    for (let i = 0; i < 50; i += 1) codes.add(lobby.createGame(`p${i}`).game.roomCode);
    expect(codes.size).toBe(50);
  });

  it('rejects a blank host name', () => {
    const lobby = createMemoryLobby();
    expect(() => lobby.createGame('   ')).toThrow(LobbyError);
    expect(() => lobby.createGame(undefined)).toThrow(/name is required/i);
  });

  it('trims and caps long names', () => {
    const lobby = createMemoryLobby();
    const { player } = lobby.createGame(`  ${'x'.repeat(100)}  `);
    expect(player.name).toHaveLength(MAX_NAME_LENGTH);
  });

  it('joins by code (case-insensitively) as a hider', () => {
    const lobby = createMemoryLobby();
    const { game } = lobby.createGame('Host');

    const joined = lobby.joinGame(` ${game.roomCode.toLowerCase()} `, 'Bo');
    expect(joined.player).toMatchObject({ name: 'Bo', role: 'hider', isHost: false });
    expect(joined.game.id).toBe(game.id);
    expect(joined.game.players).toHaveLength(2);
  });

  it('rejects joining an unknown code', () => {
    const lobby = createMemoryLobby();
    expect(() => lobby.joinGame('ZZZZ', 'Bo')).toThrow(/no room/i);
  });

  it('rejects joining a game that already started', () => {
    const lobby = createMemoryLobby();
    const { game, player } = lobby.createGame('Host');
    const other = lobby.joinGame(game.roomCode, 'Bo');
    lobby.setReady(game.id, player.id, true);
    lobby.setReady(game.id, other.player.id, true);
    lobby.startGame(game.id, player.id);

    expect(() => lobby.joinGame(game.roomCode, 'Late')).toThrow(/already started/i);
  });

  it('lets a player switch sides', () => {
    const lobby = createMemoryLobby();
    const { game, player } = lobby.createGame('Host');
    lobby.setRole(game.id, player.id, 'hider');
    expect(lobby.get(game.id)?.players[0]?.role).toBe('hider');
  });

  it('tracks ready state', () => {
    const lobby = createMemoryLobby();
    const { game, player } = lobby.createGame('Host');
    lobby.setReady(game.id, player.id, true);
    expect(lobby.get(game.id)?.players[0]?.ready).toBe(true);
    lobby.setReady(game.id, player.id, false);
    expect(lobby.get(game.id)?.players[0]?.ready).toBe(false);
  });

  it('throws for actions on a missing game or player', () => {
    const lobby = createMemoryLobby();
    const { game, player } = lobby.createGame('Host');
    expect(() => lobby.setReady('nope', player.id, true)).toThrow(/not found/i);
    expect(() => lobby.setRole(game.id, 'ghost', 'hunter')).toThrow(/not found/i);
  });

  it('lets the host set the play area', () => {
    const lobby = createMemoryLobby();
    const { game, player } = lobby.createGame('Host');
    const boundary = { center: { lat: 52.37, lng: 4.9 }, radiusM: 500 };
    lobby.setBoundary(game.id, player.id, boundary);
    expect(lobby.get(game.id)?.boundary).toEqual(boundary);
  });

  it('refuses a non-host setting the play area', () => {
    const lobby = createMemoryLobby();
    const { game } = lobby.createGame('Host');
    const { player: guest } = lobby.joinGame(game.roomCode, 'Guest');
    const boundary = { center: { lat: 0, lng: 0 }, radiusM: 100 };
    expect(() => lobby.setBoundary(game.id, guest.id, boundary)).toThrow(/host/i);
    expect(lobby.get(game.id)?.boundary).toBeUndefined();
  });
});

describe('starting a game', () => {
  function readyRoom() {
    const lobby = createMemoryLobby();
    const { game, player: host } = lobby.createGame('Host');
    const { player: guest } = lobby.joinGame(game.roomCode, 'Guest');
    lobby.setReady(game.id, host.id, true);
    lobby.setReady(game.id, guest.id, true);
    return { lobby, game, host, guest };
  }

  it('lets the host start once everyone is ready', () => {
    const { lobby, game, host } = readyRoom();
    const started = lobby.startGame(game.id, host.id);
    expect(started.status).toBe('active');
    expect(started.startedAt).toBeTypeOf('string');
  });

  it('refuses a non-host', () => {
    const { lobby, game, guest } = readyRoom();
    expect(() => lobby.startGame(game.id, guest.id)).toThrow(/only the host/i);
  });

  it('refuses to start with a lone or unready player', () => {
    const lobby = createMemoryLobby();
    const { game, player } = lobby.createGame('Host');
    lobby.setReady(game.id, player.id, true);
    expect(() => lobby.startGame(game.id, player.id)).toThrow(LobbyError); // only one player

    const { player: guest } = lobby.joinGame(game.roomCode, 'Guest'); // guest not ready
    expect(() => lobby.startGame(game.id, player.id)).toThrow(/readied up/i);
    expect(guest.ready).toBe(false);
  });

  it('cannot start twice', () => {
    const { lobby, game, host } = readyRoom();
    lobby.startGame(game.id, host.id);
    expect(() => lobby.startGame(game.id, host.id)).toThrow(/already started/i);
  });

  it('reports startability with canStart', () => {
    const lobby = createMemoryLobby();
    const { game, player } = lobby.createGame('Host');
    expect(canStart(game)).toBe(false); // one player
    const { player: guest } = lobby.joinGame(game.roomCode, 'Guest');
    expect(canStart(game)).toBe(false); // nobody ready
    lobby.setReady(game.id, player.id, true);
    lobby.setReady(game.id, guest.id, true);
    expect(canStart(game)).toBe(true);
  });

  it('refuses a one-sided room (all hunters or all hiders)', () => {
    const { lobby, game, host, guest } = readyRoom();
    // Both readied up, but the guest flips to hunter — no hider, not playable.
    lobby.setRole(game.id, guest.id, 'hunter');
    expect(canStart(game)).toBe(false);
    expect(() => lobby.startGame(game.id, host.id)).toThrow(/hunter and a hider/i);
  });
});

describe('removePlayer', () => {
  it('deletes the room and frees the code when the last player leaves', () => {
    const lobby = createMemoryLobby();
    const { game, player } = lobby.createGame('Solo');
    expect(lobby.removePlayer(game.id, player.id)).toBeUndefined();
    expect(lobby.get(game.id)).toBeUndefined();
    expect(lobby.getByCode(game.roomCode)).toBeUndefined();
  });

  it('promotes a new host when the host leaves', () => {
    const lobby = createMemoryLobby();
    const { game, player: host } = lobby.createGame('Host');
    const { player: guest } = lobby.joinGame(game.roomCode, 'Guest');

    const after = lobby.removePlayer(game.id, host.id);
    expect(after?.players).toHaveLength(1);
    expect(after?.players[0]?.id).toBe(guest.id);
    expect(after?.players[0]?.isHost).toBe(true);
  });

  it('is a no-op for an unknown game', () => {
    const lobby = createMemoryLobby();
    expect(lobby.removePlayer('nope', 'nobody')).toBeUndefined();
  });
});

describe('normalizeRoomCode', () => {
  it('upper-cases and trims strings, and tolerates non-strings', () => {
    expect(normalizeRoomCode(' ab2c ')).toBe('AB2C');
    expect(normalizeRoomCode(42)).toBe('');
    expect(normalizeRoomCode(undefined)).toBe('');
  });
});
