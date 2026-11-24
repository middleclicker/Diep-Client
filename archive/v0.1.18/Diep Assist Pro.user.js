
 // ==UserScript==
 // @name         Diep Assist Pro
 // @namespace    https://diep.io/
 // @version      0.1.18
 // @description  Entity HUD, mouse control, and configurable ClickGUI
 // @match        *://diep.io/*
 // @match        *://*.diep.io/*
 // @run-at       document-start
 // @sandbox      raw
 // @grant        none
 // @noframes
 // ==/UserScript==

 (function () {
   'use strict';

   if (window.__diepAssistProLoaded) return;
   window.__diepAssistProLoaded = true;

   const VERSION = '0.1.18';
   const STORAGE_KEY = 'diepAssistPro.settings';

   const movementEvents = new Set([
     'mousemove', 'pointermove', 'pointerrawupdate'
   ]);

   const movementKeys = new Set([
     'KeyW', 'KeyA', 'KeyS', 'KeyD',
     'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'
   ]);

   const keyNames = {
     KeyW: ['w', 87],
     KeyA: ['a', 65],
     KeyS: ['s', 83],
     KeyD: ['d', 68],
     ArrowUp: ['ArrowUp', 38],
     ArrowLeft: ['ArrowLeft', 37],
     ArrowDown: ['ArrowDown', 40],
     ArrowRight: ['ArrowRight', 39]
   };

   const mouseButtons = [
     'pointerdown', 'pointerup', 'mousedown', 'mouseup',
     'click', 'dblclick', 'auxclick', 'contextmenu'
   ];

   const settings = {
     menuKey: 'ShiftRight',
     animations: true,
     animationSpeed: 220,
     blur: true,
     outsideClose: true,
     guiMove: false,
     entityHud: true
   };

   try {
     const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');

     if (typeof saved.menuKey === 'string' && saved.menuKey) {
       settings.menuKey = saved.menuKey;
     }
     if ([140, 220, 340].includes(saved.animationSpeed)) {
       settings.animationSpeed = saved.animationSpeed;
     }
     for (const key of Object.keys(settings)) {
       if (typeof settings[key] === 'boolean' && typeof saved[key] === 'boolean') {
         settings[key] = saved[key];
       }
     }
   } catch (error) {
     console.warn('[Diep Assist Pro] Could not read settings:', error);
   }

   /**
    * Saves the user's module and ClickGUI settings.
    */
   function saveSettings() {
     try {
       localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
     } catch (error) {
       console.warn('[Diep Assist Pro] Could not save settings:', error);
     }
   }

   const originalAdd = EventTarget.prototype.addEventListener;
   const originalRemove = EventTarget.prototype.removeEventListener;

   const mouseListeners = [];
   const physicalKeys = new Set();
   const gameKeys = new Set();

   let controlling = false;
   let mouseX = innerWidth / 2;
   let mouseY = innerHeight / 2;
   let aimX = mouseX;
   let aimY = mouseY;

   let menuOpen = false;
   let selectedCategory = 'Render';
   let expandedModule = null;
   let waitingForKey = false;
   let closeTimer = null;
   let gui = null;

   const officialTeams = new Map([
     ['#00b2e1', 'Blue'], ['#f14e54', 'Red'], ['#bf7ff5', 'Purple'], ['#00e16e', 'Green']
   ]);

   /** Read the structured player rows the official custom-server panel renders. */
   function readAdminRoster() {
     const players = [];
     for (const row of document.querySelectorAll('.cs-admin-scroll .cs-admin-player')) {
       const name = row.querySelector('.name');
       const id = /^\((\d+)\)$/.exec(row.querySelector('.player-id')?.textContent.trim() ?? '')?.[1];
       if (!name || id === undefined) continue;
       const plainName = Array.from(name.childNodes).filter(node => node.nodeType === Node.TEXT_NODE)
         .map(node => node.textContent).join('').trim();
       const rgb = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/.exec(
         row.querySelector('.team-dot')?.style.backgroundColor ?? '');
       const hex = rgb ? '#' + rgb.slice(1).map(channel => Number(channel).toString(16).padStart(2, '0')).join('') : '';
       players.push({ id, name: plainName, team: officialTeams.get(hex) ?? null,
         self: row.classList.contains('self'), spectating: Boolean(row.querySelector('.spectating')) });
     }
     const self = players.find(player => player.self);
     return players.map(player => ({ ...player, relation: player.self ? 'self' :
       !self?.team || self.spectating || !player.team || player.spectating ? 'unknown' :
         player.team === self.team ? 'friendly' : 'opposing' }));
   }

   /** Classify frames from an explicit, renderer-independent state provider. */
   function createEntityFeed() {
     const lifetime = 650;
     const kinds = new Map([['tank', 'Tank'], ['bullet', 'Bullet'], ['projectile', 'Projectile'], ['shape', 'Shape']]);
     const knownTeams = Array.from(officialTeams.values());
     let latest;
     let lastTick = -1;

     function id(value) {
       if (value == null) return null;
       if (typeof value === 'string' && value.length <= 64 && value.trim()) return value;
       if (Number.isSafeInteger(value) && value >= 0) return String(value);
       throw new TypeError('Invalid entity-feed ID.');
     }

     function teamName(team) {
       if (team === null) return undefined;
       if (/^[0-3]$/.test(team)) return knownTeams[Number(team)];
       return knownTeams.find(name => name.toLowerCase() === team.toLowerCase()) ?? `Team ${team}`;
     }

     function publish(input) {
       if (!input || input.version !== 1 || !Number.isSafeInteger(input.tick) || input.tick < 0 ||
           !['teams', 'ffa'].includes(input.mode)) throw new TypeError('Invalid entity-feed frame header.');
       if (input.tick <= lastTick) return false;
       const camera = input.camera;
       if (!camera || ![camera.x, camera.y, camera.pixelsPerUnit].every(Number.isFinite) || camera.pixelsPerUnit <= 0 ||
           !Array.isArray(input.players) || input.players.length > 2200 ||
           !Array.isArray(input.entities) || input.entities.length > 2200) throw new TypeError('Invalid entity-feed frame data.');

       const players = new Map();
       for (const player of input.players) {
         const playerId = id(player?.id);
         if (playerId === null || players.has(playerId)) throw new TypeError('Missing or repeated player ID.');
         players.set(playerId, id(player.teamId));
       }
       const localId = id(input.localPlayerId);
       const localTeam = players.get(localId) ?? null;
       const entities = [];
       const ids = new Set();
       function relation(playerId, teamId) {
         if (localId === null) return '';
         if (playerId === localId) return 'self';
         if (input.mode === 'ffa') return playerId === null ? '' : 'opposing';
         return localTeam === null || teamId === null ? '' : teamId === localTeam ? 'friendly' : 'opposing';
       }

       for (const entry of input.entities) {
         const entityId = id(entry?.id);
         if (entityId === null || ids.has(entityId) || !kinds.has(entry.kind) || typeof entry.visible !== 'boolean' ||
             ![entry.x, entry.y, entry.radius].every(Number.isFinite) || entry.radius <= 0) {
           throw new TypeError('Invalid or repeated entity-feed observation.');
         }
         ids.add(entityId);
         if (!entry.visible) continue;
         const playerId = entry.kind === 'tank' ? id(entry.playerId) : null;
         const ownerId = entry.kind === 'bullet' || entry.kind === 'projectile' ? id(entry.ownerId) : null;
         const ownerRelation = relation(ownerId, players.get(ownerId) ?? null);
         const teamId = id(entry.teamId) ?? players.get(playerId ?? ownerId) ?? null;
         const self = playerId !== null && playerId === localId;
         const classifiedRelation = input.mode === 'teams' ? relation(null, teamId) : relation(playerId ?? ownerId, teamId);
         const team = input.mode === 'teams' ? teamName(teamId) : undefined;
         const shooter = ownerId === null ? '' : { self: 'you', friendly: 'teammate', opposing: 'opponent' }[ownerRelation] ?? `player ${ownerId}`;
         const shapeLabel = entry.kind === 'shape' && typeof entry.label === 'string' ? entry.label.trim().slice(0, 64) : '';
         entities.push({ entityId, playerId, ownerId, kind: entry.kind, source: 'telemetry',
           label: self ? 'You' : shapeLabel || kinds.get(entry.kind), self, shooter, team,
           relation: self || classifiedRelation === 'self' ? '' : classifiedRelation,
           x: entry.x, y: entry.y, r: entry.radius });
       }

       lastTick = input.tick;
       latest = { entities, camera: { x: camera.x, y: camera.y, scale: camera.pixelsPerUnit }, expires: performance.now() + lifetime };
       return true;
     }

     function project(width, height) {
       if (!latest || performance.now() >= latest.expires) return null;
       const { x, y, scale } = latest.camera;
       const entities = latest.entities.map(entity => ({ ...entity,
         x: (entity.x - x) * scale + width / 2,
         y: (entity.y - y) * scale + height / 2,
         r: entity.r * scale
       })).filter(entity => Number.isFinite(entity.x + entity.y + entity.r) &&
         entity.x + entity.r >= 0 && entity.y + entity.r >= 0 && entity.x - entity.r <= width && entity.y - entity.r <= height);
       return { entities, expires: latest.expires };
     }

     function reset() {
       latest = undefined;
       lastTick = -1;
     }

     return { publish, project, reset };
   }

   const entityHud = installEntityHud();

   /**
    * Collects geometry from the game's Canvas 2D calls, tracks visible entities,
    * and draws labels on a separate canvas that lets pointer events pass through.
    * Geometry is in game-canvas pixels until drawHud converts it to CSS pixels.
    */
   function installEntityHud() {
     if (typeof CanvasRenderingContext2D !== 'function') {
       return { clear() {}, snapshot: () => [], source: () => 'none', publish: () => false, resetFeed() {} };
     }
     const entityFeed = createEntityFeed();
     const teamColors = new Map([
       ...officialTeams, ['#00b1de', 'Blue'], ['#be7ff5', 'Purple']
     ]);
     const neutralShapes = new Map([
       ['#ffe869', 'Square'], ['#fc7677', 'Triangle'], ['#768dfc', 'Pentagon'],
       ['#f177dd', 'Hexagon'], ['#ff7dc0', 'Crasher']
     ]);
     const tones = { Blue: '#62d8ff', Red: '#ff9296', Purple: '#e0b9ff', Green: '#75f0b5', unknown: '#f7f1cd' };
     const paths = new WeakMap();
     let items = [];
     // A full clear can precede the overlay callback. Retain the preceding batch.
     let completedItems;
     const maximumItems = 2200;
     const fullCircle = Math.PI * 2;
     let gameCanvas;
     let overlay;
     let overlayContext;
     let redraw = 0;
     let clearTimer = 0;
     let previousFrame;
     let tracks = [];
     let nextTrack = 1;
     let visibleEntities = [];
     let markers = [];
     let nextMarker = 1;
     let selectedMode = '';
     let lastLocal;
     let activeSource;
     const labelOffsets = [0, -20, 20, -39, 39];

     function isGameContext(ctx) {
       if (!settings.entityHud || document.hidden) return false;
       const canvas = ctx.canvas;
       if (canvas === overlay || !canvas.isConnected) return false;
       if (canvas === gameCanvas) return true;
       const main = document.getElementById('canvas');
       if (main ? canvas !== main : gameCanvas?.isConnected ||
           canvas.clientWidth < innerWidth * .72 || canvas.clientHeight < innerHeight * .72) return false;
       clearHud();
       gameCanvas = canvas;
       return true;
     }

     function wrapper(name, observe) {
       const prototype = CanvasRenderingContext2D.prototype;
       const original = prototype[name];
       if (typeof original !== 'function') return;
       prototype[name] = function (...args) {
         const result = Reflect.apply(original, this, args);
         try {
           if (isGameContext(this)) observe(this, ...args);
         } catch {
           // Keep the game's draw call result independent of the HUD.
         }
         return result;
       };
     }

     function path(ctx) {
       let current = paths.get(ctx);
       if (!current) {
         current = { parts: [], circles: [], filled: false };
         paths.set(ctx, current);
       }
       return current;
     }

     function point(matrix, x, y) {
       return { x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f };
     }

     function distance(a, b) {
       return Math.hypot(a.x - b.x, a.y - b.y);
     }

     function shape(points, normalizePolygon = false) {
       if (points.length < 3 || points.length > 48) return null;
       const vertices = points.filter((p, i) => i === 0 || distance(p, points[i - 1]) > .2);
       if (vertices.length > 2 && distance(vertices[0], vertices.at(-1)) <= .2) vertices.pop();
       const outline = normalizePolygon ? convexOutline(vertices) : vertices;
       if (outline.length < 3) return null;
       let x = 0;
       let y = 0;
       for (const vertex of outline) {
         x += vertex.x / outline.length;
         y += vertex.y / outline.length;
       }
       const center = { x, y };
       const radii = outline.map(vertex => distance(vertex, center));
       const radius = Math.max(...radii);
       const round = !normalizePolygon && vertices.length >= 10 && Math.min(...radii) >= radius * .91;
       return { ...center, r: radius, points: outline, round };
     }

     function convexOutline(vertices) {
       // Extra points along an edge change as Diep rotates a polygon.
       const sorted = vertices.slice().sort((a, b) => a.x - b.x || a.y - b.y);
       function outerChain(points) {
         const chain = [];
         for (const point of points) {
           while (chain.length > 1) {
             const a = chain[chain.length - 2];
             const b = chain[chain.length - 1];
             const turn = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
             if (turn > .05) break;
             chain.pop();
           }
           chain.push(point);
         }
         chain.pop();
         return chain;
       }
       return outerChain(sorted).concat(outerChain(sorted.reverse()));
     }

     function rectPoints(matrix, x, y, w, h) {
       return [point(matrix, x, y), point(matrix, x + w, y),
         point(matrix, x + w, y + h), point(matrix, x, y + h)];
     }

     function paintColor(ctx) {
       if (typeof ctx.fillStyle !== 'string') return null;
       const value = ctx.fillStyle.toLowerCase();
       if (/^#[\da-f]{6}$/.test(value) && ctx.globalAlpha >= .45) return value;
       const match = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/.exec(value);
       if (!match || ctx.globalAlpha * Number(match[4] ?? 1) < .45) return null;
       return '#' + match.slice(1, 4).map(part => Number(part).toString(16).padStart(2, '0')).join('');
     }

     function gray(color) {
       return color.slice(1, 3) === color.slice(3, 5) && color.slice(1, 3) === color.slice(5, 7);
     }

     function push(ctx, geometry, color) {
       if (!color || !geometry || items.length >= maximumItems) return;
       const { x, y, r } = geometry;
       if (!Number.isFinite(x + y + r) || r < 2 || r > Math.min(ctx.canvas.width, ctx.canvas.height) * .22 ||
           x + r < 0 || y + r < 0 || x - r > ctx.canvas.width || y - r > ctx.canvas.height) return;
       items.push({ ...geometry, color, team: teamColors.get(color), index: items.length });
       if (!redraw) redraw = requestAnimationFrame(drawHud);
     }

     function recordCircle(ctx, x, y, rx, ry, start, end) {
       if (Math.abs(end - start) < 6.15 || !rx || !ry) return;
       const current = path(ctx);
       if (current.circles.length >= 2) return;
       const matrix = ctx.getTransform();
       const sx = Math.hypot(matrix.a, matrix.b) * rx;
       const sy = Math.hypot(matrix.c, matrix.d) * ry;
       if (Math.min(sx, sy) < Math.max(sx, sy) * .81) return;
       current.circles.push({ ...point(matrix, x, y), r: (sx + sy) / 2, round: true });
     }

     wrapper('beginPath', ctx => paths.set(ctx, { parts: [], circles: [], filled: false }));
     wrapper('moveTo', (ctx, x, y) => {
       const current = path(ctx);
       if (current.parts.length < 32) current.parts.push([point(ctx.getTransform(), x, y)]);
     });
     function recordVertex(ctx, x, y) {
       const current = path(ctx);
       if (!current.parts.length) current.parts.push([]);
       const vertices = current.parts.at(-1);
       if (vertices.length < 49) vertices.push(point(ctx.getTransform(), x, y));
     }
     function recordRect(ctx, x, y, w, h) {
       const current = path(ctx);
       if (current.parts.length < 32) current.parts.push(rectPoints(ctx.getTransform(), x, y, w, h));
     }
     wrapper('lineTo', recordVertex);
     wrapper('arcTo', recordVertex);
     wrapper('rect', recordRect);
     wrapper('roundRect', recordRect);
     wrapper('arc', (ctx, x, y, r, start, end) => recordCircle(ctx, x, y, r, r, start, end));
     wrapper('ellipse', (ctx, x, y, rx, ry, rotation, start, end) => recordCircle(ctx, x, y, rx, ry, start, end));
     wrapper('fill', (ctx, rule) => {
       if (rule !== undefined && typeof rule !== 'string') return;
       const current = path(ctx);
       if (current.filled) return;
       const color = paintColor(ctx);
       if (!color) return;
       current.filled = true;
       if (current.circles.length === 1) push(ctx, current.circles[0], color);
       if (current.circles.length === 0) {
         const normalizePolygon = neutralShapes.has(color);
         for (const part of current.parts) push(ctx, shape(part, normalizePolygon), color);
       }
     });
     wrapper('fillRect', (ctx, x, y, w, h) => {
       const color = paintColor(ctx);
       if (!color || (!teamColors.has(color) && !gray(color))) return;
       push(ctx, shape(rectPoints(ctx.getTransform(), x, y, w, h)), color);
     });
     wrapper('clearRect', (ctx, x, y, w, h) => {
       const matrix = ctx.getTransform();
       if (Math.abs(w * matrix.a) < ctx.canvas.width * .9 || Math.abs(h * matrix.d) < ctx.canvas.height * .9) return;
       if (items.length) {
         completedItems = items;
         items = [];
       }
       paths.delete(ctx);
       if (!redraw) redraw = requestAnimationFrame(drawHud);
     });

     function barrelGeometry(item) {
       if (item.points?.length !== 4 || !gray(item.color)) return null;
       const intensity = parseInt(item.color.slice(1, 3), 16);
       if (intensity < 110 || intensity > 190) return null;
       const corners = item.points;
       const first = distance(corners[0], corners[1]);
       const second = distance(corners[1], corners[2]);
       const length = Math.max(first, second);
       const width = Math.min(first, second);
       if (width < 3 || length < width * 1.22 || length > width * 7) return null;
       const shift = first > second ? 1 : 0;
       function midpoint(index) {
         const a = corners[index];
         const b = corners[(index + 1) % 4];
         return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
       }
       return { ends: [midpoint(shift), midpoint(shift + 2)], width, length, index: item.index };
     }

     function associateBarrels(bodies, barrels) {
       for (const barrel of barrels) {
         let best;
         let bestScore = Infinity;
         for (const body of bodies) {
           if (barrel.width > body.r * 1.65 || barrel.length < body.r * .55 || barrel.length > body.r * 3.4) continue;
           const [a, b] = barrel.ends;
           const near = distance(body, a) < distance(body, b) ? a : b;
           const tip = near === a ? b : a;
           const overlap = distance(body, near) / body.r;
           const reach = distance(body, tip) / body.r;
           const cross = Math.abs((tip.x - near.x) * (body.y - near.y) - (tip.y - near.y) * (body.x - near.x));
           if (overlap > 1.07 || reach < .96 || reach > 3.7 || cross > barrel.length * body.r * .66) continue;
           const order = Math.abs(body.index - barrel.index);
           const score = overlap + cross / (barrel.length * body.r) * 1.5 + Math.min(order, 100) * .007;
           if (score < bestScore) {
             best = { body, tip, angle: Math.atan2(tip.y - near.y, tip.x - near.x) };
             bestScore = score;
           }
         }
         if (best) {
           const { body, tip, angle } = best;
           body.muzzles.push({ tip, angle });
         }
       }
     }

     function modeKind(value) {
       const normalized = String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
       if (/^(ffa|freeforall)$/.test(normalized)) return 'ffa';
       if (/^(teams|teamdm|tdm|[24](teams|tdm)|teams[24])$/.test(normalized)) return 'teams';
       return '';
     }

     function rememberMode() {
       // The spawn menu is removed when the match starts.
       const selection = document.querySelector('.gamemode-selector .selected');
       if (selection) selectedMode = modeKind(selection.dataset.value) || modeKind(selection.textContent.trim());
     }

     function localTank(tanks, candidates, center, ratio, mode, timestamp) {
       if (lastLocal && timestamp - lastLocal.timestamp < 180) {
         const nearby = candidates.filter(body =>
           (body.team === lastLocal.paint || body.color === '#ffffff') &&
           Math.abs(body.r - lastLocal.r) < Math.max(3 * ratio, lastLocal.r * .28) &&
           distance(body, lastLocal) < Math.max(12 * ratio, body.r * 1.25) &&
           distance(body, center) < Math.max(50 * ratio, body.r * 2.4));
         if (nearby.length === 1) return nearby[0];
       }

       const centered = tanks.filter(tank => distance(tank, center) < Math.max(5 * ratio, tank.r * .5));
       if (centered.length === 1) return centered[0];
       if (mode === 'ffa') {
         const blue = tanks.filter(tank => tank.team === 'Blue' && distance(tank, center) < tank.r * 2.1);
         if (blue.length === 1) return blue[0];
       }
       return null;
     }

     function findEntities(draws, width, height, ratio, timestamp) {
       const bodies = [];
       const barrels = [];
       const scenery = [];
       for (const item of draws) {
         const label = item.points && neutralShapes.get(item.color);
         if (label) {
           if (!scenery.some(shape => shape.label === label && distance(shape, item) < 1.8 * ratio &&
             Math.abs(shape.r - item.r) < 2.5 * ratio)) scenery.push({ ...item, kind: 'shape', label });
         } else if (item.team || (item.round && gray(item.color))) {
           const prior = bodies.at(-1);
           if (prior?.round && item.round && prior.color === item.color &&
               Math.abs(item.r - prior.r) < prior.r * .3 && distance(prior, item) < 1.2 * ratio) continue;
           bodies.push({ ...item, muzzles: [] });
         } else {
           const barrel = barrelGeometry(item);
           if (barrel) barrels.push(barrel);
         }
       }

       const tankCandidates = bodies.filter(body => body.r >= 8 * ratio && (body.round || body.points?.length <= 5));
       // A barrel can precede or follow its body in the game's draw order.
       associateBarrels(tankCandidates, barrels);
       const tanks = tankCandidates.filter(body => body.muzzles.length);
       if (previousFrame && timestamp - previousFrame.timestamp < 115) {
         for (const tank of tanks) {
           if (tank.color !== '#ffffff') continue;
           const matches = previousFrame.tanks.filter(old => old.paint &&
             distance(tank, old) < tank.r * .45 && Math.abs(tank.r - old.r) < tank.r * .18);
           if (matches.length === 1) tank.team = matches[0].paint;
         }
       }
       const center = { x: width / 2, y: height / 2 };
       const common = window.__common__;
       const mode = modeKind(common?.active_gamemode ?? common?.gamemode) || selectedMode;
       const local = localTank(tanks, tankCandidates, center, ratio, mode, timestamp);
       const localPaint = local?.team ?? lastLocal?.paint;
       if (local) lastLocal = { x: local.x, y: local.y, r: local.r, paint: localPaint, timestamp };
       const standardRadius = local?.r ?? Math.max(12 * ratio, ...tanks.map(tank => tank.r));
       const ffa = mode === 'ffa';
       const entities = [];
       for (const item of bodies) {
         const hasBarrel = item.muzzles.length > 0;
         const tankSized = item.r >= standardRadius * .65;
         if (item === local || (hasBarrel && (!local || item.r >= standardRadius * .38))) {
           item.kind = 'tank';
           item.label = item === local ? 'You (inferred)' : ffa && local ? 'Opponent' : 'Tank';
         } else if (tankSized && item.round && item.team && item.r >= 9 * ratio) {
           item.kind = 'tank?';
           item.label = 'Tank?';
         } else if (!hasBarrel && (item.team || (item.round && gray(item.color))) &&
             item.r >= 2 * ratio && item.r < standardRadius * .65 &&
             !tanks.some(tank => distance(tank, item) < tank.r * .72)) {
           item.kind = item.round && item.team ? 'bullet' : 'projectile';
           item.label = item.kind === 'bullet' ? 'Bullet' : 'Projectile?';
         } else {
           continue;
         }
         item.self = local === item;
         item.paint = item.team ?? (item.self ? localPaint : undefined);
         item.relation = mode !== 'teams' || !local || !localPaint || !item.paint || item.self ? '' :
           item.paint === localPaint ? 'likely friendly' : 'likely opposing';
         item.team = mode === 'teams' ? item.paint : undefined;
         entities.push(item);
       }
       return { entities, scenery, local, ffa };
     }

     function attachProjectiles(scene, timestamp, ratio) {
       // A possible shooter is recorded at the first sighting. Motion in a
       // later frame must align with exactly one of those visible muzzles.
       const recent = previousFrame && timestamp - previousFrame.timestamp < 150;
       if (!recent) tracks = [];
       const next = [];
       const available = new Set(tracks);
       const now = scene.entities.filter(item => item.kind === 'bullet' || item.kind === 'projectile');
       const tanks = scene.entities.filter(item => item.kind === 'tank');
       for (const item of now) {
         let track;
         let nearest = Infinity;
         for (const old of available) {
           if (old.color !== item.color || Math.abs(item.r - old.r) > Math.max(2 * ratio, item.r * .3)) continue;
           const dt = Math.max(.6, (timestamp - old.seenAt) / 16.7);
           const predicted = { x: old.x + old.vx * dt, y: old.y + old.vy * dt };
           const gap = distance(item, predicted);
           if (gap < nearest && gap < Math.max(item.r * 2, 18 * ratio * Math.min(3, dt))) {
             nearest = gap;
             track = old;
           }
         }
         if (track) {
           available.delete(track);
           const dt = Math.max(.6, (timestamp - track.seenAt) / 16.7);
           const vx = (item.x - track.x) / dt;
           const vy = (item.y - track.y) / dt;
           const speed = Math.hypot(vx, vy);
           if (track.candidates && speed > 1.2 * ratio) {
             const compatible = track.candidates.filter(candidate =>
               (candidate.dx * vx + candidate.dy * vy) / speed > .89);
             if (compatible.length === 1) track.shooter = compatible[0].label;
             track.candidates = null;
           }
           Object.assign(track, { x: item.x, y: item.y, r: item.r, vx, vy, seenAt: timestamp, missed: false });
           track.motionSeen ||= speed > .65 * ratio;
         } else {
           const candidates = [];
           if (recent && item.kind === 'bullet') {
             for (const tank of tanks) {
               if (tank.color !== item.color) continue;
               let match;
               for (const muzzle of tank.muzzles) {
                 const dx = Math.cos(muzzle.angle);
                 const dy = Math.sin(muzzle.angle);
                 const ox = item.x - muzzle.tip.x;
                 const oy = item.y - muzzle.tip.y;
                 const along = ox * dx + oy * dy;
                 const across = Math.abs(ox * dy - oy * dx);
                 if (along >= -item.r * 1.25 && along <= Math.max(item.r * 3, 12 * ratio) &&
                     across <= Math.max(item.r * .8, 3 * ratio) && distance(item, tank) > tank.r * .92) {
                   match = { dx, dy, label: tank.self ? 'you' : tank.relation === 'likely friendly' ? 'teammate' :
                     tank.relation === 'likely opposing' || (scene.ffa && scene.local) ? 'opponent' : '' };
                   break;
                 }
               }
               if (match) candidates.push(match);
             }
           }
           track = { x: item.x, y: item.y, r: item.r, color: item.color, vx: 0, vy: 0,
             seenAt: timestamp, missed: false, motionSeen: false, id: nextTrack++,
             candidates: candidates.length ? candidates : null, shooter: '' };
         }
         item.shooter = track.shooter;
         item.motionSeen = track.motionSeen;
         item.track = track.id;
         next.push(track);
       }
       for (const track of available) {
         if (track.missed || timestamp - track.seenAt > 90) continue;
         track.missed = true;
         next.push(track);
       }
       tracks = next;
       previousFrame = { timestamp, tanks };
     }

     function createOverlay() {
       overlay = document.createElement('canvas');
       overlay.id = 'dap-entity-hud';
       overlay.setAttribute('aria-hidden', 'true');
       overlay.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;display:none';
       document.body.appendChild(overlay);
       overlayContext = overlay.getContext('2d');
     }

     function gameScreenVisible() {
       const visible = id => Boolean(document.getElementById(id)?.getClientRects().length);
       if (visible('spawn-button')) {
         rememberMode();
         return false;
       }
       return !visible('game-over-continue');
     }

     function clearHud() {
       if (redraw) cancelAnimationFrame(redraw);
       clearTimeout(clearTimer);
       redraw = 0;
       tracks = [];
       items.length = 0;
       completedItems = undefined;
       markers = [];
       previousFrame = undefined;
       lastLocal = undefined;
       activeSource = undefined;
       visibleEntities = [];
       if (overlay) overlay.style.display = 'none';
     }

     function drawHud(timestamp) {
       redraw = 0;
       // A data provider may publish before the game canvas has drawn anything.
       if (!gameCanvas?.isConnected) {
         const canvas = document.getElementById('canvas');
         if (canvas instanceof HTMLCanvasElement) gameCanvas = canvas;
       }
       if (!settings.entityHud || !gameCanvas?.isConnected || !document.body || !gameScreenVisible()) {
         clearHud();
         return;
       }
       const rect = gameCanvas.getBoundingClientRect();
       if (!rect.width || !rect.height) {
         clearHud();
         return;
       }
       // A full clear can run before the overlay callback. Keep the previous
       // batch so the callback never replaces it with a cleared canvas.
       const draws = items.length ? items : completedItems;
       const telemetry = entityFeed.project(rect.width, rect.height);
       if (!draws?.length && !telemetry) {
         if (activeSource === 'telemetry') clearHud();
         return;
       }
       const source = telemetry ? 'telemetry' : 'canvas';
       if (activeSource !== source) {
         markers = [];
         tracks = [];
         previousFrame = undefined;
         lastLocal = undefined;
         activeSource = source;
       }
       items = [];
       completedItems = undefined;
       if (!overlay) createOverlay();
       const ctx = overlayContext;
       const density = Math.min(devicePixelRatio || 1, 2);
       const width = Math.round(rect.width * density);
       const height = Math.round(rect.height * density);
       if (overlay.width !== width || overlay.height !== height) {
         overlay.width = width;
         overlay.height = height;
       }
       overlay.style.left = `${rect.left}px`;
       overlay.style.top = `${rect.top}px`;
       overlay.style.width = `${rect.width}px`;
       overlay.style.height = `${rect.height}px`;
       overlay.style.display = 'block';
       ctx.setTransform(density, 0, 0, density, 0, 0);
       ctx.clearRect(0, 0, rect.width, rect.height);

       if (telemetry) {
         visibleEntities = telemetry.entities;
       } else {
         const sx = rect.width / gameCanvas.width;
         const sy = rect.height / gameCanvas.height;
         const ratio = 1 / Math.max(.001, sx);
         const scene = findEntities(draws, gameCanvas.width, gameCanvas.height, ratio, timestamp);
         attachProjectiles(scene, timestamp, ratio);
         const projectiles = scene.entities.filter(item => item.kind === 'bullet' || item.kind === 'projectile');
         const tankLabels = scene.entities.filter(item => item.kind === 'tank' || item.kind === 'tank?');
         const observedProjectiles = projectiles.filter(item => item.motionSeen || item.shooter);
         visibleEntities = [...tankLabels, ...observedProjectiles, ...scene.scenery].map(item => ({
           ...item, x: item.x * sx, y: item.y * sy, r: item.r * sx
         }));
       }
       updateMarkers(visibleEntities, timestamp);
       drawMarkers(ctx, rect.width, rect.height, markers);
       clearTimeout(clearTimer);
       clearTimer = telemetry
         ? setTimeout(scheduleRedraw, Math.max(1, telemetry.expires - performance.now() + 1))
         : setTimeout(clearHud, 450);
     }

     function scheduleRedraw() {
       if (!redraw && settings.entityHud && !document.hidden) redraw = requestAnimationFrame(drawHud);
     }

     function markerGroup(item) {
       if (item.kind.startsWith('tank')) return 0;
       return item.kind === 'shape' ? 2 : 1;
     }

     function updateMarkers(objects, timestamp) {
       // Keep display slots and brief missed detections in the overlay state.
       // visibleEntities() reports the observations from the latest frame.
       const available = new Set(markers);
       const updated = [];
       for (const item of objects) {
         const group = markerGroup(item);
         let best;
         let nearest = Math.max(group === 1 ? 18 : 10, item.r * .65);
         for (const old of available) {
           if (timestamp - old.seenAt > 130 || markerGroup(old) !== group) continue;
           if (item.entityId !== undefined) {
             if (item.entityId !== old.entityId) continue;
             best = old;
             break;
           }
           if (group === 2 && old.label !== item.label) continue;
           if (old.color !== item.color && !(group === 0 &&
               (old.color === '#ffffff' || item.color === '#ffffff'))) continue;
           if (item.track && item.track === old.track) {
             best = old;
             break;
           }
           const gap = distance(item, old);
           if (gap < nearest && Math.abs(item.r - old.r) < Math.max(3, item.r * .26)) {
             nearest = gap;
             best = old;
           }
         }

         if (best) available.delete(best);
         const marker = { ...item, markerId: best?.markerId ?? nextMarker++, seenAt: timestamp,
           confirmedAt: item.kind === 'tank' ? timestamp : best?.confirmedAt,
           slot: best?.slot, missed: false };
         if (item.kind === 'tank?' && best?.kind === 'tank' && timestamp - best.confirmedAt <= 100) {
           Object.assign(marker, { kind: best.kind, label: best.label, self: best.self, relation: best.relation });
         }
         updated.push(marker);
       }
       // A complete state-provider frame removes a vanished ID immediately.
       for (const old of activeSource === 'canvas' ? available : []) {
         if (old.missed || timestamp - old.seenAt > 85) continue;
         updated.push({ ...old, missed: true });
       }
       markers = updated.sort((a, b) => markerGroup(a) - markerGroup(b) || a.markerId - b.markerId);
     }

     function drawMarkers(ctx, width, height, objects) {
       const used = [];
       const tanks = objects.filter(item => markerGroup(item) === 0);
       const labelMax = 90;
       ctx.font = '600 11px system-ui, sans-serif';
       ctx.textBaseline = 'middle';
       for (const item of objects) {
         const color = tones[item.team ?? item.paint] ?? tones.unknown;
         const r = item.r + 2.2;
         ctx.beginPath();
         ctx.arc(item.x, item.y, r, 0, fullCircle);
         ctx.lineWidth = item.kind.startsWith('tank') ? 1.8 : 1.1;
         ctx.strokeStyle = color;
         ctx.globalAlpha = item.kind === 'shape' ? .65 : .9;
         ctx.stroke();
         ctx.globalAlpha = 1;
         if (used.length >= labelMax) continue;
         const parts = [item.label];
         if (item.team) parts.push(item.team);
         else if (item.paint) parts.push(`${item.paint} paint`);
         else if (item.kind === 'bullet' || item.kind === 'projectile') parts.push('team unknown');
         if (item.relation) parts.push(item.relation);
         if (item.shooter) parts.push(`${item.source === 'telemetry' ? 'from' : 'likely from'} ${item.shooter}`);
         const label = parts.join(' · ');
         const tw = ctx.measureText(label).width + 12;
         function position(slot) {
           const x = slot % 2 ? item.x - r - 6 - tw : item.x + r + 6;
           return { x, y: item.y + labelOffsets[slot >> 1] - 8 };
         }
         function fits(slot, margin) {
           const { x, y } = position(slot);
           return x >= 2 && x + tw <= width - 2 && y >= 2 && y + 16 <= height - 2 &&
             !used.some(other => x < other.x + other.w + margin && x + tw + margin > other.x &&
               Math.abs(y - other.y) < 16 + margin) &&
             !tanks.some(other => x < other.x + other.r + margin && x + tw > other.x - other.r - margin &&
               y < other.y + other.r && y + 16 > other.y - other.r);
         }
         // Keep the previous side/height through small overlaps. New labels use
         // more space, so minor motion does not repeatedly switch the slot.
         let slot = item.slot;
         if (!(slot >= 0 && fits(slot, -2))) {
           for (slot = 0; slot < labelOffsets.length * 2 && !fits(slot, 3); slot++) { /* find space */ }
         }
         if (slot >= labelOffsets.length * 2) continue;
         item.slot = slot;
         const { x, y } = position(slot);
         used.push({ x, y, w: tw });
         const boxEdge = { x: x > item.x ? x : x + tw, y: Math.max(y + 2, Math.min(y + 14, item.y)) };
         const gap = distance(item, boxEdge);
         ctx.beginPath();
         ctx.moveTo(item.x + (boxEdge.x - item.x) * r / gap, item.y + (boxEdge.y - item.y) * r / gap);
         ctx.lineTo(boxEdge.x, boxEdge.y);
         ctx.lineWidth = 1;
         ctx.stroke();
         ctx.fillStyle = 'rgba(13, 20, 29, .9)';
         ctx.beginPath();
         ctx.roundRect(x, y, tw, 16, 4);
         ctx.fill();
         ctx.fillStyle = color;
         ctx.fillText(label, x + 6, y + 8);
       }
     }

     document.addEventListener('visibilitychange', clearHud);
     document.addEventListener('click', event => {
       if (event.target instanceof Element && event.target.closest('#spawn-button')) rememberMode();
     }, true);
     return {
       clear: clearHud,
       source: () => activeSource ?? 'none',
       publish: frame => {
         const accepted = entityFeed.publish(frame);
         if (accepted) scheduleRedraw();
         return accepted;
       },
       resetFeed: () => {
         entityFeed.reset();
         scheduleRedraw();
       },
       snapshot: () => visibleEntities.map(({ kind, label, team, paint, relation, self, shooter, x, y, r,
         source = 'canvas', entityId, playerId, ownerId }) =>
         ({ kind, label, team: team ?? 'unknown', paint: paint ?? 'unknown', relation: relation || 'unknown', self: Boolean(self),
           shooter: shooter ? (source === 'telemetry' ? shooter : `likely ${shooter}`) : 'unknown', x, y, radius: r, source,
           ...(source === 'telemetry' ? { entityId, playerId, ownerId } : {}) }))
     };
   }

   /**
    * Normalizes the capture flag used to identify DOM listeners.
    *
    * @param {boolean|AddEventListenerOptions} [options]
    * @returns {boolean}
    */
   function captureFlag(options) {
     return typeof options === 'boolean'
       ? options
       : Boolean(options?.capture);
   }

   /**
    * Captures the game's registered mouse movement listeners.
    */
   EventTarget.prototype.addEventListener = function (type, listener, options) {
     if (
       movementEvents.has(type) &&
       listener &&
       (this === window ||
        this === document ||
        this instanceof HTMLCanvasElement)
     ) {
       const capture = captureFlag(options);

       const exists = mouseListeners.some(entry =>
         entry.target === this &&
         entry.type === type &&
         entry.listener === listener &&
         entry.capture === capture
       );

       if (!exists) {
         mouseListeners.push({
           target: this,
           type,
           listener,
           capture
         });
       }
     }

     return originalAdd.call(this, type, listener, options);
   };

   /**
    * Removes captured handlers when the game unregisters them.
    */
   EventTarget.prototype.removeEventListener = function (type, listener, options) {
     if (movementEvents.has(type)) {
       const capture = captureFlag(options);

       for (let i = mouseListeners.length - 1; i >= 0; i--) {
         const entry = mouseListeners[i];

         if (
           entry.target === this &&
           entry.type === type &&
           entry.listener === listener &&
           entry.capture === capture
         ) {
           mouseListeners.splice(i, 1);
         }
       }
     }

     return originalRemove.call(this, type, listener, options);
   };

   /**
    * Creates an event for direct delivery to game mouse handlers.
    *
    * Coordinates are relative to the browser viewport.
    * The proxy cannot make an event genuinely browser-trusted.
    *
    * @param {string} type
    * @param {number} x
    * @param {number} y
    * @param {EventTarget} canvas
    * @param {EventTarget} currentTarget
    * @returns {MouseEvent|PointerEvent}
    */
   function createMouseEvent(type, x, y, canvas, currentTarget) {
     const rect = canvas instanceof Element
       ? canvas.getBoundingClientRect()
       : null;

     const options = {
       clientX: x,
       clientY: y,
       screenX: window.screenX + x,
       screenY: window.screenY + y,
       bubbles: true,
       cancelable: true,
       view: window
     };

     const event = type === 'mousemove'
       ? new MouseEvent(type, options)
       : new PointerEvent(type, {
           ...options,
           pointerId: 1,
           pointerType: 'mouse',
           isPrimary: true
         });

     return new Proxy(event, {
       get(target, name) {
         if (name === 'isTrusted') return true;
         if (name === 'target' || name === 'srcElement') return canvas;
         if (name === 'currentTarget') return currentTarget;
         if (name === 'offsetX') return x - (rect?.left ?? 0);
         if (name === 'offsetY') return y - (rect?.top ?? 0);

         const value = Reflect.get(target, name, target);

         return typeof value === 'function'
           ? value.bind(target)
           : value;
       }
     });
   }

   /**
    * Sends viewport coordinates to the game's movement handlers.
    *
    * @param {number} x
    * @param {number} y
    */
   function sendMouse(x, y) {
     const canvas = document.querySelector('canvas#canvas') ||
                    document.querySelector('canvas');

     for (const { target, type, listener } of [...mouseListeners]) {
       const event = createMouseEvent(
         type, x, y, canvas || target, target
       );

       try {
         if (typeof listener === 'function') {
           listener.call(target, event);
         } else {
           listener.handleEvent(event);
         }
       } catch (error) {
         console.error('[Diep Assist Pro] Mouse handler failed:', error);
       }
     }

     for (const target of [canvas, document, window]) {
       if (target && typeof target.onmousemove === 'function') {
         target.onmousemove(
           createMouseEvent('mousemove', x, y, canvas || target, target)
         );
       }
     }
   }

   /**
    * Takes control of the game's mouse position.
    *
    * @param {number} x
    * @param {number} y
    */
   function move(x, y) {
     if (!Number.isFinite(x) || !Number.isFinite(y)) {
       throw new TypeError('Mouse coordinates must be finite numbers.');
     }

     aimX = x;
     aimY = y;
     controlling = true;

     sendMouse(x, y);
     updateMouseModule();
   }

   /**
    * Restores the physical mouse position.
    */
   function release() {
     if (!controlling) return;

     controlling = false;
     sendMouse(mouseX, mouseY);
     updateMouseModule();
   }

   /**
    * Tracks physical mouse movement while preventing it from
    * overriding scripted mouse control.
    *
    * @param {MouseEvent|PointerEvent} event
    */
   function onPhysicalMove(event) {
     if (!event.isTrusted) return;

     mouseX = event.clientX;
     mouseY = event.clientY;

     if (!controlling && !menuOpen) return;
     if (menuOpen && gui?.window.contains(event.target)) return;

     event.stopImmediatePropagation();
   }

   /**
    * Blocks game clicks while the mouse is grabbed or GUI is open.
    *
    * @param {MouseEvent|PointerEvent} event
    */
   function onMouseButton(event) {
     if (gui?.root.contains(event.target)) return;
     if (!controlling && !menuOpen) return;

     event.preventDefault();
     event.stopImmediatePropagation();
   }

   for (const type of movementEvents) {
     originalAdd.call(window, type, onPhysicalMove, true);
   }

   for (const type of mouseButtons) {
     originalAdd.call(window, type, onMouseButton, true);
   }

   /**
    * Sends a synthetic movement-key event to the game.
    *
    * @param {'keydown'|'keyup'} type
    * @param {string} code
    */
   function sendGameKey(type, code) {
     const [key, keyCode] = keyNames[code];

     const event = new KeyboardEvent(type, {
       key,
       code,
       bubbles: true,
       cancelable: true
     });

     Object.defineProperties(event, {
       keyCode: { value: keyCode },
       which: { value: keyCode }
     });

     const canvas = document.querySelector('canvas#canvas') ||
                    document.body ||
                    document;

     canvas.dispatchEvent(event);
   }

   /**
    * Returns whether an element is accepting typed text or
    * keyboard-based selection.
    *
    * Checkboxes and other non-text controls must not block
    * GUI Move simply because they have keyboard focus.
    *
    * @param {EventTarget|null} target
    * @returns {boolean}
    */
   function editableTarget(target) {
     if (!(target instanceof Element)) return false;

     const field = target.closest(
       'input, textarea, select, [contenteditable="true"]'
     );

     if (!field) return false;

     if (field.matches('textarea, select, [contenteditable="true"]')) {
       return true;
     }

     if (field instanceof HTMLInputElement) {
       return ![
         'checkbox', 'radio', 'range', 'button',
         'submit', 'reset', 'color', 'file', 'hidden'
       ].includes(field.type);
     }

     return false;
   }

   /**
    * Checks whether the game should currently receive
    * movement-key input.
    *
    * @returns {boolean}
    */
   function movementAllowed() {
     return !menuOpen ||
       (settings.guiMove && !editableTarget(document.activeElement));
   }

   /**
    * Synchronizes game movement state with physically held keys.
    *
    * Called when opening/closing the GUI, changing GUI Move,
    * or entering/leaving a text-editing field.
    */
   function syncMovementKeys() {
     const allowed = movementAllowed();

     for (const code of movementKeys) {
       const needed = allowed && physicalKeys.has(code);

       if (gameKeys.has(code) && !needed) {
         sendGameKey('keyup', code);
         gameKeys.delete(code);
       } else if (needed && !gameKeys.has(code)) {
         sendGameKey('keydown', code);
         gameKeys.add(code);
       }
     }
   }

   /**
    * Handles the ClickGUI keybind and physical movement-key state.
    *
    * @param {KeyboardEvent} event
    */
   function onKeyDown(event) {
     if (!event.isTrusted) return;

     if (waitingForKey) {
       event.preventDefault();
       event.stopImmediatePropagation();

       if (event.repeat) return;

       waitingForKey = false;

       if (event.code !== 'Escape') {
         if (movementKeys.has(event.code)) {
           updateKeybindButton('Movement keys cannot open ClickGUI');
           return;
         }

         settings.menuKey = event.code;
         saveSettings();
       }

       updateKeybindButton();
       return;
     }

     if (
       event.code === settings.menuKey &&
       !event.repeat &&
       !editableTarget(event.target)
     ) {
       event.preventDefault();
       event.stopImmediatePropagation();
       setMenuOpen(!menuOpen);
       return;
     }

     if (
       event.code === 'Escape' &&
       menuOpen &&
       !editableTarget(event.target)
     ) {
       event.preventDefault();
       event.stopImmediatePropagation();
       setMenuOpen(false);
       return;
     }

     if (movementKeys.has(event.code)) {
       physicalKeys.add(event.code);

       if (menuOpen && !movementAllowed()) {
         if (!editableTarget(event.target)) {
           event.preventDefault();
           event.stopImmediatePropagation();
         }
       } else {
         gameKeys.add(event.code);
       }

       return;
     }

     if (menuOpen && !gui?.root.contains(event.target)) {
       event.preventDefault();
       event.stopImmediatePropagation();
     }
   }

   /**
    * Tracks movement-key releases even when the GUI has focus.
    *
    * @param {KeyboardEvent} event
    */
   function onKeyUp(event) {
     if (!event.isTrusted) return;

     if (movementKeys.has(event.code)) {
       physicalKeys.delete(event.code);

       if (gameKeys.has(event.code) &&
           menuOpen &&
           editableTarget(event.target)) {
         sendGameKey('keyup', event.code);
       }

       gameKeys.delete(event.code);
       return;
     }

     if (menuOpen && !gui?.root.contains(event.target)) {
       event.preventDefault();
       event.stopImmediatePropagation();
     }
   }

   originalAdd.call(window, 'keydown', onKeyDown, true);
   originalAdd.call(window, 'keyup', onKeyUp, true);

   originalAdd.call(window, 'blur', () => {
     physicalKeys.clear();
     syncMovementKeys();
   });

   /**
    * Toggles GUI Move without rebuilding the ClickGUI.
    */
   function toggleGuiMove() {
     settings.guiMove = !settings.guiMove;
     saveSettings();

     syncMovementKeys();
     updateModuleState('guiMove', settings.guiMove);
   }

   /**
    * Returns the current opening/closing animation duration.
    *
    * @returns {number}
    */
   function transitionDuration() {
     const reducedMotion = matchMedia(
       '(prefers-reduced-motion: reduce)'
     ).matches;

     return settings.animations && !reducedMotion
       ? settings.animationSpeed
       : 0;
   }

   function applyMenuAppearance(duration = transitionDuration()) {
     const { root } = gui;
     root.style.setProperty('--dap-duration', `${duration}ms`);
     root.classList.toggle('dap-blur', settings.blur);
     root.classList.toggle('dap-no-animations', !settings.animations);
   }

   /**
    * Opens or closes the ClickGUI, preserving exit animations.
    *
    * @param {boolean} open
    */
   function setMenuOpen(open) {
     if (menuOpen === open) return;

     menuOpen = open;
     syncMovementKeys();

     if (!gui) return;

     clearTimeout(closeTimer);

     const duration = transitionDuration();
     applyMenuAppearance(duration);

     if (open) {
       gui.root.hidden = false;

       void gui.root.offsetWidth;

       gui.root.classList.add('dap-open');
       renderModules();
     } else {
       waitingForKey = false;
       gui.root.classList.remove('dap-open');

       if (gui.root.contains(document.activeElement)) {
         document.activeElement.blur();
       }

       if (duration === 0) {
         gui.root.hidden = true;
       } else {
         closeTimer = setTimeout(() => {
           if (!menuOpen) gui.root.hidden = true;
         }, duration + 30);
       }
     }
   }

   const modules = [
     {
       id: 'mouse',
       name: 'Mouse Control',
       category: 'Player',
       description: 'Set the game cursor to fixed coordinates.'
     },
     {
       id: 'guiMove',
       name: 'GUI Move',
       category: 'Movement',
       description: 'Use WASD or arrow keys while ClickGUI is open.'
     },
     {
       id: 'clickgui',
       name: 'ClickGUI',
       category: 'Render',
       description: 'Open the menu and customize its appearance.'
     },
     {
       id: 'entityHud',
       name: 'Entity HUD',
       category: 'Render',
       description: 'Label visible tanks, shapes, and projectiles.'
     }
   ];

   /**
    * Changes a module's appearance without recreating its card.
    *
    * @param {string} id
    * @param {boolean} enabled
    */
   function updateModuleState(id, enabled) {
     if (!gui) return;

     const row = gui.list.querySelector(`[data-module="${id}"]`);
     if (!row) return;

     row.classList.toggle('dap-enabled', enabled);
     row.querySelector('.dap-state').textContent =
       enabled ? 'Enabled' : 'Disabled';
   }

   /**
    * Updates the Mouse Control module.
    */
   function updateMouseModule() {
     updateModuleState('mouse', controlling);

     if (!gui) return;

     const row = gui.list.querySelector('[data-module="mouse"]');
     if (!row) return;

     const x = row.querySelector('.dap-x');
     const y = row.querySelector('.dap-y');

     if (document.activeElement !== x) {
       x.value = Math.round(aimX);
     }
     if (document.activeElement !== y) {
       y.value = Math.round(aimY);
     }
   }

   /**
    * Updates the ClickGUI keybind button.
    *
    * @param {string} [message]
    */
   function updateKeybindButton(message) {
     if (!gui) return;

     const button = gui.list.querySelector('.dap-bind-button');
     if (!button) return;

     button.textContent = message ||
       (waitingForKey ? 'Press a key…' : settings.menuKey);
   }

   /**
    * Returns the settings controls for a module.
    *
    * @param {string} id
    * @returns {string}
    */
   function moduleSettings(id) {
     if (id === 'entityHud') {
       return `<p>Source at last draw <strong>${entityHud.source()}</strong></p>
         <p>A current structured frame supplies entity identities and coordinates. Canvas labels use paint and motion estimates.</p>`;
     }

     if (id === 'mouse') {
       return `
         <div class="dap-fields">
           <label>
             X coordinate
             <input class="dap-x" type="number" step="1" required>
           </label>
           <label>
             Y coordinate
             <input class="dap-y" type="number" step="1" required>
           </label>
         </div>
         <button class="dap-apply" type="button">Apply position</button>
       `;
     }

     if (id === 'clickgui') {
       return `
         <label class="dap-setting-row">
           <span>Keybind</span>
           <button class="dap-bind-button" type="button"></button>
         </label>

         <label class="dap-setting-row">
           <span>Animations</span>
           <input data-setting="animations" type="checkbox">
         </label>

         <label class="dap-setting-row">
           <span>Animation speed</span>
           <select data-setting="animationSpeed">
             <option value="140">Fast</option>
             <option value="220">Normal</option>
             <option value="340">Slow</option>
           </select>
         </label>

         <label class="dap-setting-row">
           <span>Background blur</span>
           <input data-setting="blur" type="checkbox">
         </label>

         <label class="dap-setting-row">
           <span>Close when clicking outside</span>
           <input data-setting="outsideClose" type="checkbox">
         </label>
       `;
     }

     return '';
   }

   /**
    * Expands or collapses a module's settings in place.
    *
    * @param {string} id
    */
   function toggleModuleSettings(id) {
     expandedModule = expandedModule === id ? null : id;

     for (const row of gui.list.querySelectorAll('.dap-module')) {
       const expanded = row.dataset.module === expandedModule;
       const panel = row.querySelector('.dap-module-settings');
       const button = row.querySelector('.dap-expand');

       if (!panel || !button) continue;

       panel.classList.toggle('dap-expanded', expanded);
       panel.setAttribute('aria-hidden', String(!expanded));

       button.classList.toggle('dap-expanded', expanded);
       button.setAttribute('aria-expanded', String(expanded));
     }
   }

   /**
    * Renders module cards when category or search changes.
    */
   function renderModules() {
     if (!gui) return;

     for (const button of gui.nav.querySelectorAll('button')) {
       button.classList.toggle(
         'dap-selected',
         button.dataset.category === selectedCategory
       );
     }

     const query = gui.search.value.trim().toLowerCase();

     const visible = modules.filter(module =>
       selectedCategory === 'Search'
         ? (!query ||
            `${module.name} ${module.description}`.toLowerCase().includes(query))
         : module.category === selectedCategory
     );

     gui.list.replaceChildren();

     if (!visible.length) {
       const empty = document.createElement('p');
       empty.className = 'dap-empty';
       empty.textContent = 'No modules in this category.';
       gui.list.appendChild(empty);
       return;
     }

     const moduleStates = { mouse: controlling, guiMove: settings.guiMove, entityHud: settings.entityHud };
     for (const module of visible) {
       const enabled = moduleStates[module.id] ?? menuOpen;

       const row = document.createElement('section');

       row.className = `dap-module${enabled ? ' dap-enabled' : ''}`;
       row.dataset.module = module.id;

       row.innerHTML = `
         <div class="dap-module-header">
           <button class="dap-module-toggle" type="button">
             <strong>${module.name}</strong>
             <span>${module.description}</span>
           </button>

           <span class="dap-state">
             ${enabled ? 'Enabled' : 'Disabled'}
           </span>

           <button class="dap-expand" type="button"
             aria-label="Module settings"
             aria-expanded="false">›</button>
         </div>

         <div class="dap-module-settings" aria-hidden="true">
           ${moduleSettings(module.id)}
         </div>
       `;

       gui.list.appendChild(row);

       const settingsPanel = row.querySelector('.dap-module-settings');
       const expandButton = row.querySelector('.dap-expand');
       const hasSettings = module.id !== 'guiMove';

       expandButton.hidden = !hasSettings;

       if (hasSettings && expandedModule === module.id) {
         settingsPanel.classList.add('dap-expanded');
         settingsPanel.setAttribute('aria-hidden', 'false');
         expandButton.classList.add('dap-expanded');
         expandButton.setAttribute('aria-expanded', 'true');
       }

       row.querySelector('.dap-module-toggle').addEventListener('click', () => {
         if (module.id === 'mouse') {
           if (controlling) {
             release();
           } else {
             const x = row.querySelector('.dap-x').valueAsNumber;
             const y = row.querySelector('.dap-y').valueAsNumber;

             if (Number.isFinite(x) && Number.isFinite(y)) {
               move(x, y);
             }
           }
         } else if (module.id === 'guiMove') {
           toggleGuiMove();
         } else if (module.id === 'entityHud') {
           settings.entityHud = !settings.entityHud;
           if (!settings.entityHud) entityHud.clear();
           saveSettings();
           updateModuleState('entityHud', settings.entityHud);
         } else {
           setMenuOpen(false);
         }
       });

       expandButton.addEventListener('click', () => {
         toggleModuleSettings(module.id);
       });

       row.addEventListener('contextmenu', event => {
         if (!hasSettings) return;
         if (event.target.closest('input, select, button')) return;

         event.preventDefault();
         toggleModuleSettings(module.id);
       });

       if (module.id === 'mouse') {
         const x = row.querySelector('.dap-x');
         const y = row.querySelector('.dap-y');

         x.value = Math.round(aimX);
         y.value = Math.round(aimY);

         row.querySelector('.dap-apply').addEventListener('click', () => {
           if (
             x.reportValidity() &&
             y.reportValidity() &&
             Number.isFinite(x.valueAsNumber) &&
             Number.isFinite(y.valueAsNumber)
           ) {
             move(x.valueAsNumber, y.valueAsNumber);
           }
         });
       }

       if (module.id === 'clickgui') {
         const bind = row.querySelector('.dap-bind-button');
         bind.textContent = settings.menuKey;

         bind.addEventListener('click', () => {
           waitingForKey = true;
           updateKeybindButton();
         });

         for (const input of row.querySelectorAll('[data-setting]')) {
           const key = input.dataset.setting;

           if (input.type === 'checkbox') {
             input.checked = settings[key];
           } else {
             input.value = settings[key];
           }

           input.addEventListener('change', () => {
             settings[key] = input.type === 'checkbox'
               ? input.checked
               : Number(input.value);

             saveSettings();
             applyMenuAppearance();
           });
         }
       }
     }
   }

   /**
    * Creates the in-game ClickGUI.
    */
   function createGui() {
     const style = document.createElement('style');

     style.textContent = `
       #dap-clickgui {
         --dap-duration: 220ms;
         position: fixed;
         inset: 0;
         z-index: 2147483647;
         display: grid;
         place-items: center;
         color: #dfe5ee;
         font: 13px/1.45 system-ui, -apple-system, sans-serif;
         -webkit-font-smoothing: antialiased;
         user-select: none;
         -webkit-user-select: none;
       }

       #dap-clickgui[hidden],
       #dap-clickgui [hidden] {
         display: none !important;
       }

       #dap-clickgui *,
       #dap-clickgui *::before,
       #dap-clickgui *::after {
         box-sizing: border-box;
         -webkit-tap-highlight-color: transparent;
       }

       #dap-clickgui ::selection {
         background: transparent;
       }

       #dap-clickgui button,
       #dap-clickgui input,
       #dap-clickgui select {
         font: inherit;
       }

       #dap-clickgui button {
         cursor: pointer;
         user-select: none;
         -webkit-user-select: none;
       }

       #dap-clickgui button:focus,
       #dap-clickgui button:focus-visible {
         outline: none !important;
       }

       #dap-clickgui input:not([type="checkbox"]),
       #dap-clickgui select {
         user-select: text;
         -webkit-user-select: text;
       }

       #dap-clickgui input:focus,
       #dap-clickgui select:focus {
         outline: none;
         border-color: #438eb4;
       }

       #dap-clickgui .dap-scrim {
         position: absolute;
         inset: 0;
         background: rgba(6, 8, 14, .55);
         opacity: 0;
         transition: opacity var(--dap-duration) ease;
       }

       #dap-clickgui.dap-blur .dap-scrim {
         backdrop-filter: blur(5px);
         -webkit-backdrop-filter: blur(5px);
       }

       #dap-clickgui .dap-window {
         position: relative;
         display: flex;
         overflow: hidden;
         width: min(780px, 94vw);
         height: min(510px, 88vh);
         border-radius: 22px;
         background: linear-gradient(
           125deg, #141b24, #151724 70%, #171625
         );
         border: 1px solid #2b3442;
         box-shadow: 0 28px 95px #0009;
         opacity: 0;
         transform: translateY(17px) scale(.94);
         transition:
           transform var(--dap-duration) cubic-bezier(.2, .8, .2, 1),
           opacity var(--dap-duration) ease;
         pointer-events: none;
         user-select: none;
         -webkit-user-select: none;
       }

       #dap-clickgui.dap-open .dap-scrim {
         opacity: 1;
       }

       #dap-clickgui.dap-open .dap-window {
         opacity: 1;
         transform: translateY(0) scale(1);
         pointer-events: auto;
       }

       #dap-clickgui .dap-sidebar {
         width: 178px;
         flex-shrink: 0;
         padding: 25px 13px;
         display: flex;
         flex-direction: column;
         background: #10141d;
       }

       #dap-clickgui .dap-logo {
         padding: 0 12px 22px;
         font-size: 24px;
         font-weight: 600;
         letter-spacing: -1.2px;
         color: #f3f7fc;
       }

       #dap-clickgui .dap-logo small {
         color: #4cb4e9;
         font-size: 10px;
         margin-left: 4px;
       }

       #dap-clickgui .dap-nav {
         display: grid;
         gap: 5px;
       }

       #dap-clickgui .dap-nav button {
         border: 0;
         background: transparent;
         border-radius: 9px;
         padding: 10px 13px;
         text-align: left;
         color: #9ba6b9;
         transition:
           background 160ms ease,
           color 160ms ease;
       }

       #dap-clickgui .dap-nav button:hover {
         background: #242b38;
         color: #ecf5fc;
       }

       #dap-clickgui .dap-nav button.dap-selected {
         color: #f4fbff;
         background: linear-gradient(90deg, #276e97, #388db7);
       }

       #dap-clickgui .dap-footer {
         margin-top: auto;
         padding: 10px 12px;
         color: #6c788c;
         font-size: 11px;
       }

       #dap-clickgui .dap-main {
         min-width: 0;
         flex: 1;
         padding: 23px 22px;
         display: flex;
         flex-direction: column;
       }

       #dap-clickgui .dap-search {
         width: 100%;
         padding: 10px 12px;
         border: 1px solid transparent;
         outline: none;
         color: #e3e8f1;
         background: #1a2230;
         border-radius: 10px;
         user-select: text;
         -webkit-user-select: text;
       }

       #dap-clickgui .dap-search::placeholder {
         color: #778498;
       }

       #dap-clickgui .dap-content {
         flex: 1;
         overflow-y: auto;
         padding: 12px 0;
         scrollbar-width: thin;
         scrollbar-color: #344355 transparent;
       }

       #dap-clickgui .dap-module {
         margin: 3px 0 11px;
         border-radius: 12px;
         border: 1px solid #293240;
         background: #111823;
         transition:
           border-color 180ms ease,
           background 180ms ease;
       }

       #dap-clickgui .dap-module:hover {
         background: #17202d;
         border-color: #334255;
       }

       #dap-clickgui .dap-module-header {
         display: flex;
         align-items: center;
         padding: 10px 12px 10px 16px;
       }

       #dap-clickgui .dap-module-toggle {
         flex: 1;
         display: grid;
         gap: 5px;
         min-width: 0;
         text-align: left;
         border: 0;
         background: transparent;
         color: inherit;
         padding: 4px 0;
       }

       #dap-clickgui .dap-module-toggle strong {
         font-weight: 550;
         font-size: 15px;
         transition: color 180ms ease;
       }

       #dap-clickgui .dap-module-toggle span {
         color: #78879b;
         font-size: 11px;
       }

       #dap-clickgui .dap-state {
         font-size: 11px;
         color: #818fa2;
         margin: 0 8px;
         transition: color 180ms ease;
       }

       #dap-clickgui .dap-enabled .dap-module-toggle strong,
       #dap-clickgui .dap-enabled .dap-state {
         color: #59bce8;
       }

       #dap-clickgui .dap-expand {
         border: 0;
         background: transparent;
         color: #a2afc0;
         font-size: 26px;
         line-height: 26px;
         width: 30px;
         border-radius: 6px;
         transition:
           transform 180ms ease,
           color 180ms ease;
       }

       #dap-clickgui .dap-expand.dap-expanded {
         transform: rotate(90deg);
         color: #56bcec;
       }

       #dap-clickgui .dap-module-settings {
         max-height: 0;
         overflow: hidden;
         opacity: 0;
         visibility: hidden;
         padding: 0 16px;
         border-top: 1px solid transparent;
         background: #161e29;
         pointer-events: none;
         transition:
           max-height 220ms ease,
           opacity 180ms ease,
           padding 220ms ease,
           border-color 220ms ease,
           visibility 220ms;
       }

       #dap-clickgui .dap-module-settings.dap-expanded {
         max-height: 500px;
         opacity: 1;
         visibility: visible;
         padding: 16px;
         border-top-color: #293441;
         pointer-events: auto;
       }

       #dap-clickgui .dap-fields {
         display: grid;
         grid-template-columns: 1fr 1fr;
         gap: 12px;
       }

       #dap-clickgui .dap-fields label {
         display: grid;
         gap: 7px;
         color: #9ca9bc;
         font-size: 11px;
       }

       #dap-clickgui .dap-fields input {
         width: 100%;
       }

       #dap-clickgui .dap-fields input,
       #dap-clickgui select {
         background: #101821;
         border: 1px solid #364454;
         border-radius: 7px;
         color: #e1eaf6;
         padding: 8px;
         min-width: 0;
       }

       #dap-clickgui .dap-apply,
       #dap-clickgui .dap-bind-button {
         border: 1px solid #3b85ae;
         border-radius: 7px;
         background: #235b7a;
         color: #e3f5ff;
         padding: 7px 12px;
         transition: background 160ms ease;
       }

       #dap-clickgui .dap-apply:hover,
       #dap-clickgui .dap-bind-button:hover {
         background: #2e7298;
       }

       #dap-clickgui .dap-apply {
         margin-top: 13px;
       }

       #dap-clickgui .dap-setting-row {
         display: flex;
         justify-content: space-between;
         align-items: center;
         gap: 12px;
         padding: 9px 0;
         color: #c4cfdd;
         font-size: 12px;
       }

       #dap-clickgui .dap-setting-row + .dap-setting-row {
         border-top: 1px solid #283341;
       }

       #dap-clickgui input[type="checkbox"] {
         width: 16px;
         height: 16px;
         accent-color: #399fcf;
       }

       #dap-clickgui .dap-empty {
         margin: 48px 0;
         text-align: center;
         color: #8e9bad;
       }

       #dap-clickgui.dap-no-animations *,
       #dap-clickgui.dap-no-animations *::before,
       #dap-clickgui.dap-no-animations *::after {
         animation: none !important;
         transition: none !important;
       }

       @media (max-width: 560px) {
         #dap-clickgui .dap-sidebar {
           width: 120px;
           padding: 20px 7px;
         }

         #dap-clickgui .dap-main {
           padding: 17px 12px;
         }

         #dap-clickgui .dap-logo {
           font-size: 19px;
         }

         #dap-clickgui .dap-state {
           display: none;
         }
       }

       @media (prefers-reduced-motion: reduce) {
         #dap-clickgui *,
         #dap-clickgui *::before,
         #dap-clickgui *::after {
           animation: none !important;
           transition: none !important;
         }
       }
     `;

     document.head.appendChild(style);

     const root = document.createElement('div');
     root.id = 'dap-clickgui';
     root.hidden = true;

     root.innerHTML = `
       <div class="dap-scrim"></div>

       <section class="dap-window"
         role="dialog"
         aria-label="Diep Assist Pro">

         <aside class="dap-sidebar">
           <div class="dap-logo">Diep<small>PRO</small></div>
           <nav class="dap-nav"></nav>

           <div class="dap-footer">
             Diep Assist Pro · v${VERSION}
           </div>
         </aside>

         <main class="dap-main">
           <input class="dap-search"
             type="search"
             placeholder="Search modules…"
             autocomplete="off">

           <div class="dap-content"></div>
         </main>
       </section>
     `;

     document.body.appendChild(root);

     gui = {
       root,
       window: root.querySelector('.dap-window'),
       nav: root.querySelector('.dap-nav'),
       search: root.querySelector('.dap-search'),
       list: root.querySelector('.dap-content')
     };

     applyMenuAppearance();

     const categories = [
       'Search', 'Movement', 'Player', 'Render'
     ];

     for (const category of categories) {
       const button = document.createElement('button');

       button.type = 'button';
       button.dataset.category = category;
       button.textContent = category;

       button.addEventListener('click', () => {
         selectedCategory = category;

         if (category !== 'Search') {
           gui.search.value = '';
         }

         renderModules();

         if (category === 'Search') {
           gui.search.focus();
         }
       });

       gui.nav.appendChild(button);
     }

     gui.search.addEventListener('input', () => {
       selectedCategory = 'Search';
       renderModules();
     });

     root.querySelector('.dap-scrim').addEventListener('click', () => {
       if (settings.outsideClose) {
         setMenuOpen(false);
       }
     });

     /**
      * Prevents GUI buttons from retaining keyboard focus
      * after a mouse click.
      */
     root.addEventListener('mousedown', event => {
       if (
         event.button === 0 &&
         event.target.closest('button')
       ) {
         event.preventDefault();
       }
     });

     /**
      * Restores movement-key handling after clicking a button.
      */
     root.addEventListener('click', event => {
       const button = event.target.closest('button');

       if (button && !waitingForKey) {
         button.blur();
         syncMovementKeys();
       }
     });

     /**
      * Removes focus from completed setting interactions.
      *
      * This prevents checkboxes and dropdowns from holding
      * keyboard focus after the setting has changed.
      */
     root.addEventListener('change', event => {
       const target = event.target;

       if (
         target instanceof HTMLSelectElement ||
         (target instanceof HTMLInputElement &&
          ['checkbox', 'radio', 'range'].includes(target.type))
       ) {
         target.blur();
         syncMovementKeys();
       }
     });

     /**
      * Suspends movement while typing and restores it afterward.
      */
     root.addEventListener('focusin', event => {
       if (editableTarget(event.target)) {
         syncMovementKeys();
       }
     });

     root.addEventListener('focusout', event => {
       if (editableTarget(event.target)) {
         queueMicrotask(syncMovementKeys);
       }
     });

     /**
      * Allows Enter or Escape to finish editing a coordinate.
      */
     root.addEventListener('keydown', event => {
       const target = event.target;

       if (
         target instanceof HTMLInputElement &&
         target.type === 'number' &&
         (event.code === 'Enter' || event.code === 'Escape')
       ) {
         target.blur();
       }
     });

     /**
      * Prevents ClickGUI interactions from triggering game shortcuts.
      */
     for (const type of ['keydown', 'keyup', 'keypress']) {
       root.addEventListener(type, event => {
         if (type === 'keyup' && movementKeys.has(event.code)) {
           return;
         }

         if (
           editableTarget(event.target) ||
           !movementKeys.has(event.code) ||
           !settings.guiMove
         ) {
           event.stopPropagation();
         }
       });
     }

     /**
      * Prevents GUI mouse interactions from reaching game handlers.
      */
     for (const type of [
       ...mouseButtons,
       'wheel',
       'mousemove',
       'pointermove'
     ]) {
       root.addEventListener(type, event => {
         event.stopPropagation();
       });
     }

     renderModules();
   }

   if (document.readyState === 'loading') {
     document.addEventListener('DOMContentLoaded', createGui, {
       once: true
     });
   } else {
     createGui();
   }

   // Page-level controls and the latest observed entities for diagnostics.
   window.diepAssistPro = {
     move,
     release,
     openMenu: () => setMenuOpen(true),
     closeMenu: () => setMenuOpen(false),
     visibleEntities: entityHud.snapshot,
     entitySource: entityHud.source,
     playerRoster: readAdminRoster,
     publishEntityFrame: entityHud.publish,
     resetEntityFeed: entityHud.resetFeed
   };
 })();
