# Server

The authoritative game server: it owns games from their lobby to their end and decides every game outcome.

## Language

### Games

**Game**:
One match, from its creation through its Lobby and play until it ends.
_Avoid_: room, match

**Lobby**:
The phase of a Game before it starts, while players gather, choose roles and get ready.
_Avoid_: waiting room, lobby manager

**Join code**:
The short code players enter to find and join a Game.
_Avoid_: room code, game code

**Boundary**:
The area a Game is played in.
_Avoid_: geofence, play area

**Ping reveal**:
A scheduled moment when every Hider's position is shown to the Hunters.
_Avoid_: ping, reveal (on their own)

**Catch**:
A Hunter's confirmed capture of a Hider within the Catch radius, which turns that Hider into a Hunter.
_Avoid_: tag, capture

**Catch radius**:
The distance within which a Hunter can make a Catch.

**Elimination**:
A player's removal from play for staying outside the Boundary after their warnings are used up.
_Avoid_: kick, disqualification

### Players and access

**Host**:
The player who created the Game.

**Hunter**:
A player trying to catch Hiders.
_Avoid_: seeker

**Hider**:
A player avoiding capture until the Game ends.
_Avoid_: runner

**Seat**:
A player's place in one specific Game, held from joining until leaving or the Game's end, and reclaimable after a dropped connection.
_Avoid_: session, membership

**Grace period**:
How long a dropped Seat is held for its player to reconnect before it is released.
