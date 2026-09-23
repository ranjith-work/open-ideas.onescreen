# OneScreen

One computer opens a room. Everyone scans the QR. Whatever somebody sends —
a photo, a link, an emoji, a scribble, a sentence — appears on the main screen
the moment they send it.

No accounts. No installs. Nothing saved.

```
npm install
npm start
```

Open the address it prints, click **Open a room**, and point phones at the QR.

---

## What it is for

A meeting where you want everyone's answer at once instead of going round the
table. A classroom where thirty students each submit a photo of their work. A
party where the wall fills up with whatever people are looking at. The point is
not the content, which anything can generate. The point is twenty phones and
one screen in the same room at the same moment.

## Design

The product is a physical thing: a board in a room, and pieces of paper people
pin to it. The interface is built from that rather than from a dashboard.

- **Paper and ink.** A warm board, tiles that are sheets of paper on it,
  hairline rules instead of drop shadows, and a single vermilion accent that
  reads as a pin. A serif face carries anything a person wrote; the sans is for
  labels and machinery only.
- **Nothing hangs straight.** Each tile is rotated a fraction of a degree,
  derived from its id rather than random, so it keeps its angle through a
  re-layout instead of twitching.
- **A paper colour per person.** Short messages take a tint keyed to their
  author, so the room can see at a glance who is talking. Photos and link cards
  sit on plain paper, because they bring their own colour.
- **Light by default.** Meeting rooms and classrooms have the lights on, and a
  dark screen in a lit room is a grey smudge. The host drops the lights with
  `D` for an evening or a dark auditorium.
- **The wall and the phone disagree on purpose.** The board ignores the
  laptop's dark mode, because the right setting depends on the room the
  projector is lit for. The phone follows its owner's device, because it is in
  somebody's hand.
- **The board never scrolls.** Newest work is at the top, oldest falls off the
  bottom, and a tile is placed in the shortest column that still has room for
  it rather than simply the shortest one, so a single tall photo does not leave
  a column of empty space.

## How a room works

1. The host machine opens a room and gets a four-character code and a QR.
2. Phones scan the QR, which lands them on a send page. No sign-in, no app.
3. Anything submitted broadcasts to every connected device instantly. The big
   screen shows it full size for a few seconds, then it settles into the wall.
4. The board never scrolls. Newest work sits at the top, oldest falls off the
   bottom, so the screen is always showing the current moment.
5. Close the server and the room is gone. That is the whole data policy.

## What a phone can send

| Kind | Notes |
| --- | --- |
| Text | Up to 600 characters. A message that is only emoji becomes a giant emoji tile. |
| Photo | Camera or library. Resized on the phone before upload, so a 12 MP shot does not stall the room. |
| Drawing | A finger-drawing pad with colours, brush sizes, and undo. |
| Link | Fetched server-side for a title and preview image, if the site offers one. |
| Emoji | Tap to fling one across the screen. Hold to pin it to the wall as a tile. |

## Host controls

Visible only on the machine that opened the room. The control bar sits at the
bottom of the screen and fades until you reach for it.

| Control | Key | What it does |
| --- | --- | --- |
| Prompt | `P` | Edit the question in place. It pushes to every phone. |
| Lock | `L` | Stop new submissions without closing the room. |
| Hide QR | `Q` | Drop the QR panel and give the board the whole screen. |
| Lights | `D` | Switch the board between a lit room and a dark one. |
| Fullscreen | `F` | Standard fullscreen. |
| Save PDF | `S` | Open a print view of everything on the board — choose Save as PDF. No viewport crop; every tile is included. |
| Clear | | Take everything off the board. Asks first. |
| Delete one | | Hover any tile and click the ×. |

Host rights come from a token handed out once, when the room is created, and
kept in that browser's local storage. Anyone else who opens the screen URL sees
the wall but gets no controls. Opening the same screen URL in a different
browser is a view-only wall.

## Getting phones to reach you

This runs on your machine, not in the cloud, so phones need to be on the same
network. The server prints the address to use:

```
  On this computer   http://localhost:4321
  For phones         http://192.168.1.50:4321
```

A QR containing `localhost` would send every phone to its own browser, so
whenever the page is served over loopback the QR is built with the machine's
LAN address instead. If the port is taken, or you want to bind one interface
only:

```
PORT=8080 npm start
HOST=127.0.0.1 npm start
```

Corporate and guest Wi-Fi often use client isolation, which blocks phones from
reaching laptops. If scanning does nothing, that is usually why. A phone
hotspot that the laptop also joins is the quickest way around it.

## Limits

These are deliberate, and all in `server/rooms.js`.

| Limit | Value |
| --- | --- |
| Tiles kept per room | 300, oldest evicted |
| Images per room | 120 MB, oldest evicted |
| Single image | 6 MB after the phone downscales it |
| Text | 600 characters |
| Submissions per device | roughly one every 1.25s, burst of 6 |
| Idle room lifetime | 6 hours with nobody connected |

## Layout

```
server/
  index.js     entry point: binds HTTP + WebSocket, heartbeat, room sweeper
  app.js       HTTP routes, QR generation, LAN address detection
  hub.js       the room protocol: join, submit, host actions, broadcast
  rooms.js     in-memory room store, item and media budgets, expiry
  link.js      link unfurling, with the anti-SSRF guard
  validate.js  input cleaning, image decoding, per-connection rate limit
public/
  index.html   open or join a room
  screen.html  the wall
  join.html    the phone send page
  js/          no framework, no build step
test/
```

There is no build step. The pages are plain HTML, CSS and ES modules, so the
phone starts working the instant the QR resolves.

## Security notes

Everyone in the room is anonymous, so nothing arriving over the socket is
trusted.

- **No HTML from user content.** Every tile is built with `textContent`. A test
  fails the build if `innerHTML` appears in any client script.
- **Link previews are fenced.** Only http and https. Hostnames are resolved
  before the fetch and rejected if any answer is loopback, RFC1918, link-local,
  carrier-grade NAT, or multicast, which keeps the server from being used to
  probe your network or read a cloud metadata endpoint. Redirects are re-checked
  at every hop. Short timeout, small read cap, HTML only.
- **Media is room-scoped.** An image URL includes its room code and is a 404
  from any other room, and from everywhere once the room is gone.
- **Host actions are token-gated,** and a phone is never host even if it somehow
  obtains the token.
- **Per-connection rate limiting** means one enthusiastic device cannot flood
  the wall or evict everyone else's work.

Nothing here is written to disk and nothing leaves the machine except link
preview fetches. Treat a room as visible to anyone on the network who has the
code, because that is exactly what it is.

## Tests

```
npm test
```

103 tests, no network and no browser required. They cover the room store and
its eviction rules, the full socket protocol driven through fake sockets, the
HTTP routes driven through the real Express app, the anti-SSRF guard, input
validation, and a set of static checks on the front end: every element and
every class a script reaches for is something its page or the script itself
creates, every colour token defined for the light theme is redefined for the
dark one, and no client script writes user content as HTML.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4321` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind. Use `127.0.0.1` for a local-only run. |

Behind a reverse proxy, forward `X-Forwarded-Host` and `X-Forwarded-Proto` and
the QR will use the public origin.
