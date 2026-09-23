// There is no browser in this environment, so the front end cannot be clicked
// through. These tests catch the failures that would otherwise only show up on
// a projector in front of a room: a script reaching for an element the page
// does not contain, a colour token defined in one theme but not the other, or
// user content being written as HTML.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CSS = read('public/css/app.css');

const PAIRS = [
  { html: 'public/index.html', js: 'public/js/home.js' },
  { html: 'public/screen.html', js: 'public/js/screen.js' },
  { html: 'public/join.html', js: 'public/js/join.js' },
];

function idsInHtml(html) {
  return new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
}

function idsQueriedBy(js) {
  const ids = new Set();
  for (const m of js.matchAll(/\$\(\s*['"]#([A-Za-z0-9_-]+)['"]/g)) ids.add(m[1]);
  for (const m of js.matchAll(/getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]/g)) ids.add(m[1]);
  return ids;
}

/** Custom properties declared inside one CSS block. */
function tokensInBlock(selector) {
  const start = CSS.indexOf(selector);
  assert.notEqual(start, -1, `${selector} block is missing`);
  const open = CSS.indexOf('{', start);
  const close = CSS.indexOf('\n}', open);
  const block = CSS.slice(open, close);
  return new Set(Array.from(block.matchAll(/(--[\w-]+)\s*:/g), (m) => m[1]));
}

function classesInHtml(html) {
  const set = new Set();
  for (const m of html.matchAll(/\bclass="([^"]+)"/g)) {
    for (const name of m[1].split(/\s+/)) if (name) set.add(name);
  }
  return set;
}

/** Classes a script builds itself, so they need not exist in the page. */
function classesBuiltBy(js) {
  const set = new Set();
  for (const m of js.matchAll(/class:\s*[`'"]([^`'"$]*)/g)) {
    for (const name of m[1].split(/\s+/)) if (name) set.add(name);
  }
  for (const m of js.matchAll(/classList\.(?:add|toggle|remove)\(\s*['"]([^'"]+)/g)) {
    set.add(m[1]);
  }
  return set;
}

/** The leading class of every class-based selector a script looks up. */
function classesQueriedBy(js) {
  const set = new Set();
  const calls = /(?:\$\$?|querySelector(?:All)?)\(\s*['"`]\.([A-Za-z0-9_-]+)/g;
  for (const m of js.matchAll(calls)) set.add(m[1]);
  return set;
}

for (const { html: htmlPath, js: jsPath } of PAIRS) {
  test(`${path.basename(jsPath)} only reaches for elements ${path.basename(htmlPath)} has`, () => {
    const present = idsInHtml(read(htmlPath));
    const wanted = idsQueriedBy(read(jsPath));
    const missing = Array.from(wanted).filter((id) => !present.has(id));
    assert.deepEqual(missing, [], `missing from ${htmlPath}: ${missing.join(', ')}`);
    assert.ok(wanted.size > 3, 'the scraper should have found real selectors');
  });

  test(`${path.basename(jsPath)} only reaches for classes that exist`, () => {
    // Markup and script drift apart quietly. A class that was removed from the
    // page during a redesign throws on the first click, not at load, so
    // nothing catches it until somebody presses the button.
    const source = read(jsPath);
    const available = new Set([...classesInHtml(read(htmlPath)), ...classesBuiltBy(source)]);
    const missing = Array.from(classesQueriedBy(source)).filter((c) => !available.has(c));
    assert.deepEqual(missing, [], `${jsPath} queries .${missing.join(', .')} which nothing creates`);
  });

  test(`${path.basename(htmlPath)} loads ${path.basename(jsPath)} and its stylesheet`, () => {
    const html = read(htmlPath);
    const scripts = Array.from(html.matchAll(/<script[^>]+src="([^"]+)"/g), (m) => m[1]);
    const styles = Array.from(html.matchAll(/<link[^>]+href="([^"]+\.css)"/g), (m) => m[1]);

    assert.ok(
      scripts.includes(`/${jsPath.replace('public/', '')}`),
      `${htmlPath} should load /${jsPath.replace('public/', '')}`
    );
    for (const href of [...scripts, ...styles]) {
      assert.ok(
        fs.existsSync(path.join(ROOT, 'public', href.replace(/^\//, ''))),
        `${href} referenced by ${htmlPath} does not exist`
      );
    }
  });

  test(`${path.basename(htmlPath)} sets its theme before first paint`, () => {
    const html = read(htmlPath);
    const head = html.slice(0, html.indexOf('</head>'));
    assert.match(
      head,
      /dataset\.theme/,
      'an inline head script must set the theme, or the page flashes the wrong one'
    );
    assert.ok(
      head.includes('<script>'),
      'the theme script has to be inline in the head, not a deferred module'
    );
  });
}

test('every module the client imports exists on disk', () => {
  for (const file of fs.readdirSync(path.join(ROOT, 'public/js'))) {
    const source = read(path.join('public/js', file));
    for (const m of source.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)) {
      const target = path.join(ROOT, 'public/js', m[1]);
      assert.ok(fs.existsSync(target), `${file} imports ${m[1]}, which is missing`);
    }
  }
});

test('every colour literal in the stylesheet is a valid hex value', () => {
  const values = Array.from(CSS.matchAll(/:[^;{}]*?(#[0-9a-zA-Z]+)/g), (m) => m[1]);
  const bad = values.filter((hex) => !/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex));
  assert.deepEqual(bad, [], `malformed colour values: ${bad.join(', ')}`);
  assert.ok(values.length > 30, 'the scraper should have found the palette');
});

test('the stylesheet has no unresolved placeholders', () => {
  assert.equal(/:\s*(TODO|FIXME|undefined|null)\b/i.test(CSS), false);
});

test('every custom property that is used is also defined', () => {
  const defined = new Set(Array.from(CSS.matchAll(/^\s*(--[\w-]+)\s*:/gm), (m) => m[1]));
  const used = new Set(Array.from(CSS.matchAll(/var\(\s*(--[\w-]+)/g), (m) => m[1]));
  const missing = Array.from(used).filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], `undefined custom properties: ${missing.join(', ')}`);
});

test('the dark theme redefines every colour the light theme sets', () => {
  const light = tokensInBlock(':root {');
  const dark = tokensInBlock("[data-theme='dark'] {");

  // Sizes, fonts and per-tile values are deliberately shared. Everything that
  // carries colour has to be restated, or the wall half-inverts.
  const shared = new Set([
    '--r-paper',
    '--r-ui',
    '--serif',
    '--sans',
    '--mono',
    '--grain',
    '--tint',
    '--tilt',
    '--pin',
    '--accent-soft',
  ]);

  const mustOverride = Array.from(light).filter((name) => !shared.has(name));
  const forgotten = mustOverride.filter((name) => !dark.has(name));
  assert.deepEqual(forgotten, [], `the dark theme forgot: ${forgotten.join(', ')}`);

  const orphans = Array.from(dark).filter((name) => !light.has(name));
  assert.deepEqual(orphans, [], `defined only in dark: ${orphans.join(', ')}`);
});

test('the client never writes user content as HTML', () => {
  // Every tile is built with textContent via the el() helper. An innerHTML
  // assignment on anything that came off the socket would be an XSS hole on
  // the one screen everybody in the room is looking at.
  const risky = [];
  for (const file of fs.readdirSync(path.join(ROOT, 'public/js'))) {
    const source = read(path.join('public/js', file));
    for (const m of source.matchAll(/\.(innerHTML|outerHTML)\s*=/g)) risky.push(`${file}: ${m[0]}`);
    for (const m of source.matchAll(/insertAdjacentHTML/g)) risky.push(`${file}: ${m[0]}`);
    for (const m of source.matchAll(/document\.write/g)) risky.push(`${file}: ${m[0]}`);
  }
  assert.deepEqual(risky, [], `unsafe HTML writes: ${risky.join(', ')}`);
});

test('the join page is set up for phones', () => {
  const html = read('public/join.html');
  assert.match(html, /name="viewport"/);
  assert.match(html, /viewport-fit=cover/, 'notched phones need the safe-area opt-in');
  assert.match(html, /accept="image\/\*"/, 'the photo picker should accept images');
  assert.match(html, /capture="environment"/, 'the camera button should open the rear camera');
});

test('the wall keeps its sign, board and controls in one layout', () => {
  const html = read('public/screen.html');
  for (const id of ['qrImg', 'codeBig', 'wall', 'spotlight', 'hostbar', 'btnLights']) {
    assert.match(html, new RegExp(`id="${id}"`), `screen.html needs #${id}`);
  }
});

test('the wall ignores the machine dark mode, the phone follows it', () => {
  // The right setting for a projector depends on the room it is lit for, not
  // on whatever the laptop driving it happens to be set to.
  const wall = read('public/screen.html');
  assert.match(wall, /onescreen\.wall-theme/, 'the wall keeps its own theme preference');
  assert.equal(
    /prefers-color-scheme/.test(wall.slice(0, wall.indexOf('</head>'))),
    false,
    'the wall must not follow the machine setting'
  );

  for (const page of ['public/join.html', 'public/index.html']) {
    assert.match(read(page), /prefers-color-scheme/, `${page} should follow the device`);
  }
});

test('reduced motion is honoured', () => {
  assert.match(CSS, /prefers-reduced-motion/);
  // Tiles hang at an angle by default; with motion reduced they sit straight.
  const block = CSS.slice(CSS.indexOf('prefers-reduced-motion'));
  assert.match(block, /\.tile\s*\{\s*transform:\s*none/);
});
