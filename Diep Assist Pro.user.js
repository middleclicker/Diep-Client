
 // ==UserScript==
 // @name         Diep Assist Pro
 // @namespace    https://diep.io/
 // @version      0.7.0
 // @description  Shape farming, bullet spread, tracers, and a customizable HUD
 // @match        *://diep.io/*
 // @match        *://*.diep.io/*
 // @run-at       document-start
 // @sandbox      raw
 // @grant        none
 // @noframes
 // ==/UserScript==

 (function () {
   'use strict';

   // Layout of this file:
   //   1. Settings: defaults and localStorage persistence.
   //   2. Entity tracking: packet decoding, draw capture, shape targeting,
   //      and the overlay that rings and labels entities.
   //   3. Input hooks: captures the game's mouse listeners for farming,
   //      and handles movement keys and shortcuts.
   //   4. ClickGUI: the module menu, its settings and the console API.

   if (window.__diepAssistProLoaded) return;
   window.__diepAssistProLoaded = true;

   const VERSION = '0.7.0';
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

   // Kill XP is fixed per shape type; contact damage is estimated.
   // Crashers vary by subtype.
   const FARM_TARGETS = {
     square: { label: 'Squares', xp: 10, contactDamage: 8 },
     triangle: { label: 'Triangles', xp: 25, contactDamage: 8 },
     pentagon: { label: 'Pentagons', xp: 130, contactDamage: 12 },
     alphaPentagon: { label: 'Alpha Pentagons', xp: 3000, contactDamage: 20 },
     hexagon: { label: 'Hexagons', xp: 1500, contactDamage: 16 },
     shiny: { label: 'Shiny shapes' },
     crasher: { label: 'Crashers' },
     other: { label: 'Other shapes', xp: 0 }
   };

   const TRACER_TARGETS = {
     enemy: 'Enemy tanks',
     team: 'Teammates',
     shape: 'Shapes',
     crasher: 'Crashers',
     bullet: 'Bullets',
     drone: 'Drones',
     trap: 'Traps',
     projectile: 'Other projectiles'
   };

   const ANIMATION_SPEEDS = { 140: 'Fast', 220: 'Normal', 340: 'Slow' };

   const HUD_WIDGETS = {
     aimDebug: {
       label: 'Aim Debug',
       x: 0, y: 0, width: 364, height: 64, inset: 12,
       preview: ['Aim Debug · Pentagon #6', 'Smart · 130 XP · 52.0 XP/s · 2.50 s', 'Impact estimate · 596, 350']
     },
     entityStatus: {
       label: 'Entity HUD status',
       x: 0, y: 1, width: 365, height: 20, inset: 10,
       preview: ['Entity HUD · 12 shown · 10 snapped · 16 tracked']
     },
     arrayList: {
       label: 'Arraylist',
       x: 1, y: 0.14, width: 152, height: 132, inset: 12,
       preview: ['Shape Farming', 'Target HUD', 'Tracers']
     },
     targetHud: {
       label: 'Target HUD',
       x: 0.5, y: 0.78, width: 228, height: 68, inset: 12,
       preview: { name: 'Pentagon', type: 'Shape · 130 XP', health: 64, maxHealth: 100 }
     }
   };

   function defaultHudLayout() {
     return Object.fromEntries(Object.entries(HUD_WIDGETS).map(([id, { x, y }]) =>
       [id, { x, y }]
     ));
   }

   const settings = {
     menuKey: 'ShiftRight',
     moduleKeys: {
       guiMove: null, entityHud: null, farming: null, arrayList: null,
       targetHud: null, tracers: null, bulletSpread: null, widerView: null
     },
     animations: true,
     animationSpeed: 220,
     blur: true,
     outsideClose: true,
     guiMove: false,
     entityHud: true,
     hudLabels: true,
     hudProjectiles: true,
     hudShapes: false,
     arrayList: false,
     arrayListRender: true,
     targetHud: false,
     tracers: false,
     bulletSpread: false,
     spreadSelf: true,
     spreadTeam: false,
     spreadEnemy: true,
     spreadHalfAngle: 8,
     spreadLength: 9,          // cone length in tank radii
     widerView: false,
     widerViewPercent: 12,     // extra view on each side
     tracerTargets: Object.fromEntries(
       Object.keys(TRACER_TARGETS).map(type => [type, type === 'enemy'])
     ),
     hudLayout: defaultHudLayout(),
     farmLeadShapes: false,
     farmAimDebug: false,
     farmTargets: Object.fromEntries(
       Object.keys(FARM_TARGETS).map(type => [type, type !== 'crasher'])
     )
   };

   function bindableKey(code) {
     return typeof code === 'string' && code !== '' &&
       code !== 'Unidentified' && code !== 'Escape' && !movementKeys.has(code);
   }

   try {
     const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};

     if (bindableKey(saved.menuKey)) {
       settings.menuKey = saved.menuKey;
     }
     const assigned = new Set([settings.menuKey]);
     for (const id of Object.keys(settings.moduleKeys)) {
       const code = saved.moduleKeys?.[id];
       if (bindableKey(code) && !assigned.has(code)) {
         settings.moduleKeys[id] = code;
         assigned.add(code);
       }
     }
     if (typeof saved.animationSpeed === 'number' &&
         Object.hasOwn(ANIMATION_SPEEDS, saved.animationSpeed)) {
       settings.animationSpeed = saved.animationSpeed;
     }
     if (Number.isFinite(saved.spreadHalfAngle)) {
       settings.spreadHalfAngle = Math.max(1, Math.min(45, saved.spreadHalfAngle));
     }
     if (Number.isFinite(saved.spreadLength)) {
       settings.spreadLength = Math.max(1, Math.min(100, saved.spreadLength));
     }
     if (Number.isFinite(saved.widerViewPercent)) {
       settings.widerViewPercent = Math.max(1, Math.min(40, saved.widerViewPercent));
     }
     for (const key of ['farmTargets', 'tracerTargets']) {
       for (const type of Object.keys(settings[key])) {
         const enabled = saved[key]?.[type];
         if (typeof enabled === 'boolean') settings[key][type] = enabled;
       }
     }
     for (const id of Object.keys(settings.hudLayout)) {
       const position = saved.hudLayout?.[id];
       if ([position?.x, position?.y].every(value =>
         Number.isFinite(value) && value >= 0 && value <= 1
       )) {
         settings.hudLayout[id] = { x: position.x, y: position.y };
       }
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

   // =================================================================
   // Entity HUD
   //
   // Rings and labels every tank, projectile and shape on screen.
   //
   //   1. Packet capture: Diep's packets are encrypted on the wire and
   //      decrypted in place inside WebAssembly memory. We copy each one
   //      out right after the game decrypts it.
   //   2. Decoder: turns packets into an entity table: what each entity
   //      is, who owns it, its team colour, health and world position.
   //   3. Draw capture: records where the game drew each circle and
   //      polygon this frame.
   //   4. Overlay: predicts each entity's screen position from packets,
   //      then snaps it onto the shape the game actually drew.
   //
   // Packets say *what* things are; the draw calls say *where* they are.
   // The field numbers and layouts below were reverse-engineered from the
   // current game build and will need refreshing after a protocol change.
   // =================================================================

   // -----------------------------------------------------------------
   // Protocol tables
   //
   //   update packet: [0x00][varint][tick][deleteCount][(gen, id)…]
   //                  [recordCount][record…][8–24 byte trailer]
   //   record:        [gen][id][0 = update | 1 = create][bitmask]…
   //
   // An update record's bitmask lists changed fields by index, each
   // followed by its value in ascending index order. A create record's
   // bitmask lists components; the fields of all present components
   // follow in a fixed order (CREATE_SLOTS).
   //
   // Value types: f = float32, v = varint, z = zigzag varint, s = string,
   // r = entity reference, mf/mv/ms = bitmask + one float/varint/string
   // per set bit, b3 = three raw bytes.
   // -----------------------------------------------------------------

   /** Update field indices the HUD uses. */
   const FIELD = {
     OPACITY: 6,
     HEALTH: 28,
     COLOR: 39,
     FOV: 52,
     X: 53,
     MAX_HEALTH: 67,
     Y: 69,
     SIZE: 77,
     CAMERA_X: 86,
     CAMERA_Y: 92,
     SCORE: 95,
     // Camera fields for your tank's progression. All are zigzag.
     STAT_LEVELS: 42,        // masked array, one entry per stat slot
     TANK_CLASS: 58,         // class id, see TANK_CLASSES
     STAT_POINTS: 96,        // unspent upgrade points
     LEVEL: 110
   };

   /**
    * Tank class ids. Twin (1), Triple Shot (3) and Penta Shot (14) were
    * confirmed from a capture; the rest follow the community-documented
    * numbering. Ids missing here (newer tanks) show as "Class #id".
    */
   const TANK_CLASSES = {
     0: 'Tank', 1: 'Twin', 2: 'Triplet', 3: 'Triple Shot', 4: 'Quad Tank',
     5: 'Octo Tank', 6: 'Sniper', 7: 'Machine Gun', 8: 'Flank Guard',
     9: 'Tri-Angle', 10: 'Destroyer', 11: 'Overseer', 12: 'Overlord',
     13: 'Twin Flank', 14: 'Penta Shot', 15: 'Assassin', 16: 'Arena Closer',
     17: 'Necromancer', 18: 'Triple Twin', 19: 'Hunter', 20: 'Gunner',
     21: 'Stalker', 22: 'Ranger', 23: 'Booster', 24: 'Fighter', 25: 'Hybrid',
     26: 'Manager', 27: 'Mothership', 28: 'Predator', 29: 'Sprayer',
     31: 'Trapper', 32: 'Gunner Trapper', 33: 'Overtrapper', 34: 'Mega Trapper',
     35: 'Tri-Trapper', 36: 'Smasher', 38: 'Landmine', 39: 'Auto Gunner',
     40: 'Auto 5', 41: 'Auto 3', 42: 'Spread Shot', 43: 'Streamliner',
     44: 'Auto Trapper', 45: 'Dominator', 46: 'Dominator', 47: 'Dominator',
     48: 'Battleship', 49: 'Annihilator', 50: 'Auto Smasher', 51: 'Spike',
     52: 'Factory', 54: 'Skimmer', 55: 'Rocketeer'
   };

   function tankClassName(id) {
     return TANK_CLASSES[id] ?? `Class #${id}`;
   }

   /** Update field index → value type, for every field seen so far. */
   const FIELD_TYPES = {};
   for (const i of [6, 12, 18, 20, 28, 52, 57, 62, 67, 72, 77, 81, 86, 90, 92, 95]) {
     FIELD_TYPES[i] = 'f';
   }
   for (const i of [4, 8, 39, 47, 49, 58, 65, 88, 96, 97, 100, 102, 103, 110]) {
     FIELD_TYPES[i] = 'v';
   }
   for (const i of [53, 69]) FIELD_TYPES[i] = 'z';
   for (const i of [2, 13]) FIELD_TYPES[i] = 'mf';
   for (const i of [34, 42, 66, 82]) FIELD_TYPES[i] = 'mv';
   FIELD_TYPES[44] = 'ms';
   FIELD_TYPES[85] = 's';
   FIELD_TYPES[54] = 'b3';
   FIELD_TYPES[27] = 'r';

   /** Component ids used in create records. */
   const COMP = {
     RELATIONS: 2,
     BARREL: 6,
     TANK_EXTRA: 7,
     PHYSICS: 9,
     HEALTH: 10,
     NAME: 14,
     CAMERA: 16,
     POSITION: 17,
     PHYSICS_EXTRA: 18,
     TANK: 20
   };

   /**
    * Camera component: 85 stat varints, 8 stat names, then camera values.
    * Offsets below are relative to CAMERA_BASE.
    */
   const CAMERA_LAYOUT =
     'v'.repeat(85) + 's'.repeat(8) + 'ffffvvvffvvffvfvvvfvvvfffvvvrv';
   const CAMERA_BASE = 93;
   const CAMERA_FOV = CAMERA_BASE + 11;
   const CAMERA_X = CAMERA_BASE + 22;
   const CAMERA_Y = CAMERA_BASE + 24;
   const CAMERA_PLAYER = CAMERA_BASE + 28;
   const CAMERA_STAT_MAX = 77;        // 8 zigzag caps, then 8 stat names
   const CAMERA_STAT_NAMES = 85;
   const STAT_SLOTS = 8;

   /**
    * Create-record slots in serialization order: [component, field types].
    * Position is split in two: one varint comes before the name.
    */
   const CREATE_SLOTS = [
     [COMP.PHYSICS, 'fffffvvffvfvvv'],
     [COMP.POSITION, 'v'],
     [COMP.NAME, 'svvv'],
     [COMP.POSITION, 'zzvv'],
     [COMP.TANK, 'vvvvvfv'],
     [COMP.CAMERA, CAMERA_LAYOUT],
     [COMP.RELATIONS, 'vrr'],
     [COMP.HEALTH, 'fvf'],
     [COMP.BARREL, 'vff'],
     [COMP.TANK_EXTRA, 'vv']
   ];

   /** Indices into the PHYSICS slot (physics + style). */
   const PHYSICS_SIZE = 3;
   const PHYSICS_FLAGS = 5;
   const PHYSICS_SIDES = 6;
   const PHYSICS_COLOR = 12;

   const KNOWN_COMPONENTS = new Set(Object.values(COMP));

   /** Components that always appear together; their fields share slots. */
   const PAIRED_COMPONENTS = [
     [COMP.PHYSICS, COMP.PHYSICS_EXTRA],
     [COMP.TANK, COMP.TANK_EXTRA]
   ];

   const TEAM_COLORS = { 3: 'Blue', 4: 'Red', 5: 'Purple', 6: 'Green' };
   const SHINY_COLOR = 7;
   const CRASHER_COLOR = 11;
   const DRONE_FLAG = 32;

   const HUD_COLORS = {
     self: '#4fc3ff',
     own: '#4fc3ff',
     team: '#5be37a',
     enemy: '#ff5a5a',
     neutral: '#ffd75e',
     hostile: '#ff7ad9'
   };

   // -----------------------------------------------------------------
   // Shared state
   // -----------------------------------------------------------------

   const hud = {
     // Packet capture
     memory: null,           // the game's WebAssembly.Memory
     pending: null,          // message currently being dispatched
     queue: [],              // decrypted packets waiting to be decoded
     decodeScheduled: false,

     // Decoded game state
     entities: new Map(),    // id → entity
     cameraId: null,         // your camera entity
     myTankId: null,
     myColor: null,          // kept while dead, so teams stay correct
     cam: null,              // server camera: { x, y, ox, oy, t, fov }
     tank: null,             // your progression: level, points, stats
     tickMs: 40,             // measured time between server updates
     tick: 0,                // server tick of the packet being applied
     lastPacketAt: 0,
     farmBulletSample: null,
     farmLock: null,
     farmLearn: newFarmLearn(),
     packetHits: [],         // shapes that lost health this packet
     packetRemoved: [],      // entities deleted this packet

     // Overlay
     view: null,             // smoothed camera, before draw correction
     drawOffset: [0, 0],     // last frame's camera correction, in px
     canvas: null,
     ctx: null,

     stats: { packets: 0, resynced: 0, dropped: 0, misses: 0, snapped: 0 }
   };

   // -----------------------------------------------------------------
   // Decoder
   // -----------------------------------------------------------------

   const textDecoder = new TextDecoder();

   // Readers take a cursor { b: Uint8Array, dv: DataView, i: offset }.

   /** One byte; throws past the end so a misread fails instead of looping. */
   function readByte(r) {
     if (r.i >= r.b.length) throw new RangeError('end of packet');
     return r.b[r.i++];
   }

   /** Unsigned LEB128 varint (multiplies, so values above 2^31 are safe). */
   function readVarint(r) {
     let value = 0;
     let scale = 1;
     let byte;
     do {
       byte = readByte(r);
       value += (byte & 127) * scale;
       scale *= 128;
     } while (byte & 128);
     return value;
   }

   /** A varint bitmask, returned as the list of set bit indices. */
   function readBits(r) {
     const bits = [];
     let base = 0;
     let byte;
     do {
       byte = readByte(r);
       for (let k = 0; k < 7; k++) {
         if (byte & (1 << k)) bits.push(base + k);
       }
       base += 7;
     } while (byte & 128);
     return bits;
   }

   /** Little-endian float32. */
   function readFloat(r) {
     if (r.i + 4 > r.b.length) throw new RangeError('end of packet');
     const value = r.dv.getFloat32(r.i, true);
     r.i += 4;
     return value;
   }

   /** Zigzag-encoded signed varint (0, -1, 1, -2, …). Used for positions. */
   function readZigzag(r) {
     const v = readVarint(r);
     return v % 2 ? -(v + 1) / 2 : v / 2;
   }

   /** A null-terminated UTF-8 string. */
   function readString(r) {
     const end = r.b.indexOf(0, r.i);
     if (end < 0) throw new RangeError('unterminated string');
     const text = textDecoder.decode(r.b.subarray(r.i, end));
     r.i = end + 1;
     return text;
   }

   /** An entity reference: generation 0 means none. */
   function readRef(r) {
     const gen = readVarint(r);
     return gen === 0 ? null : { gen, id: readVarint(r) };
   }

   /** A bitmask followed by one value per set bit (array diffs). */
   function readMasked(r, read) {
     const out = {};
     for (const bit of readBits(r)) out[bit] = read(r);
     return out;
   }

   const READERS = {
     f: readFloat,
     v: readVarint,
     z: readZigzag,
     s: readString,
     r: readRef,
     mf: r => readMasked(r, readFloat),
     mv: r => readMasked(r, readVarint),
     ms: r => readMasked(r, readString),
     b3: r => {
       r.i += 3;
       if (r.i > r.b.length) throw new RangeError('end of packet');
       return null;
     }
   };

   /** Reads one value per type letter in `layout`. */
   function readLayout(r, layout) {
     const out = new Array(layout.length);
     for (let k = 0; k < layout.length; k++) out[k] = READERS[layout[k]](r);
     return out;
   }

   /** Whether we know the layout of every component in a create record. */
   function componentsKnown(comps) {
     for (const c of comps) if (!KNOWN_COMPONENTS.has(c)) return false;
     for (const [a, b] of PAIRED_COMPONENTS) {
       if (comps.has(a) !== comps.has(b)) return false;
     }
     return true;
   }

   /**
    * Reads one record. Throws on an unknown field or component, since
    * its length can't be known.
    *
    * @returns {{create: false, id: number, fields: Object}|
    *           {create: true, id: number, comps: Set<number>, slots: Array}}
    */
   function readRecord(r) {
     readVarint(r); // generation
     const id = readVarint(r);
     const kind = readVarint(r);

     if (id >= 16384 || kind > 1) throw new Error('bad record header');

     const bits = readBits(r);

     if (kind === 0) {
       const fields = {};
       for (const bit of bits) {
         const type = FIELD_TYPES[bit];
         if (!type) throw new Error(`unknown field ${bit}`);
         fields[bit] = READERS[type](r);
       }
       return { create: false, id, fields };
     }

     const comps = new Set(bits);
     if (!componentsKnown(comps)) throw new Error('unknown components');

     const slots = CREATE_SLOTS.map(([comp, layout]) =>
       comps.has(comp) ? readLayout(r, layout) : null
     );
     return { create: true, id, comps, slots };
   }

   /** Packets end with an 8–24 byte trailer we don't decode. */
   function trailerOk(r) {
     const rest = r.b.length - r.i;
     return rest >= 8 && rest <= 24;
   }

   /** Reads `count` records from `start`; null unless all parse cleanly. */
   function readRecordsStrict(b, dv, start, count) {
     const r = { b, dv, i: start };
     const records = [];
     try {
       for (let k = 0; k < count; k++) records.push(readRecord(r));
     } catch {
       return null;
     }
     return trailerOk(r) ? records : null;
   }

   // How far past an unreadable record to look for the next one.
   const RESYNC_SCAN_BYTES = 2000;

   /**
    * Decodes one plaintext update packet. If a record can't be read, the
    * rest of the packet is recovered by finding the offset from which all
    * remaining records parse cleanly up to the trailer.
    */
   function decodePacket(b) {
     const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
     const r = { b, dv, i: 1 };

     readVarint(r);
     const tick = readVarint(r);

     const deletes = [];
     const deleteCount = readVarint(r);
     for (let k = 0; k < deleteCount; k++) {
       readVarint(r); // generation
       deletes.push(readVarint(r));
     }

     const count = readVarint(r);
     const records = [];

     for (let k = 0; k < count; k++) {
       const start = r.i;
       try {
         records.push(readRecord(r));
       } catch (error) {
         if (capture) captureUnreadable(b, start, tick, error);
         const remaining = count - k - 1;
         const limit = Math.min(b.length, r.i + RESYNC_SCAN_BYTES);
         let rest = null;

         for (let j = r.i; j < limit && !rest; j++) {
           rest = readRecordsStrict(b, dv, j, remaining);
         }

         if (rest) {
           records.push(...rest);
           hud.stats.resynced++;
         } else {
           hud.stats.dropped++;
         }
         break;
       }
     }

     return { tick, deletes, records };
   }

   // -----------------------------------------------------------------
   // Entity table
   // -----------------------------------------------------------------

   /**
    * A blank entity. Positions are interpolated: (ox, oy) is where it was
    * displayed when the latest update (x, y) arrived at time t.
    */
   function newEntity(id, comps, now) {
     return {
       id,
       comps,
       x: 0, y: 0, ox: 0, oy: 0, t: now,
       vx: 0, vy: 0, motionAt: now, motionTick: hud.tick, bornAt: now,
       leadMotion: null,
       hasPosition: false,
       size: 0,
       sides: 0,
       flags: 0,
       color: -1,
       name: '',
       score: 0,
       health: null,
       maxHealth: null,
       owner: null,
       opacity: 1,
       snapOffset: null,     // last offset from its drawn shape, in px
       snapAt: 0
     };
   }

   /** Builds an entity from a create record. */
   function makeEntity(record, now) {
     const [physics, , name, pos, tank, camera, relations, health] =
       record.slots;
     const e = newEntity(record.id, record.comps, now);

     if (physics) {
       e.size = physics[PHYSICS_SIZE];
       e.flags = physics[PHYSICS_FLAGS];
       e.sides = physics[PHYSICS_SIDES];
       e.color = physics[PHYSICS_COLOR];
     }
     if (name) e.name = name[0];
     if (pos) {
       e.x = e.ox = pos[0];
       e.y = e.oy = pos[1];
       e.hasPosition = true;
     }
     if (tank) e.score = tank[5];
     if (relations && relations[1]) e.owner = relations[1].id;
     if (health) {
       e.health = health[0];
       e.maxHealth = health[2];
     }

     if (camera) {
       hud.cameraId = record.id;
       hud.cam = {
         x: camera[CAMERA_X], y: camera[CAMERA_Y],
         ox: camera[CAMERA_X], oy: camera[CAMERA_Y],
         t: now,
         fov: camera[CAMERA_FOV]
       };
       const player = camera[CAMERA_PLAYER];
       if (player) hud.myTankId = player.id;

       // A camera is created when you spawn, as a level 1 Tank with
       // nothing spent; later changes arrive as camera updates.
       hud.tank = {
         classId: 0,
         level: 1,
         points: 0,
         names: camera.slice(CAMERA_STAT_NAMES, CAMERA_STAT_NAMES + STAT_SLOTS),
         max: camera.slice(CAMERA_STAT_MAX, CAMERA_STAT_MAX + STAT_SLOTS).map(unzigzag),
         levels: new Array(STAT_SLOTS).fill(0)
       };
     }
     return e;
   }

   /** Decodes a zigzag varint value (0, -1, 1, -2, …). */
   function unzigzag(v) {
     return v % 2 ? -(v + 1) / 2 : v / 2;
   }

   /** Applies camera updates to your level, points and stat levels. */
   function applyTankProgress(f) {
     const tank = hud.tank;
     if (!tank) return;
     if (FIELD.LEVEL in f) tank.level = unzigzag(f[FIELD.LEVEL]);
     if (FIELD.STAT_POINTS in f) tank.points = unzigzag(f[FIELD.STAT_POINTS]);
     if (FIELD.TANK_CLASS in f) {
       const classId = unzigzag(f[FIELD.TANK_CLASS]);
       if (classId !== tank.classId) {
         tank.classId = classId;
         onClassChanged();
       }
     }

     const levels = f[FIELD.STAT_LEVELS];
     if (!levels) return;
     const changed = [];
     for (const [slot, value] of Object.entries(levels)) {
       const level = unzigzag(value);
       if (slot < STAT_SLOTS && tank.levels[slot] !== level) {
         tank.levels[slot] = level;
         changed.push(tank.names[slot]);
       }
     }
     if (changed.length) onStatsChanged(changed);
   }

   // The game draws entities about 1.5 server ticks behind the newest
   // state, so the HUD eases toward each update over the same span.
   const SMOOTHING_TICKS = 1.5;

   /** Interpolated position of an entity (or the camera) at `now`. */
   function displayed(obj, now) {
     const span = hud.tickMs * SMOOTHING_TICKS;
     const k = Math.min(1, Math.max(0, (now - obj.t) / span));
     return [obj.ox + (obj.x - obj.ox) * k, obj.oy + (obj.y - obj.oy) * k];
   }

   /** Starts easing toward a new position from wherever it's shown now. */
   function moveTo(obj, x, y, now) {
     const [cx, cy] = displayed(obj, now);
     obj.ox = cx;
     obj.oy = cy;
     obj.x = x;
     obj.y = y;
     obj.t = now;
   }

   const SHAPE_LEAD_FRESH_MS = 180;
   const SHAPE_LEAD_HORIZON = 0.28;
   const SHAPE_LEAD_CUTOFF = 0.5;

   /** Keeps only a coherent run of recent shape velocities. */
   function updateShapeLead(e, now, seconds) {
     const speed = Math.hypot(e.vx, e.vy);
     if (speed < 3 || seconds > SHAPE_LEAD_FRESH_MS / 1000) {
       e.leadMotion = null;
       return;
     }
     const prior = e.leadMotion;
     const alignment = prior ? (e.vx * prior.rawX + e.vy * prior.rawY) / (speed * prior.speed) : 0;
     const coherent = prior && now - prior.at <= SHAPE_LEAD_FRESH_MS &&
       alignment >= 0.75 && speed <= prior.speed * 1.65 + 15 && speed >= prior.speed * 0.35 - 5;
     const decay = coherent ? Math.min(6, Math.max(0, Math.log(prior.speed / speed) / seconds)) : 0;
     e.leadMotion = {
       at: now, speed, rawX: e.vx, rawY: e.vy,
       vx: coherent ? 0.25 * prior.vx + 0.75 * e.vx : e.vx,
       vy: coherent ? 0.25 * prior.vy + 0.75 * e.vy : e.vy,
       decay: coherent ? 0.35 * prior.decay + 0.65 * decay : 0,
       count: coherent ? Math.min(4, prior.count + 1) : 1
     };
   }

   /** Applies an update record to its entity. */
   function applyUpdate(record, now) {
     const f = record.fields;
     let e = hud.entities.get(record.id);

     if (!e) {
       // Created before we started decoding (e.g. in the compressed join
       // snapshot): track its position, but its type stays unknown.
       e = newEntity(record.id, new Set(), now);
       hud.entities.set(record.id, e);
     }

     if (FIELD.X in f || FIELD.Y in f) {
       const x = FIELD.X in f ? f[FIELD.X] : e.x;
       const y = FIELD.Y in f ? f[FIELD.Y] : e.y;
       if (e.hasPosition) {
         // Time motion by server ticks: packet arrival times jitter, and
         // that jitter would otherwise show up as speed.
         const ticks = hud.tick - e.motionTick;
         const seconds = ticks * hud.tickMs / 1000;
         if (ticks >= 1 && seconds <= 0.35) {
           e.vx = (x - e.x) / seconds;
           e.vy = (y - e.y) / seconds;
           if (settings.farmLeadShapes && e.comps.has(COMP.NAME) &&
               e.comps.has(COMP.HEALTH) && !e.comps.has(COMP.TANK)) {
             updateShapeLead(e, now, seconds);
           }
         } else if (seconds > 0.35) {
           e.vx = e.vy = 0;
           e.leadMotion = null;
         }
         moveTo(e, x, y, now);
       } else {
         e.x = e.ox = x;
         e.y = e.oy = y;
         e.hasPosition = true;
       }
       e.motionAt = now;
       e.motionTick = hud.tick;
     }

     if (isShapeEntity(e)) {
       const health = f[FIELD.HEALTH];
       if (Number.isFinite(health) && Number.isFinite(e.health) &&
           health > 0 && health < e.health) {
         hud.packetHits.push({ e, drop: e.health - health });
       }
     }

     if (FIELD.HEALTH in f) e.health = f[FIELD.HEALTH];
     if (FIELD.MAX_HEALTH in f) e.maxHealth = f[FIELD.MAX_HEALTH];
     if (FIELD.COLOR in f) e.color = f[FIELD.COLOR];
     if (FIELD.SIZE in f) e.size = f[FIELD.SIZE];
     if (FIELD.OPACITY in f) e.opacity = f[FIELD.OPACITY];
     if (FIELD.SCORE in f) e.score = f[FIELD.SCORE];

     if (record.id === hud.cameraId && hud.cam) {
       if (FIELD.CAMERA_X in f || FIELD.CAMERA_Y in f) {
         moveTo(
           hud.cam,
           FIELD.CAMERA_X in f ? f[FIELD.CAMERA_X] : hud.cam.x,
           FIELD.CAMERA_Y in f ? f[FIELD.CAMERA_Y] : hud.cam.y,
           now
         );
       }
       if (FIELD.FOV in f) hud.cam.fov = f[FIELD.FOV];
       applyTankProgress(f);
     }
   }

   /** Decodes a captured packet and applies it to the entity table. */
   function processPacket(b) {
     if (!b.length || b[0] !== 0) return; // only update packets

     const now = performance.now();
     if (hud.lastPacketAt) {
       const gap = now - hud.lastPacketAt;
       if (gap > 5 && gap < 200) hud.tickMs += (gap - hud.tickMs) * 0.1;
     }
     hud.lastPacketAt = now;
     hud.stats.packets++;

     let decoded;
     try {
       decoded = decodePacket(b);
     } catch {
       hud.stats.dropped++;
       return;
     }

     hud.tick = decoded.tick;
     hud.packetHits = [];
     hud.packetRemoved = [];

     if (capture) captureRecords(decoded);

     for (const id of decoded.deletes) {
       const removed = hud.entities.get(id);
       if (removed) hud.packetRemoved.push(removed);
       hud.entities.delete(id);
       if (id === hud.cameraId) {
         hud.cameraId = null;
         hud.cam = null;
       }
       if (id === hud.myTankId) hud.myTankId = null;
     }

     for (const record of decoded.records) {
       if (record.create) {
         const e = makeEntity(record, now);
         hud.entities.set(record.id, e);
         if (entityKind(e) === 'bullet' && e.owner != null &&
             e.owner === hud.myTankId) {
           recordShot();
         }
       } else {
         applyUpdate(record, now);
       }
     }

     learnHitDamage();
   }

   /** Decodes queued packets after the game's message handler returns. */
   function scheduleDecode() {
     if (hud.decodeScheduled) return;
     hud.decodeScheduled = true;

     setTimeout(() => {
       hud.decodeScheduled = false;
       const queue = hud.queue;
       hud.queue = [];
       for (const packet of queue) processPacket(packet);
     }, 0);
   }

   /** Clears all game state, e.g. when connecting to a new server. */
   function resetEntities() {
     hud.entities.clear();
     hud.cameraId = null;
     hud.myTankId = null;
     hud.myColor = null;
     hud.cam = null;
     hud.tank = null;
     hud.view = null;
     hud.drawOffset = [0, 0];
     hud.queue = [];
     hud.farmBulletSample = null;
     hud.farmLock = null;
     hud.tick = 0;
     hud.farmLearn = newFarmLearn();
   }

   // -----------------------------------------------------------------
   // Capture mode
   //
   // Records the raw game data about your own tank, so fields that aren't
   // decoded yet (such as tank class) can be identified from a session
   // where you change them. Run in the console:
   //
   //   diepAssistPro.capture.start()
   //   diepAssistPro.capture.mark('picked Twin')   // after each change
   //   copy(diepAssistPro.capture.stop())          // copies the log
   //
   // Recorded: your camera's and tank's creations and changed fields,
   // entities your tank owns (barrels, decorations), their deletions, and
   // the raw bytes of any record about them the decoder can't read.
   // Movement, aim and health ticks are left out to keep the log short.
   // -----------------------------------------------------------------

   const CAPTURE_MAX_EVENTS = 5000;
   const CAPTURE_NOISE_FIELDS = new Set([
     FIELD.X, FIELD.Y, FIELD.HEALTH, FIELD.CAMERA_X, FIELD.CAMERA_Y,
     12, 72, 100              // camera spectate position and tank angle
   ]);

   let capture = null;

   function captureEvent(event) {
     if (capture.events.length >= CAPTURE_MAX_EVENTS) {
       capture.truncated = true;
       return;
     }
     capture.events.push({ t: Math.round(performance.now() - capture.startedAt), ...event });
   }

   /**
    * Whether a record is about your tank, your camera or a part of your
    * tank (barrels, decorations). Your bullets and drones are skipped.
    */
   function captureWatched(id) {
     if (id === hud.cameraId || id === hud.myTankId) return true;
     const e = hud.entities.get(id);
     return Boolean(e && e.owner != null && e.owner === hud.myTankId &&
       !e.comps.has(COMP.HEALTH));
   }

   function captureRole(id) {
     return id === hud.cameraId ? 'camera' : id === hud.myTankId ? 'tank' : 'owned';
   }

   /** JSON-safe copy: strings, numbers and nested objects only. */
   function captureValue(value) {
     if (typeof value === 'number') return Number(value.toPrecision(6));
     if (Array.isArray(value)) return value.map(captureValue);
     if (value && typeof value === 'object') {
       return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, captureValue(v)]));
     }
     return value;
   }

   function captureRecords(decoded) {
     const tick = decoded.tick;

     for (const id of decoded.deletes) {
       if (captureWatched(id)) captureEvent({ tick, type: 'delete', id, role: captureRole(id) });
     }

     // Cameras and tanks created earlier in this packet aren't in the
     // entity table yet, so track them here.
     let cameraId = hud.cameraId;
     let tankId = hud.myTankId;

     for (const record of decoded.records) {
       if (record.create) {
         const slots = record.slots;
         const camera = slots[5];
         const owner = slots[6]?.[1]?.id;
         let role = null;
         if (camera) {
           role = 'camera';
           cameraId = record.id;
           const player = camera[CAMERA_PLAYER];
           if (player) tankId = player.id;
         } else if (record.id === tankId || (owner != null && owner === cameraId)) {
           role = 'tank';
           tankId = record.id;
         } else if (owner != null && owner === tankId && !record.comps.has(COMP.HEALTH)) {
           role = 'owned';
         }
         if (!role) continue;

         captureEvent({
           tick,
           type: 'create',
           id: record.id,
           role,
           comps: [...record.comps],
           // The camera slot is long; keep its stat block and tail apart.
           slots: captureValue(slots.map((slot, i) => (i === 5 ? null : slot))),
           camera: camera ? {
             stats: camera.slice(0, CAMERA_STAT_NAMES),
             names: camera.slice(CAMERA_STAT_NAMES, CAMERA_BASE),
             tail: captureValue(camera.slice(CAMERA_BASE))
           } : undefined
         });
       } else if (captureWatched(record.id)) {
         // Only fields whose value changed since they were last logged.
         const seen = capture.last.get(record.id) ?? {};
         capture.last.set(record.id, seen);
         const fields = {};
         for (const [field, value] of Object.entries(record.fields)) {
           if (CAPTURE_NOISE_FIELDS.has(Number(field))) continue;
           const copy = captureValue(value);
           const key = JSON.stringify(copy);
           if (seen[field] === key) continue;
           seen[field] = key;
           fields[field] = copy;
         }
         if (Object.keys(fields).length) {
           captureEvent({ tick, type: 'update', id: record.id, role: captureRole(record.id), fields });
         }
       }
     }
   }

   /** Saves the raw bytes of a record the decoder couldn't read. */
   function captureUnreadable(b, start, tick, error) {
     const r = { b, dv: null, i: start };
     let id = null;
     let kind = null;
     try {
       readVarint(r);
       id = readVarint(r);
       kind = readVarint(r);
     } catch {
       // Header itself unreadable; keep the bytes anyway.
     }
     if (id !== null && kind === 0 && !captureWatched(id)) return;

     captureEvent({
       tick,
       type: 'unreadable',
       id,
       kind,
       role: id !== null && captureWatched(id) ? captureRole(id) : 'other',
       error: String(error?.message ?? error),
       bytes: Array.from(b.subarray(start, start + 96),
         x => x.toString(16).padStart(2, '0')).join(' ')
     });
   }

   /** Console API: `diepAssistPro.capture`. */
   const captureApi = {
     start() {
       capture = { startedAt: performance.now(), events: [], truncated: false, last: new Map() };
       captureEvent({ type: 'start', camera: hud.cameraId, tank: hud.myTankId });
       return 'Capture started. Change your tank, call mark() after each change, then stop().';
     },
     mark(label = '') {
       if (!capture) return 'Not capturing. Call start() first.';
       captureEvent({ type: 'mark', label: String(label), tick: hud.tick });
       return `Marked "${label}".`;
     },
     stop() {
       if (!capture) return 'Not capturing.';
       const log = {
         version: VERSION,
         tickMs: Math.round(hud.tickMs),
         truncated: capture.truncated,
         events: capture.events
       };
       capture = null;
       return JSON.stringify(log);
     },
     status() {
       return capture
         ? { capturing: true, events: capture.events.length, truncated: capture.truncated }
         : { capturing: false };
     }
   };

   // -----------------------------------------------------------------
   // Farming self-calibration
   //
   // Smart targeting needs shot stats that depend on your tank and
   // upgrades, so they're measured from your own play:
   //   - shot interval: how often your bullets spawn while firing,
   //   - damage per hit: health a shape loses per tick while only your
   //     bullets are touching it.
   // -----------------------------------------------------------------

   const LEARN_SAMPLES = 24;          // recent samples kept per measurement
   const SHOT_GAP_MAX_MS = 1500;      // longer pauses start a new firing run
   const SHOT_RUN_MIN_BULLETS = 4;    // bullets before a run sets the interval
   const CONTACT_SLACK = 6;           // world units of tolerance for "touching"

   /** Fresh calibration state. */
   function newFarmLearn() {
     return {
       tankId: null,
       run: null,                     // { start, last, count } in ticks
       shotInterval: 0,               // ms per bullet
       hitDamage: []                  // per-tick damage samples
     };
   }

   function pushSample(list, value) {
     list.push(value);
     if (list.length > LEARN_SAMPLES) list.shift();
   }

   function medianOf(list) {
     const sorted = list.slice().sort((a, b) => a - b);
     const mid = sorted.length >> 1;
     return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
   }

   /** Upgrades and new tanks change shot stats, so start over per tank. */
   function farmLearnForTank() {
     const learn = hud.farmLearn;
     if (learn.tankId !== hud.myTankId) {
       hud.farmLearn = newFarmLearn();
       hud.farmLearn.tankId = hud.myTankId;
     }
     return hud.farmLearn;
   }

   /**
    * Upgrading a stat makes the matching measurement stale, so it starts
    * over. Bullet HP and speed are read from live bullets and need no reset.
    */
   function onStatsChanged(names) {
     const learn = hud.farmLearn;
     if (names.includes('Reload')) {
       learn.run = null;
       learn.shotInterval = 0;
     }
     if (names.includes('Bullet Damage')) learn.hitDamage = [];
   }

   /** A new class has different barrels, so every shot measurement restarts. */
   function onClassChanged() {
     hud.farmLearn = newFarmLearn();
     hud.farmLearn.tankId = hud.myTankId;
     hud.farmBulletSample = null;
   }

   /** Called for each bullet your tank fires. */
   function recordShot() {
     const learn = farmLearnForTank();
     const run = learn.run;
     const tick = hud.tick;

     if (!run || (tick - run.last) * hud.tickMs > SHOT_GAP_MAX_MS) {
       learn.run = { start: tick, last: tick, count: 1 };
       return;
     }
     run.last = tick;
     run.count++;

     // Bullets per tick over the whole run, so volleys (several bullets
     // in one tick) and alternating barrels both average out.
     if (run.count >= SHOT_RUN_MIN_BULLETS && run.last > run.start) {
       const interval = (run.last - run.start) * hud.tickMs / (run.count - 1);
       learn.shotInterval = learn.shotInterval
         ? learn.shotInterval + (interval - learn.shotInterval) * 0.3
         : interval;
     }
   }

   /** Damage per tick from shapes hit only by your bullets this packet. */
   function learnHitDamage() {
     if (!hud.packetHits.length || hud.myTankId == null) return;
     const learn = farmLearnForTank();
     const others = [...hud.entities.values(), ...hud.packetRemoved];

     for (const { e, drop } of hud.packetHits) {
       let mine = 0;
       let other = false;

       for (const o of others) {
         if (o === e || !o.hasPosition) continue;
         const kind = entityKind(o);
         if (!kind || kind === 'shape' || kind === 'crasher') continue;

         const reach = e.size + o.size + CONTACT_SLACK;
         if ((o.x - e.x) ** 2 + (o.y - e.y) ** 2 > reach * reach) continue;

         if (kind === 'bullet' && o.owner === hud.myTankId) {
           mine++;
         } else {
           other = true;  // your body, a teammate or an enemy also touching
           break;
         }
       }
       if (mine && !other) pushSample(learn.hitDamage, drop / mine);
     }
   }

   function learnedHitDamage() {
     const { hitDamage, tankId } = hud.farmLearn;
     return tankId === hud.myTankId && hitDamage.length >= 2 ? medianOf(hitDamage) : 0;
   }

   function learnedShotInterval() {
     const { shotInterval, tankId } = hud.farmLearn;
     return tankId === hud.myTankId ? shotInterval : 0;
   }

   // -----------------------------------------------------------------
   // Wider View
   //
   // The game's zoom comes from your camera's field of view, which the
   // server sends when you spawn (camera creation) and when you level up
   // (update field 52). Scaling it down in the decrypted packet, before
   // the game reads it, makes the game draw a wider area. The server only
   // sends things a little beyond the normal view, so past that margin
   // the edges are empty.
   // -----------------------------------------------------------------

   /**
    * Byte offsets of the FOV floats in a decrypted update packet, for your
    * camera only. Records the decoder can't read end the search.
    */
   function fovOffsets(b) {
     const r = { b, dv: new DataView(b.buffer, b.byteOffset, b.byteLength), i: 1 };
     const offsets = [];
     let cameraId = hud.cameraId;

     readVarint(r);
     readVarint(r); // tick
     const deleteCount = readVarint(r);
     for (let k = 0; k < deleteCount; k++) {
       readVarint(r);
       readVarint(r);
     }

     const count = readVarint(r);
     for (let k = 0; k < count; k++) {
       readVarint(r); // generation
       const id = readVarint(r);
       const kind = readVarint(r);
       if (id >= 16384 || kind > 1) break;
       const bits = readBits(r);

       if (kind === 0) {
         for (const bit of bits) {
           const type = FIELD_TYPES[bit];
           if (!type) return offsets;
           if (bit === FIELD.FOV && id === cameraId) offsets.push(r.i);
           READERS[type](r);
         }
         continue;
       }

       const comps = new Set(bits);
       if (!componentsKnown(comps)) return offsets;
       for (const [comp, layout] of CREATE_SLOTS) {
         if (!comps.has(comp)) continue;
         for (let j = 0; j < layout.length; j++) {
           if (comp === COMP.CAMERA && j === CAMERA_FOV) {
             offsets.push(r.i);
             cameraId = id;
           }
           READERS[layout[j]](r);
         }
       }
     }
     return offsets;
   }

   /** Scales your camera's FOV in place in the game's memory. */
   function widenView(packet) {
     if (packet[0] !== 0) return;
     try {
       const offsets = fovOffsets(packet);
       if (!offsets.length) return;
       const dv = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
       const factor = 1 / (1 + settings.widerViewPercent / 100);
       for (const offset of offsets) {
         const fov = dv.getFloat32(offset, true);
         if (fov > 0 && fov < 10) dv.setFloat32(offset, fov * factor, true);
       }
     } catch {
       // Leave the packet untouched if anything doesn't parse.
     }
   }

   // -----------------------------------------------------------------
   // Packet capture
   // -----------------------------------------------------------------

   /**
    * Captures plaintext packets.
    *
    * The game's socket glue copies each incoming message into WASM memory
    * and queues a [1, pointer, length] event. While the game dispatches
    * it, the first import call after those bytes change marks the moment
    * they've been decrypted, so we copy them out then.
    */
   function installPacketCapture() {
     /** Copies the pending message out once its first bytes change. */
     function checkDecrypted() {
       const p = hud.pending;
       if (!p || p.done || !hud.memory) return;

       const current = new Uint8Array(hud.memory.buffer, p.ptr, p.len);
       for (let i = 0; i < p.cipher.length; i++) {
         if (current[i] !== p.cipher[i]) {
           p.done = true;
           // Widen before copying, so the HUD decodes the FOV the game uses.
           if (settings.widerView) widenView(current);
           hud.queue.push(current.slice());
           scheduleDecode();
           return;
         }
       }
     }

     /** Finds the Memory among exports or imports (one level deep). */
     function findMemory(...objects) {
       for (const object of objects) {
         if (!object) continue;
         for (const value of Object.values(object)) {
           if (value instanceof WebAssembly.Memory) return value;
           if (value && typeof value === 'object') {
             for (const inner of Object.values(value)) {
               if (inner instanceof WebAssembly.Memory) return inner;
             }
           }
         }
       }
       return null;
     }

     // Wrap every imported function so decryption can be noticed from
     // inside the game's dispatch, then remember the instance's memory.
     const wrapInstantiate = original => function (source, imports) {
       if (imports && typeof imports === 'object') {
         for (const namespace of Object.values(imports)) {
           if (!namespace || typeof namespace !== 'object') continue;

           for (const key of Object.keys(namespace)) {
             const fn = namespace[key];
             if (typeof fn !== 'function') continue;

             namespace[key] = function () {
               if (hud.pending && !hud.pending.done) checkDecrypted();
               return fn.apply(this, arguments);
             };
           }
         }
       }

       return original.call(WebAssembly, source, imports).then(result => {
         const instance = result.instance || result;
         hud.memory = findMemory(instance.exports) ||
           findMemory(imports) || hud.memory;
         return result;
       });
     };

     WebAssembly.instantiate = wrapInstantiate(WebAssembly.instantiate);
     if (WebAssembly.instantiateStreaming) {
       WebAssembly.instantiateStreaming =
         wrapInstantiate(WebAssembly.instantiateStreaming);
     }

     // The glue assigns `socket.events = []` once per connection and
     // pushes an event for each message it has copied into memory.
     Object.defineProperty(WebSocket.prototype, 'events', {
       configurable: true,
       get() {
         return this.__dapEvents;
       },
       set(list) {
         if (Array.isArray(list)) {
           resetEntities();
           const push = list.push;

           list.push = function (entry) {
             try {
               if (entry && entry[0] === 1 && entry[2] > 0 && hud.memory) {
                 hud.pending = {
                   ptr: entry[1],
                   len: entry[2],
                   cipher: new Uint8Array(
                     hud.memory.buffer,
                     entry[1],
                     Math.min(entry[2], 32)
                   ).slice(),
                   done: false
                 };
               }
             } catch {
               hud.pending = null;
             }
             return push.apply(this, arguments);
           };
         }
         this.__dapEvents = list;
       }
     });

     // Bracket each message handler so a capture never leaks into the next
     // message, and count messages whose decryption we didn't see.
     const onMessage =
       Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');

     Object.defineProperty(WebSocket.prototype, 'onmessage', {
       configurable: true,
       get() {
         return onMessage.get.call(this);
       },
       set(handler) {
         if (typeof handler !== 'function') {
           return onMessage.set.call(this, handler);
         }

         return onMessage.set.call(this, function (event) {
           hud.pending = null;
           try {
             return handler.call(this, event);
           } finally {
             if (hud.pending && !hud.pending.done) hud.stats.misses++;
             hud.pending = null;
           }
         });
       }
     });
   }

   installPacketCapture();

   // -----------------------------------------------------------------
   // Classification
   // -----------------------------------------------------------------

   /**
    * Your tank: the camera names it at spawn; otherwise it's the tank
    * whose owner is your camera.
    */
   function findMyTank() {
     let me = hud.myTankId != null && hud.entities.get(hud.myTankId);

     if (!me || !me.comps.has(COMP.TANK)) {
       me = null;
       if (hud.cameraId != null) {
         for (const e of hud.entities.values()) {
           if (e.comps.has(COMP.TANK) && e.owner === hud.cameraId) {
             hud.myTankId = e.id;
             me = e;
             break;
           }
         }
       }
     }

     if (me) hud.myColor = me.color;
     return me;
   }

   /**
    * The entity's kind, or null for things we don't draw (barrels,
    * decorations, cameras, entities whose type we never saw).
    */
   function entityKind(e) {
     const c = e.comps;
     if (c.has(COMP.TANK)) return 'tank';
     if (c.has(COMP.NAME) && c.has(COMP.HEALTH)) {
       return e.color === CRASHER_COLOR ? 'crasher' : 'shape';
     }
     if (c.has(COMP.PHYSICS) && c.has(COMP.HEALTH)) {
       if (e.sides === 1) return 'bullet';
       if (e.flags & DRONE_FLAG || e.sides === 4) return 'drone';
       if (e.sides === 3) return 'trap';
       return 'projectile';
     }
     return null;
   }

   /** Shapes and crashers: named, with health, and not a tank. */
   function isShapeEntity(e) {
     return e.comps.has(COMP.NAME) && e.comps.has(COMP.HEALTH) &&
       !e.comps.has(COMP.TANK);
   }

   /** Projectiles get thinner rings and no labels. */
   function isProjectile(kind) {
     return kind === 'bullet' || kind === 'drone' ||
       kind === 'trap' || kind === 'projectile';
   }

   /** Follows owner links (drone → tank) up to the owning tank's id. */
   function ownerTank(e) {
     let id = e.owner;
     for (let depth = 0; depth < 4 && id != null; depth++) {
       const owner = hud.entities.get(id);
       if (!owner) return id;
       if (owner.comps.has(COMP.TANK)) return owner.id;
       id = owner.owner;
     }
     return id;
   }

   /** self, own (your projectiles), team, enemy, neutral or hostile. */
   function entityRelation(e, kind, me) {
     if (me && e.id === me.id) return 'self';
     if (kind === 'shape') return 'neutral';
     if (kind === 'crasher') return 'hostile';
     if (me && kind !== 'tank' && ownerTank(e) === me.id) return 'own';
     if (TEAM_COLORS[e.color] && e.color === hud.myColor) return 'team';
     return 'enemy';
   }

   /** Label text, e.g. `Enemy "Name" · Red 120/200` or `Square 10/10`. */
   function entityLabel(e, kind, relation) {
     const team = TEAM_COLORS[e.color];
     const hp = e.maxHealth
       ? ` ${Math.max(0, Math.round(e.health))}/${Math.round(e.maxHealth)}`
       : '';

     if (kind === 'tank') {
       const who = relation === 'self' ? 'You'
         : relation === 'team' ? 'Teammate' : 'Enemy';
       const name = e.name ? ` "${e.name}"` : '';
       // Only your own class is sent by the game.
       const tankClass = relation === 'self' && hud.tank
         ? ` · ${tankClassName(hud.tank.classId)}` : '';
       return `${who}${name}${tankClass}${team ? ` · ${team}` : ''}${hp}`;
     }
     if (kind === 'shape' || kind === 'crasher') {
       return `${e.name || kind}${hp}`;
     }
     const whose = relation === 'own' ? 'Your'
       : relation === 'team' ? 'Team' : 'Enemy';
     return `${whose} ${kind}`;
   }

   // -----------------------------------------------------------------
   // Draw capture
   //
   // Circles (tanks, bullets) are drawn as setTransform(r, 0, 0, r, x, y)
   // + arc(0, 0, 1). Polygons (shapes, drones) are drawn as a screen-space
   // path that ends with closePath and a moveTo to the centre. The
   // background grid is a large fillRect whose transform is the view
   // scale. Each recorded shape is a "blob": { x, y, r, round }.
   // -----------------------------------------------------------------

   const draw = {
     canvas: null,           // the game's canvas (#canvas)
     blobs: [],              // shapes drawn so far this frame, canvas px
     barrels: [],            // candidate barrel ends, canvas px
     barrelPaths: [],
     frameAt: 0,             // when the current game frame started
     gridScale: 0,           // canvas px per world unit
     transform: [1, 0, 0, 1, 0, 0],
     path: [],
     pathClosed: false,
     scheduled: false
   };

   /** Wraps the 2D-context calls the game draws entities with. */
   function installDrawCapture() {
     const proto = CanvasRenderingContext2D.prototype;
     const original = {
       clearRect: proto.clearRect,
       setTransform: proto.setTransform,
       beginPath: proto.beginPath,
       rect: proto.rect,
       roundRect: proto.roundRect,
       fill: proto.fill,
       fillRect: proto.fillRect,
       arc: proto.arc,
       moveTo: proto.moveTo,
       lineTo: proto.lineTo,
       closePath: proto.closePath
     };

     /** Whether a call targets the game's canvas (found by its id). */
     function isGame(ctx) {
       const canvas = ctx.canvas;
       if (canvas === draw.canvas) return true;
       if (canvas && canvas.id === 'canvas') {
         draw.canvas = canvas;
         return true;
       }
       return false;
     }

     /** Applies the current transform to a point. */
     function point(x, y) {
       const [a, b, c, d, e, f] = draw.transform;
       return [a * x + c * y + e, b * x + d * y + f];
     }

     function barrelPoint(ctx, x, y) {
       const { a, b, c, d, e, f } = ctx.getTransform();
       return [a * x + c * y + e, b * x + d * y + f];
     }

     function barrelRect(ctx, x, y, w, h) {
       return [barrelPoint(ctx, x, y), barrelPoint(ctx, x + w, y),
         barrelPoint(ctx, x + w, y + h), barrelPoint(ctx, x, y + h)];
     }

     function barrelPaint(ctx) {
       const color = ctx.fillStyle;
       if (ctx.globalAlpha < 0.45 || typeof color !== 'string' || color.length !== 7 ||
           color[0] !== '#') return false;
       const channel = color.slice(1, 3);
       const value = Number.parseInt(channel, 16);
       return color === `#${channel}${channel}${channel}` && value >= 110 && value <= 190;
     }

     // The archived visual HUD identifies gun barrels from gray, elongated quads.
     function captureBarrel(corners) {
       if (draw.barrels.length >= 256 || corners.length < 4 || corners.length > 5) return;
       const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
       if (corners.length === 5 && distance(corners[0], corners[4]) > 0.5) return;
       const first = distance(corners[0], corners[1]);
       const second = distance(corners[1], corners[2]);
       const length = Math.max(first, second);
       const width = Math.min(first, second);
       if (!Number.isFinite(width + length) || width < 3 ||
           length < width * 1.22 || length > width * 7) return;
       const shift = first > second ? 1 : 0;
       const midpoint = i => {
         const a = corners[i];
         const b = corners[(i + 1) % 4];
         return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
       };
       draw.barrels.push({ ends: [midpoint(shift), midpoint(shift + 2)], width, length });
     }

     // A full-canvas clear starts a game frame. The HUD is drawn in a
     // microtask, which runs as soon as the game's frame callback returns,
     // so both show the same frame.
     proto.clearRect = function (x, y, w, h) {
       if (isGame(this) && w >= this.canvas.width && h >= this.canvas.height) {
         draw.blobs = [];
         draw.barrels = [];
         draw.barrelPaths = [];
         draw.path = [];
         draw.pathClosed = false;
         draw.frameAt = performance.now();
         if (!draw.scheduled) {
           draw.scheduled = true;
           queueMicrotask(() => {
             draw.scheduled = false;
             renderHud();
           });
         }
       }
       return original.clearRect.apply(this, arguments);
     };

     proto.setTransform = function (a, b, c, d, e, f) {
       if (typeof a === 'number' && isGame(this)) {
         draw.transform = [a, b, c, d, e, f];
       }
       return original.setTransform.apply(this, arguments);
     };

     proto.fillRect = function (x, y, w, h) {
       if (isGame(this)) {
         if (w > 100 && h > 100) {
           const [a, b, c, d] = draw.transform;
           if (b === 0 && c === 0 && a === d && a > 0) draw.gridScale = a;
         }
         if (settings.bulletSpread && barrelPaint(this)) {
           captureBarrel(barrelRect(this, x, y, w, h));
         }
       }
       return original.fillRect.apply(this, arguments);
     };

     proto.beginPath = function () {
       if (settings.bulletSpread && isGame(this)) draw.barrelPaths = [];
       return original.beginPath.apply(this, arguments);
     };

     for (const method of ['rect', 'roundRect']) {
       if (typeof original[method] !== 'function') continue;
       proto[method] = function (x, y, w, h) {
         if (settings.bulletSpread && isGame(this) && draw.barrelPaths.length < 24) {
           draw.barrelPaths.push(barrelRect(this, x, y, w, h));
         }
         return original[method].apply(this, arguments);
       };
     }

     proto.fill = function (rule) {
       if (settings.bulletSpread && isGame(this) &&
           (rule === undefined || typeof rule === 'string') && barrelPaint(this)) {
         for (const part of draw.barrelPaths) captureBarrel(part);
       }
       return original.fill.apply(this, arguments);
     };

     proto.arc = function (x, y, r) {
       if (isGame(this)) {
         const [a, b] = draw.transform;
         const [cx, cy] = point(x, y);
         draw.blobs.push({ x: cx, y: cy, r: r * Math.hypot(a, b), round: true });
       }
       return original.arc.apply(this, arguments);
     };

     proto.moveTo = function (x, y) {
       if (isGame(this)) {
         if (settings.bulletSpread && draw.barrelPaths.length < 24) {
           draw.barrelPaths.push([barrelPoint(this, x, y)]);
         }
         const p = point(x, y);
         if (draw.pathClosed && draw.path.length > 2) {
           let r = 0;
           for (const q of draw.path) {
             r = Math.max(r, Math.hypot(q[0] - p[0], q[1] - p[1]));
           }
           draw.blobs.push({ x: p[0], y: p[1], r, round: false });
         }
         draw.path = [p];
         draw.pathClosed = false;
       }
       return original.moveTo.apply(this, arguments);
     };

     proto.lineTo = function (x, y) {
       if (isGame(this)) {
         draw.path.push(point(x, y));
         if (settings.bulletSpread) {
           const part = draw.barrelPaths.at(-1);
           if (part && part.length < 6) part.push(barrelPoint(this, x, y));
         }
       }
       return original.lineTo.apply(this, arguments);
     };

     proto.closePath = function () {
       if (isGame(this)) draw.pathClosed = true;
       return original.closePath.apply(this, arguments);
     };
   }

   installDrawCapture();

   /**
    * This frame's drawn shapes in CSS pixels. Shapes sharing a centre
    * (a tank's body and outline) are merged into one.
    */
   function drawnBlobs() {
     const canvas = draw.canvas;
     if (!canvas || !canvas.width) return [];

     const rect = canvas.getBoundingClientRect();
     const k = rect.width / canvas.width;
     const out = [];

     for (const b of draw.blobs) {
       const x = rect.left + b.x * k;
       const y = rect.top + b.y * k;
       const r = b.r * k;
       const same = out.find(o => Math.abs(o.x - x) < 1.5 && Math.abs(o.y - y) < 1.5);
       if (same) {
         same.r = Math.max(same.r, r);
         same.round = same.round || b.round;
       } else {
         out.push({ x, y, r, round: b.round, used: false });
       }
     }
     return out;
   }

   // -----------------------------------------------------------------
   // Matching predictions to drawn shapes
   //
   // An "item" is an entity's predicted ring on screen: { e, kind,
   // projectile, x, y, r }. snapItems() moves items onto blobs.
   // -----------------------------------------------------------------

   /**
    * Whether a drawn shape could be this entity: circles for tanks and
    * bullets, polygons for shapes and drones, and a plausible size.
    */
   function shapeFits(item, b) {
     const sides = item.e.sides;
     if (sides && (sides <= 1) !== b.round) return false;
     return b.r > item.r * 0.4 && b.r < item.r * 2.5 + 6;
   }

   // Largest change in camera correction considered between frames, and
   // how closely two votes must agree to count together.
   const OFFSET_SEARCH_PX = 400;
   const OFFSET_AGREE_PX = 8;
   const OFFSET_MAX_VOTES = 800;

   /**
    * Finds the camera correction: the shift that lines predictions up with
    * drawn shapes. Every compatible item/shape pair near last frame's
    * correction votes for its offset; the offset most votes agree on wins.
    * Recoil can move it by hundreds of pixels in a few frames.
    */
   function estimateDrawOffset(items, blobs) {
     const [px, py] = hud.drawOffset;
     const votes = [];

     for (const item of items) {
       // Small projectiles are numerous and alike; let larger bodies vote.
       if (item.r < 6 && items.length > 8) continue;

       for (const b of blobs) {
         const dx = b.x - item.x;
         const dy = b.y - item.y;
         if (Math.hypot(dx - px, dy - py) < OFFSET_SEARCH_PX &&
             shapeFits(item, b)) {
           votes.push([dx, dy]);
         }
       }
       if (votes.length > OFFSET_MAX_VOTES) break;
     }

     if (!votes.length) return hud.drawOffset;

     const agrees = (a, b) =>
       Math.abs(a[0] - b[0]) < OFFSET_AGREE_PX &&
       Math.abs(a[1] - b[1]) < OFFSET_AGREE_PX;

     let best = null;
     let bestCount = 0;
     let bestPrior = Infinity;
     for (const vote of votes) {
       let count = 0;
       for (const other of votes) if (agrees(vote, other)) count++;

       // Ties go to the offset closest to last frame's.
       const prior = Math.hypot(vote[0] - px, vote[1] - py);
       if (count > bestCount || (count === bestCount && prior < bestPrior)) {
         best = vote;
         bestCount = count;
         bestPrior = prior;
       }
     }

     // A lone vote is only trusted when it's close to last frame's.
     if (bestCount < 2 && bestPrior >= 40) return hud.drawOffset;

     let sx = 0;
     let sy = 0;
     let k = 0;
     for (const vote of votes) {
       if (agrees(best, vote)) {
         sx += vote[0];
         sy += vote[1];
         k++;
       }
     }

     hud.drawOffset = [sx / k, sy / k];
     return hud.drawOffset;
   }

   // How long an entity's own draw offset is remembered between frames.
   const SNAP_MEMORY_MS = 250;

   /**
    * Moves each predicted ring onto the shape the game drew for it.
    *
    * After the shared camera correction, each entity starts from the
    * offset it had from its own shape last frame (your tank, for one,
    * lags further behind during hard stops). Pairs are then assigned
    * closest-first, only between compatible shapes, so neighbours in a
    * crowd don't steal each other's shape.
    */
   function snapItems(items, blobs, now) {
     const [dx, dy] = estimateDrawOffset(items, blobs);

     for (const item of items) {
       item.x += dx;
       item.y += dy;
       item.baseX = item.x;
       item.baseY = item.y;

       const e = item.e;
       if (e.snapOffset && now - e.snapAt < SNAP_MEMORY_MS) {
         item.x += e.snapOffset[0];
         item.y += e.snapOffset[1];
       }
     }

     const pairs = [];
     for (let i = 0; i < items.length; i++) {
       const item = items[i];
       const tolerance = Math.max(12, item.r * 1.6);

       for (const b of blobs) {
         if (!shapeFits(item, b)) continue;
         const dist = Math.hypot(b.x - item.x, b.y - item.y);
         if (dist >= tolerance) continue;
         const sizeError = Math.abs(b.r - item.r) / Math.max(item.r, 4);
         pairs.push([dist + item.r * 0.5 * Math.min(sizeError, 1), i, b]);
       }
     }
     pairs.sort((a, b) => a[0] - b[0]);

     const done = new Set();
     for (const [, i, b] of pairs) {
       if (done.has(i) || b.used) continue;
       done.add(i);
       b.used = true;

       // Remember this entity's own offset, capped so a wrong match can't
       // drag it far.
       const item = items[i];
       const limit = Math.max(20, item.r * 1.5);
       let ox = b.x - item.baseX;
       let oy = b.y - item.baseY;
       const length = Math.hypot(ox, oy);
       if (length > limit) {
         ox *= limit / length;
         oy *= limit / length;
       }
       item.e.snapOffset = [ox, oy];
       item.e.snapAt = now;

       item.x = b.x;
       item.y = b.y;
       item.r = Math.max(4, b.r);
       item.snapped = true;
     }

     // Unmatched entities fall back to their prediction gradually.
     for (const item of items) {
       const offset = item.e.snapOffset;
       if (!item.snapped && offset) {
         offset[0] *= 0.8;
         offset[1] *= 0.8;
       }
     }
   }

   // -----------------------------------------------------------------
   // Overlay
   // -----------------------------------------------------------------

   // The game's camera eases toward its target, trailing it while you
   // move. This is only the first guess: snapItems() corrects the rest.
   const CAMERA_FOLLOW_SECONDS = 0.05;

   // Draw-capture data older than this is ignored.
   const DRAW_FRESH_MS = 100;
   const FARM_PACKET_FRESH_MS = 500;

   /** Resolves a normalized position within the space available to this panel. */
   function hudWidgetRect(id, width, height, position = settings.hudLayout[id]) {
     const widget = HUD_WIDGETS[id];
     const insetX = Math.min(widget.inset, width / 2);
     const insetY = Math.min(widget.inset, height / 2);
     const panelWidth = Math.min(widget.width, width - 2 * insetX);
     const panelHeight = Math.min(widget.height, height - 2 * insetY);
     const travelX = width - 2 * insetX - panelWidth;
     const travelY = height - 2 * insetY - panelHeight;
     return {
       x: insetX + position.x * travelX,
       y: insetY + position.y * travelY,
       width: panelWidth,
       height: panelHeight,
       insetX, insetY, travelX, travelY
     };
   }

   const FARM_POLYGON_TYPES = {
     3: 'triangle',
     4: 'square',
     5: 'pentagon',
     6: 'hexagon'
   };

   /** Returns the reward (fixed XP per shape type) and collision profile. */
   function farmingShape(e, kind) {
     if (kind !== 'shape' && kind !== 'crasher') return null;

     const name = e.name.toLowerCase();
     const shiny = e.color === SHINY_COLOR || /^(green|shiny)\b/.test(name);
     const xpMultiplier = shiny ? 100 : 1;

     if (kind === 'crasher' || /\bcrasher\b/.test(name)) {
       const large = name.includes('large crasher') ||
         e.maxHealth >= (shiny ? 200 : 20);
       const mini = name.includes('mini crasher');
       return {
         type: 'crasher',
         value: mini ? 0 : (large ? 25 : 15) * xpMultiplier,
         contactDamage: mini ? null : 8
       };
     }

     let type = FARM_POLYGON_TYPES[e.sides] ??
       name.match(/\b(square|triangle|pentagon|hexagon)\b/)?.[1] ?? 'other';
     // Alpha Pentagons can have the same label as regular Pentagons.
     if (name.includes('alpha pentagon') ||
         (type === 'pentagon' &&
          (e.size >= 75 || e.maxHealth >= (shiny ? 3000 : 1000)))) {
       type = 'alphaPentagon';
     }

     const { xp, contactDamage } = FARM_TARGETS[type];
     return { type: shiny ? 'shiny' : type, value: xp * xpMultiplier, contactDamage };
   }

   const BULLET_SAMPLE_MS = 5000;
   const MOTION_SAMPLE_MS = 350;
   const FALLBACK_SHOT_SPEED = 600;     // world units/s
   const FALLBACK_SHOT_DAMAGE = 20;     // HP per bullet, before measurement
   const FALLBACK_SHOT_INTERVAL = 450;  // ms per bullet, before measurement
   const FARM_SWITCH_MARGIN = 0.15;     // how much better a new target must be

   /**
    * Your bullets' stats: largest radius, lowest full HP and median speed
    * across the bullets you own, plus measured damage per hit. Typed-in
    * values override the measurements.
    */
   function farmingProjectile(me, now, scale) {
     let radius = 0;
     let hp = Infinity;
     const speeds = [];
     for (const e of hud.entities.values()) {
       if (e.sides !== 1 || !e.hasPosition || (e.health ?? 1) <= 0 ||
           e.opacity < 0.05 || entityKind(e) !== 'bullet' || ownerTank(e) !== me.id) {
         continue;
       }
       if (Number.isFinite(e.size)) radius = Math.max(radius, e.size);
       if (Number.isFinite(e.maxHealth) && e.maxHealth > 0) hp = Math.min(hp, e.maxHealth);
       if (now - e.motionAt <= MOTION_SAMPLE_MS) {
         const velocity = Math.hypot(e.vx, e.vy);
         if (Number.isFinite(velocity) && velocity > 0) speeds.push(velocity);
       }
     }
     const speed = speeds.length ? medianOf(speeds) : 0;

     if (radius > 0 || Number.isFinite(hp)) {
       hud.farmBulletSample = {
         tank: me, at: now, radius, speed, hp: Number.isFinite(hp) ? hp : 0
       };
     }
     const sample = hud.farmBulletSample;
     const recent = sample?.tank === me && now - sample.at <= BULLET_SAMPLE_MS ? sample : null;
     return {
       radius: (recent?.radius ?? 0) * scale,
       speed: recent?.speed ?? 0,
       hp: recent?.hp || 0,
       damage: learnedHitDamage()
     };
   }

   function farmingShotSpeed(projectile) {
     return Math.max(1, projectile.speed || FALLBACK_SHOT_SPEED);
   }

   function dampedLeadTime(flight, decay) {
     const horizon = Math.min(SHAPE_LEAD_HORIZON, flight);
     const confidence = Math.max(0, Math.min(1,
       (SHAPE_LEAD_CUTOFF - flight) / (SHAPE_LEAD_CUTOFF - SHAPE_LEAD_HORIZON)));
     return confidence * (decay > 0 ? -Math.expm1(-decay * horizon) / decay : horizon);
   }

   function farmingAimPoint(player, target, projectile, now, scale, bounds) {
     const motion = target.e.leadMotion;
     if (!settings.farmLeadShapes || !motion || motion.count < 2 ||
         now - motion.at > SHAPE_LEAD_FRESH_MS) return target;

     const speed = farmingShotSpeed(projectile) * scale;
     const vx = motion.vx * scale;
     const vy = motion.vy * scale;
     const dx = target.x - player.x;
     const dy = target.y - player.y;
     const initial = dampedLeadTime(Math.hypot(dx, dy) / speed, motion.decay);
     if (!(initial > 0)) return target;

     const flight = Math.hypot(dx + vx * initial, dy + vy * initial) / speed;
     const leadTime = dampedLeadTime(flight, motion.decay);
     const x = target.x + vx * leadTime;
     const y = target.y + vy * leadTime;
     return leadTime > 0 && pointInBounds(x, y, bounds) ? { x, y, leadTime } : target;
   }

   /**
    * Finds the living shapes between you and the target, nearest first,
    * and whether one bullet can punch through all of them with HP left to
    * hit the target (`through`, with `hp` remaining).
    */
   function farmingLineOfFire(player, target, point, blockers, projectile, distanceSquared) {
     const clear = { blocking: [], through: true, hp: projectile.hp };
     const distance = Math.sqrt(distanceSquared);
     const targetRadius = Number.isFinite(target.r) ? target.r : 0;
     const length = distance - targetRadius - projectile.radius;
     if (length <= 0) return clear;

     const ux = (point.x - player.x) / distance;
     const uy = (point.y - player.y) / distance;
     const blocking = [];

     for (const blocker of blockers) {
       if (blocker === target || !Number.isFinite(blocker.r)) continue;
       const radius = blocker.r + projectile.radius;
       const dx = blocker.x - player.x;
       const dy = blocker.y - player.y;
       const along = dx * ux + dy * uy;
       if (along + radius < 0 || along - radius >= length) continue;

       const across = dx * uy - dy * ux;
       const chordSquared = radius ** 2 - across ** 2;
       if (chordSquared < 0) continue;
       const halfChord = Math.sqrt(chordSquared);
       if (!(along + halfChord >= 0 && along - halfChord < length)) continue;

       blocking.push({ blocker, along });
     }
     if (!blocking.length) return clear;
     blocking.sort((a, b) => a.along - b.along);

     // Spend bullet HP on each blocker in whole contacts, keeping some
     // for the target. Unknown stats mean the bullet can't be trusted to
     // get through.
     let hp = projectile.hp;
     let through = hp > 0 && projectile.damage > 0;
     for (const { blocker } of blocking) {
       if (!through) break;
       const shapeHp = Number.isFinite(blocker.e.health) ? blocker.e.health : blocker.e.maxHealth;
       const { contactDamage } = blocker.farmShape;
       if (!Number.isFinite(shapeHp) || shapeHp <= 0 || !contactDamage) {
         through = false;
         break;
       }
       hp -= Math.ceil(shapeHp / projectile.damage) * contactDamage;
       through = hp > 0;
     }

     return { blocking: blocking.map(({ blocker }) => blocker), through, hp };
   }

   /**
    * Health one bullet removes from this target: damage per hit times the
    * hits a bullet survives against it (bullet HP / the shape's contact
    * damage).
    */
   function farmingShotDamage(target, projectile) {
     if (!(projectile.damage > 0)) return FALLBACK_SHOT_DAMAGE;

     const contact = target.farmShape.contactDamage;
     const hits = projectile.hp > 0 && contact
       ? Math.max(1, Math.ceil(projectile.hp / contact)) : 1;
     return projectile.damage * hits;
   }

   /**
    * Expected XP per second for a target: its XP over the time to finish
    * it, including travel time, reload and hit chance.
    *
    * Shapes in the way are part of the estimate. If bullets punch through
    * them, less damage reaches the target. If they don't, the blockers
    * have to be destroyed first: their time is added, and so is their XP,
    * since shots aimed at the target kill them on the way.
    */
   function estimateFarmingRate(player, target, point, distanceSquared, path, projectile, now, scale) {
     const { e, r, targetValue } = target;
     const health = Number.isFinite(e.health) ? e.health : e.maxHealth;
     if (!Number.isFinite(health) || health <= 0) return { rate: 0, seconds: Infinity };

     const distance = Math.sqrt(distanceSquared);
     const speed = farmingShotSpeed(projectile);
     const flight = distance / (speed * scale);
     const radius = Math.max(4, (Number.isFinite(r) ? r : 0) + projectile.radius);
     const recent = now - e.motionAt <= MOTION_SAMPLE_MS;
     const driftX = recent && e.vx ? e.vx * scale * flight : 0;
     const driftY = recent && e.vy ? e.vy * scale * flight : 0;
     const missX = target.x - point.x + driftX;
     const missY = target.y - point.y + driftY;
     const missRatio = distance > 0
       ? Math.abs(missX * (point.y - player.y) - missY * (point.x - player.x)) /
         (distance * radius) : 0;
     const hitChance = Number.isFinite(missRatio) ? 1 / (1 + missRatio ** 2) : 0;

     const interval = learnedShotInterval() || FALLBACK_SHOT_INTERVAL;
     const damage = farmingShotDamage(target, projectile);
     const blocked = path.blocking.length;
     let shotsNeeded = Math.ceil(health / damage);
     let clearSeconds = 0;
     let clearXp = 0;

     // Either way the blockers die and their XP is yours.
     for (const blocker of path.blocking) clearXp += blocker.farmShape.value || 0;

     if (blocked && path.through) {
       // The first bullet destroys the blockers and reaches the target
       // weakened; every later shot has a clear line.
       const contactDamage = target.farmShape.contactDamage;
       const reachable = contactDamage
         ? Math.ceil(path.hp / contactDamage) * projectile.damage
         : damage * path.hp / projectile.hp;
       const first = Math.min(damage, reachable);
       shotsNeeded = 1 + Math.ceil(Math.max(0, health - first) / damage);
     } else if (blocked) {
       // Bullets stop in the blockers, so they're shot down first.
       for (const blocker of path.blocking) {
         const hp = Number.isFinite(blocker.e.health) ? blocker.e.health : blocker.e.maxHealth;
         if (!Number.isFinite(hp) || hp <= 0) continue;
         clearSeconds += Math.ceil(hp / farmingShotDamage(blocker, projectile)) * interval / 1000;
       }
     }

     const shots = shotsNeeded / hitChance;
     const seconds = Math.max(0.08, flight + clearSeconds + (shots - 0.5) * interval / 1000);
     return {
       rate: (targetValue + clearXp) / seconds,
       seconds,
       penetrated: blocked && path.through ? blocked : 0,
       cleared: blocked && !path.through ? blocked : 0
     };
   }

   /**
    * Smart targeting: aims at the visible shape with the best expected XP
    * per second, where time includes travel, reload and hit chance.
    * The current target is kept until another is more than
    * FARM_SWITCH_MARGIN better, so aim doesn't flick between near-equal
    * shapes. Equal rates go to the closer shape.
    */
   function aimAtFarmingTarget(items, me, bounds, now, scale) {
     const player = items.find(item => item.e === me);
     if (!player || (player.e.health ?? 1) <= 0) {
       releaseFarmingAim();
       return null;
     }

     const lockTarget = hud.farmLock?.tank === me ? hud.farmLock.target : null;
     // Every living shape can block a shot, including types you don't farm.
     const blockers = items.filter(item => item.farmShape && (item.e.health ?? 1) > 0);
     const projectile = farmingProjectile(me, now, scale);
     let best = null;
     let incumbent = null;
     let candidates = 0;

     for (const item of items) {
       const { x, y, targetValue } = item;
       if (targetValue === null || (item.e.health ?? 1) <= 0 ||
           !pointInBounds(x, y, bounds)) continue;

       const distance = (x - player.x) ** 2 + (y - player.y) ** 2;
       if (!Number.isFinite(distance)) continue;

       const point = farmingAimPoint(player, item, projectile, now, scale, bounds);
       const shotDistance = point === item ? distance :
         (point.x - player.x) ** 2 + (point.y - player.y) ** 2;
       const path = farmingLineOfFire(player, item, point, blockers, projectile, shotDistance);

       const efficiency =
         estimateFarmingRate(player, item, point, shotDistance, path, projectile, now, scale);
       const candidate = { item, point, shotDistance, path, efficiency, distance };
       candidates++;
       if (item.e === lockTarget) incumbent = candidate;
       if (!best || efficiency.rate > best.efficiency.rate ||
           (efficiency.rate === best.efficiency.rate && distance < best.distance)) {
         best = candidate;
       }
     }

     const holding = Boolean(incumbent && incumbent !== best &&
       best.efficiency.rate <= incumbent.efficiency.rate * (1 + FARM_SWITCH_MARGIN));
     const winner = holding ? incumbent : best;
     const target = winner?.item ?? null;
     if (target) {
       hud.farmLock = { tank: me, target: target.e };
       farmingAiming = true;
       sendMouse(winner.point.x, winner.point.y);
     } else {
       releaseFarmingAim();
     }
     return {
       player, target, aimPoint: winner?.point, distanceSquared: winner?.shotDistance ?? Infinity,
       efficiency: winner?.efficiency, holding, candidates,
       penetrated: winner?.efficiency.penetrated ?? 0,
       cleared: winner?.efficiency.cleared ?? 0
     };
   }

   /** The smoothed camera position used for predictions. */
   function viewPosition(now) {
     const [tx, ty] = displayed(hud.cam, now);
     const view = hud.view;

     if (!view || Math.hypot(tx - view.x, ty - view.y) > 2000) {
       hud.view = { x: tx, y: ty, t: now };
       return [tx, ty];
     }

     const dt = Math.min(0.25, (now - view.t) / 1000);
     const k = 1 - Math.exp(-dt / CAMERA_FOLLOW_SECONDS);
     view.x += (tx - view.x) * k;
     view.y += (ty - view.y) * k;
     view.t = now;
     return [view.x, view.y];
   }

   /** Adds the overlay canvas above the game and starts the fallback loop. */
   function createHudOverlay() {
     const canvas = document.createElement('canvas');
     canvas.id = 'dap-entity-hud';
     canvas.style.cssText =
       'position:fixed;inset:0;width:100vw;height:100vh;' +
       'pointer-events:none;z-index:1;';
     document.body.appendChild(canvas);

     hud.canvas = canvas;
     hud.ctx = canvas.getContext('2d');
     requestAnimationFrame(hudLoop);
   }

   /**
    * Fallback loop for when the game isn't drawing (e.g. while loading).
    * While it is, renderHud() runs right after each game frame instead.
    */
   function hudLoop() {
     requestAnimationFrame(hudLoop);
     if (performance.now() - draw.frameAt > DRAW_FRESH_MS) renderHud();
   }

   /**
    * Projects entities for farming aim and the HUD, then draws the overlay.
    */
   function renderHud() {
     const canvas = hud.canvas;
     if (!canvas) return;

     const ctx = hud.ctx;
     const dpr = devicePixelRatio || 1;
     const width = innerWidth;
     const height = innerHeight;

     if (canvas.width !== Math.round(width * dpr) ||
         canvas.height !== Math.round(height * dpr)) {
       canvas.width = Math.round(width * dpr);
       canvas.height = Math.round(height * dpr);
     }

     ctx.setTransform(1, 0, 0, 1, 0, 0);
     ctx.clearRect(0, 0, canvas.width, canvas.height);

     const now = performance.now();
     const fresh = now - draw.frameAt < DRAW_FRESH_MS;
     const farming = farmingEnabled && !document.hidden &&
       document.hasFocus() && fresh && hud.cam &&
       now - hud.lastPacketAt < FARM_PACKET_FRESH_MS;
     const aimDebug = farmingEnabled && settings.farmAimDebug && !hudEdit;
     const arrayList = settings.arrayList && !hudEdit;
     const freshEntities = now - hud.lastPacketAt < FARM_PACKET_FRESH_MS;
     const tracers = settings.tracers && freshEntities && !hudEdit;
     const spread = settings.bulletSpread && fresh && freshEntities && !hudEdit;
     const hoverHud = settings.targetHud && !farmingEnabled && !menuOpen && freshEntities;

     if (!farming) releaseFarmingAim();
     ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
     if (aimDebug && !farming) {
       drawFarmAimDebug(ctx, width, height, null, 'Waiting for game data');
     }

     if (!hud.cam || !(farming || settings.entityHud || tracers || hoverHud || spread)) {
       if (settings.entityHud) {
         drawHudStatus(ctx, width, height, hud.stats.packets
           ? 'Entity HUD · waiting for camera (respawn if this persists)'
           : 'Entity HUD · no game packets captured yet');
       }
       if (arrayList) drawActiveModules(ctx, width, height, now);
       return;
     }

     const blobs = fresh ? drawnBlobs() : [];

     // World → screen: the game centres its camera on its canvas.
     const gameRect = draw.canvas && draw.canvas.getBoundingClientRect();
     const centerX = gameRect ? gameRect.left + gameRect.width / 2 : width / 2;
     const centerY = gameRect ? gameRect.top + gameRect.height / 2 : height / 2;
     const cssPerPixel = gameRect && draw.canvas.width
       ? gameRect.width / draw.canvas.width : 1;
     const scale = fresh && draw.gridScale
       ? draw.gridScale * cssPerPixel
       : hud.cam.fov * Math.max(width / 1920, height / 1080);
     const [camX, camY] = viewPosition(now);
     const me = findMyTank();
     const checkBlockers = farming;
     const bounds = {
       left: Math.max(0, gameRect?.left ?? 0),
       top: Math.max(0, gameRect?.top ?? 0),
       right: Math.min(width, gameRect?.right ?? width),
       bottom: Math.min(height, gameRect?.bottom ?? height)
     };

     // Predict where each entity should be from packets alone.
     const items = [];
     for (const e of hud.entities.values()) {
       if (!e.hasPosition || e.opacity < 0.05) continue;

       const kind = entityKind(e);
       if (!kind) continue;

       const projectile = isProjectile(kind);
       const visibleOnHud = settings.entityHud &&
         (!projectile || settings.hudProjectiles) &&
         ((kind !== 'shape' && kind !== 'crasher') || settings.hudShapes);
       const farmShape = farming ? farmingShape(e, kind) : null;
       const targetValue = farmShape && settings.farmTargets[farmShape.type]
         ? farmShape.value : null;
       const hoverTarget = hoverHud && e !== me && !projectile;
       const relation = tracers && e !== me ? entityRelation(e, kind, me) : null;
       const traceColor = relation && settings.tracerTargets[kind === 'tank' ? relation : kind]
         ? HUD_COLORS[relation] : null;
       if (!visibleOnHud && targetValue === null &&
           !((farming || tracers || hoverHud) && e === me) &&
           !(checkBlockers && farmShape) && !(spread && kind === 'tank') &&
           !hoverTarget && !traceColor) continue;

       const [wx, wy] = displayed(e, now);
       items.push({
         e, kind, projectile, visibleOnHud, targetValue, farmShape, hoverTarget, traceColor,
         x: (wx - camX) * scale + centerX,
         y: (wy - camY) * scale + centerY,
         r: Math.max(4, e.size * scale)
       });
     }

     if (blobs.length) snapItems(items, blobs, now);

     let aim = null;
     const canAim = farming && Number.isFinite(scale) && scale > 0 && gameRect;
     if (canAim) {
       aim = aimAtFarmingTarget(items, me, bounds, now, scale);
     } else {
       releaseFarmingAim();
     }

     if (spread && gameRect && Number.isFinite(scale) && scale > 0) {
       drawBulletSpread(ctx, items, me, bounds, gameRect, now, scale, aim?.aimPoint);
     }
     if (tracers) drawTracers(ctx, items, me, bounds);
     if (settings.entityHud) drawEntityHud(ctx, items, me, width, height);
     if (arrayList) drawActiveModules(ctx, width, height, now);
     if (settings.targetHud && !hudEdit) {
       const target = aim?.target ?? (hoverHud ? findHoverTarget(items, bounds) : null);
       if (target) drawTargetHud(ctx, width, height, target, me);
     }
     if (aimDebug && farming) {
       drawFarmAimDebug(ctx, width, height, aim, canAim ? undefined : 'Waiting for game canvas');
     }
   }

   function pointInBounds(x, y, bounds) {
     return x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom;
   }

   function angleDistance(a, b) {
     return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
   }

   /** Matches each visible gray barrel to the tank whose body it emerges from. */
   function spreadMuzzles(tanks, canvasRect) {
     const result = new Map();
     const scaleX = canvasRect.width / draw.canvas.width;
     const scaleY = canvasRect.height / draw.canvas.height;
     const scale = (scaleX + scaleY) / 2;
     for (const barrel of draw.barrels) {
       const [a, b] = barrel.ends.map(([x, y]) => ({
         x: canvasRect.left + x * scaleX, y: canvasRect.top + y * scaleY
       }));
       const width = barrel.width * scale;
       const length = barrel.length * scale;
       let best = null;
       let bestScore = Infinity;
       for (const tank of tanks.values()) {
         if (width > tank.r * 1.65 || length < tank.r * 0.55 || length > tank.r * 3.4) continue;
         const distA = Math.hypot(a.x - tank.x, a.y - tank.y);
         const distB = Math.hypot(b.x - tank.x, b.y - tank.y);
         const overlap = Math.min(distA, distB) / tank.r;
         const reach = Math.max(distA, distB) / tank.r;
         if (overlap > 1.1 || reach < 0.96 || reach > 3.7) continue;
         const [near, tip] = distA < distB ? [a, b] : [b, a];
         const dx = tip.x - near.x;
         const dy = tip.y - near.y;
         const lateral = Math.abs(dx * (tank.y - near.y) - dy * (tank.x - near.x)) /
           (length * tank.r);
         const score = overlap + lateral * 1.5;
         if (lateral <= 0.66 && score < bestScore) {
           best = { id: tank.e.id, ...tip, angle: Math.atan2(dy, dx), samples: [] };
           bestScore = score;
         }
       }
       if (!best) continue;
       if (!result.has(best.id)) result.set(best.id, []);
       const muzzles = result.get(best.id);
       if (!muzzles.some(muzzle => Math.hypot(best.x - muzzle.x, best.y - muzzle.y) < 3 &&
           angleDistance(best.angle, muzzle.angle) < 0.1)) muzzles.push(best);
     }
     return result;
   }

   function spreadShotAngles(tanks, now, scale) {
     const result = new Map();
     for (const shot of hud.entities.values()) {
       if (shot.sides !== 1 || !shot.hasPosition || now - shot.bornAt > 420 ||
           now - shot.motionAt > 120 || (shot.health ?? 1) <= 0 ||
           entityKind(shot) !== 'bullet') continue;
       const tank = tanks.get(ownerTank(shot));
       if (!tank) continue;

       const dx = (shot.x - tank.e.x) * scale;
       const dy = (shot.y - tank.e.y) * scale;
       const distance = Math.hypot(dx, dy);
       const speed = Math.hypot(shot.vx, shot.vy);
       if (distance < tank.r * 0.75 || distance > Math.min(300, tank.r * 12) || speed < 20 ||
           (dx * shot.vx + dy * shot.vy) < 0.65 * distance * speed) continue;

       const angle = Math.atan2(shot.vy, shot.vx);
       if (!result.has(tank.e.id)) result.set(tank.e.id, []);
       result.get(tank.e.id).push(angle);
     }
     return result;
   }

   function drawBulletSpread(ctx, items, me, bounds, canvasRect, now, scale, aimPoint) {
     const tanks = new Map(items.filter(item => item.kind === 'tank' &&
       (item.e.health ?? 1) > 0 && Number.isFinite(item.r) &&
       pointInBounds(item.x, item.y, bounds)
     ).map(item => [item.e.id, item]));
     if (!tanks.size) return;

     const renderedMuzzles = spreadMuzzles(tanks, canvasRect);
     const shots = spreadShotAngles(tanks, now, scale);
     const fallbackHalfAngle = settings.spreadHalfAngle * Math.PI / 180;
     const maxRange = Math.hypot(innerWidth, innerHeight);
     const allowed = { self: settings.spreadSelf, team: settings.spreadTeam, enemy: settings.spreadEnemy };

     ctx.save();
     ctx.beginPath();
     ctx.rect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top);
     ctx.clip();
     ctx.lineWidth = 1.25;
     for (const tank of tanks.values()) {
       const relation = entityRelation(tank.e, tank.kind, me);
       if (!allowed[relation]) continue;

       const angles = shots.get(tank.e.id) ?? [];
       const muzzles = renderedMuzzles.get(tank.e.id) ?? [];
       const hasRenderedMuzzle = muzzles.length > 0;
       if (!hasRenderedMuzzle) {
         const directions = [];
         for (const angle of angles) {
           if (!directions.some(direction => angleDistance(angle, direction) < Math.PI / 9)) {
             directions.push(angle);
           }
         }
         if (!directions.length && tank.e === me && (aimPoint || !menuOpen)) {
           const cursor = aimPoint ?? { x: mouseX, y: mouseY };
           if (Math.hypot(cursor.x - tank.x, cursor.y - tank.y) > 1) {
             directions.push(Math.atan2(cursor.y - tank.y, cursor.x - tank.x));
           }
         }
         for (const angle of directions) {
           muzzles.push({
             x: tank.x + Math.cos(angle) * tank.r, y: tank.y + Math.sin(angle) * tank.r,
             angle, samples: []
           });
         }
       }

       for (const angle of angles) {
         let nearest = null;
         let maxDelta = Math.PI / 6;
         for (const muzzle of muzzles) {
           const delta = angleDistance(angle, muzzle.angle);
           if (delta < maxDelta) {
             nearest = muzzle;
             maxDelta = delta;
           }
         }
         if (nearest) nearest.samples.push(maxDelta);
       }

       for (const muzzle of muzzles) {
         const observed = hasRenderedMuzzle && muzzle.samples.length >= 3;
         const halfAngle = observed
           ? Math.max(Math.PI / 90, ...muzzle.samples) : fallbackHalfAngle;
         // Length is set in tank radii; never longer than the screen.
         const range = Math.max(12, Math.min(maxRange, tank.r * settings.spreadLength));
         ctx.strokeStyle = HUD_COLORS[relation];
         ctx.fillStyle = HUD_COLORS[relation];
         ctx.setLineDash(observed ? [] : [5, 4]);
         ctx.beginPath();
         ctx.moveTo(muzzle.x, muzzle.y);
         ctx.arc(muzzle.x, muzzle.y, range, muzzle.angle - halfAngle, muzzle.angle + halfAngle);
         ctx.closePath();
         ctx.globalAlpha = observed ? 0.16 : 0.09;
         ctx.fill();
         ctx.globalAlpha = observed ? 0.84 : 0.72;
         ctx.stroke();
       }
     }
     ctx.restore();
   }

   function drawTracers(ctx, items, me, bounds) {
     const player = items.find(item => item.e === me);
     if (!player || (player.e.health ?? 1) <= 0 ||
         !pointInBounds(player.x, player.y, bounds)) return;

     const groups = new Map();
     for (const item of items) {
       if (!item.traceColor || (item.e.health ?? 1) <= 0 ||
           !pointInBounds(item.x, item.y, bounds)) continue;
       if (!groups.has(item.traceColor)) groups.set(item.traceColor, []);
       groups.get(item.traceColor).push(item);
     }

     ctx.save();
     ctx.globalAlpha = 0.66;
     ctx.lineWidth = 1.25;
     for (const [color, group] of groups) {
       ctx.strokeStyle = color;
       ctx.beginPath();
       for (const item of group) {
         ctx.moveTo(player.x, player.y);
         ctx.lineTo(item.x, item.y);
       }
       ctx.stroke();
     }
     ctx.restore();
   }

   function findHoverTarget(items, bounds) {
     if (!pointInBounds(mouseX, mouseY, bounds)) return null;
     let nearest = null;
     let bestDistance = Infinity;
     for (const item of items) {
       if (!item.hoverTarget || (item.e.health ?? 1) <= 0) continue;
       const distance = (mouseX - item.x) ** 2 + (mouseY - item.y) ** 2;
       if (distance <= item.r ** 2 && distance < bestDistance) {
         nearest = item;
         bestDistance = distance;
       }
     }
     return nearest;
   }

   function drawTargetHud(ctx, width, height, target, me) {
     const { e, kind } = target;
     const relation = entityRelation(e, kind, me);
     const shape = target.farmShape ?? farmingShape(e, kind);
     const type = kind === 'tank' ? (relation === 'team' ? 'Teammate' : 'Enemy tank')
       : kind === 'crasher' ? 'Crasher' : 'Shape';
     drawTargetPanel(ctx, hudWidgetRect('targetHud', width, height), {
       name: e.name || type,
       type: shape?.value > 0 ? `${type} · ${shape.value} XP` : type,
       health: e.health,
       maxHealth: e.maxHealth
     }, HUD_COLORS[relation]);
   }

   function drawTargetPanel(ctx, panel, data, accent = HUD_COLORS.neutral) {
     const { x, y, width, height } = panel;
     if (width <= 20 || height < 68) return;

     ctx.save();
     ctx.globalAlpha = 1;
     ctx.fillStyle = 'rgba(14, 23, 34, 0.95)';
     ctx.fillRect(x, y, width, height);
     ctx.fillStyle = accent;
     ctx.fillRect(x, y, 3, height);
     ctx.font = '650 15px Ubuntu, Arial, sans-serif';
     ctx.textAlign = 'left';
     ctx.textBaseline = 'top';
     ctx.fillStyle = '#f3f8ff';
     ctx.fillText(data.name, x + 11, y + 8, width - 22);

     ctx.font = '600 11px Ubuntu, Arial, sans-serif';
     ctx.fillStyle = '#aebed0';
     ctx.fillText(data.type, x + 11, y + 31, (width - 24) * 0.55);
     const hasHealth = Number.isFinite(data.health) && data.maxHealth > 0;
     const health = hasHealth ? `${Math.ceil(data.health)} / ${Math.round(data.maxHealth)} HP`
       : 'HP unavailable';
     ctx.textAlign = 'right';
     ctx.fillText(health, x + width - 10, y + 31, (width - 24) * 0.45);
     ctx.fillStyle = '#2a3949';
     ctx.fillRect(x + 11, y + 51, width - 22, 5);
     if (hasHealth) {
       const fraction = Math.max(0, Math.min(1, data.health / data.maxHealth));
       ctx.fillStyle = accent;
       ctx.fillRect(x + 11, y + 51, (width - 22) * fraction, 5);
     }
     ctx.restore();
   }

   const arrayListRows = new Map();
   let arrayListFrame = 0;

   function drawActiveModules(ctx, width, height, now) {
     ctx.save();
     ctx.font = '600 12px Ubuntu, Arial, sans-serif';
     const active = modules.filter(module =>
       module.id !== 'arrayList' && module.id !== 'clickgui' && module.enabled() &&
       (settings.arrayListRender || module.category !== 'Render')
     ).sort((a, b) => ctx.measureText(b.name).width - ctx.measureText(a.name).width ||
       a.name.localeCompare(b.name));
     ctx.restore();

     const delta = Math.min(80, now - arrayListFrame || 16);
     arrayListFrame = now;
     const duration = transitionDuration();
     const blend = duration ? Math.min(1, delta * 4 / duration) : 1;
     const indexes = new Map(active.map((module, index) => [module.name, index]));
     for (const [name, index] of indexes) {
       if (!arrayListRows.has(name)) arrayListRows.set(name, { name, index, opacity: 0 });
     }
     for (const [name, row] of arrayListRows) {
       const index = indexes.get(name);
       const opacity = index === undefined ? 0 : 1;
       row.opacity += (opacity - row.opacity) * blend;
       if (index !== undefined) row.index += (index - row.index) * blend;
       if (!opacity && row.opacity < 0.02) arrayListRows.delete(name);
     }
     drawArrayListPanel(ctx, hudWidgetRect('arrayList', width, height), arrayListRows.values());
   }

   function drawArrayListPanel(ctx, panel, rows) {
     if (panel.width < 20 || panel.height < 20) return;
     ctx.save();
     ctx.beginPath();
     ctx.rect(panel.x, panel.y, panel.width, panel.height);
     ctx.clip();
     ctx.font = '600 12px Ubuntu, Arial, sans-serif';
     ctx.textAlign = 'right';
     ctx.textBaseline = 'middle';

     for (const { name, index, opacity } of rows) {
       const width = Math.min(panel.width, Math.ceil(ctx.measureText(name).width) + 22);
       const right = panel.x + panel.width - (1 - opacity) * 8;
       const y = panel.y + index * 22;
       ctx.globalAlpha = opacity;
       ctx.fillStyle = '#142333';
       ctx.fillRect(right - width, y, width, 19);
       ctx.fillStyle = '#70c8e9';
       ctx.fillRect(right - width + 5, y + 8, 3, 3);
       ctx.fillStyle = '#e5f2fb';
       ctx.fillText(name, right - 6, y + 10, width - 16);
     }
     ctx.restore();
   }

   function drawEntityHud(ctx, items, me, width, height) {
     ctx.lineWidth = 2;
     ctx.font = '600 12px Ubuntu, Arial, sans-serif';
     ctx.textAlign = 'center';
     ctx.textBaseline = 'bottom';
     let shown = 0;
     let snapped = 0;

     for (const item of items) {
       if (!item.visibleOnHud) continue;
       const { e, kind, projectile, x, y, r } = item;
       if (x < -r || y < -r || x > width + r || y > height + r) continue;

       const relation = entityRelation(e, kind, me);
       const color = HUD_COLORS[relation];

       ctx.globalAlpha = projectile ? 0.7 : 0.95;
       ctx.strokeStyle = color;
       ctx.beginPath();
       ctx.arc(x, y, r + 3, 0, Math.PI * 2);
       ctx.stroke();

       if (e.maxHealth && e.health < e.maxHealth && !projectile) {
         drawHealthBar(ctx, x, y + r + 7, Math.max(24, r * 2),
           e.health / e.maxHealth, color);
       }

       if (settings.hudLabels && !projectile) {
         drawLabel(ctx, entityLabel(e, kind, relation), x, y - r - 6, color);
       }

       shown++;
       if (item.snapped) snapped++;
     }

     hud.stats.snapped = snapped;
     drawHudStatus(
       ctx,
       width,
       height,
       `Entity HUD · ${shown} shown · ${snapped} snapped · ` +
         `${hud.entities.size} tracked`
     );
   }

   /** Aim Debug line: target XP, expected XP/s and time to finish. */
   function farmingAimReason(aim) {
     const { efficiency, target, holding, candidates } = aim;
     const rate = efficiency && Number.isFinite(efficiency.seconds)
       ? `${efficiency.rate.toFixed(1)} XP/s · ${efficiency.seconds.toFixed(2)} s`
       : 'estimate unavailable';
     const why = holding ? 'holding target'
       : candidates === 1 ? 'only eligible target' : `${target.targetValue} XP`;
     return `Smart · ${why} · ${rate}`;
   }

   /** Shows the current target, its rank, and the straight-line contact estimate. */
   function drawFarmAimDebug(ctx, width, height, aim, status) {
     const panel = hudWidgetRect('aimDebug', width, height);

     ctx.save();
     ctx.globalAlpha = 1;
     let lines = [`Aim Debug · ${status ??
       (aim ? 'No eligible target' : 'Waiting for your tank')}`];

     if (aim?.target) {
       const { player, target, aimPoint, distanceSquared, penetrated, cleared } = aim;
       const { e, kind, x, y, r } = target;
       const distance = Math.sqrt(distanceSquared);
       const radius = Number.isFinite(r) ? r : 0;
       // Approximate contact with the projected target circle along the aim ray.
       const offset = distance > 0 ? Math.min(1, radius / distance) : 0;
       const impactX = aimPoint.x + (player.x - aimPoint.x) * offset;
       const impactY = aimPoint.y + (player.y - aimPoint.y) * offset;

       ctx.lineWidth = 2;
       ctx.strokeStyle = '#67d8fa';
       ctx.beginPath();
       ctx.arc(x, y, Math.max(9, radius + 4), 0, Math.PI * 2);
       ctx.stroke();

       ctx.strokeStyle = '#ffd47a';
       ctx.beginPath();
       ctx.moveTo(impactX - 5, impactY);
       ctx.lineTo(impactX + 5, impactY);
       ctx.moveTo(impactX, impactY - 5);
       ctx.lineTo(impactX, impactY + 5);
       ctx.stroke();

       const name = e.name || (kind === 'crasher' ? 'Crasher' : 'Shape');
       lines = [
         `Aim Debug · ${name} #${e.id}`,
         farmingAimReason(aim),
         `Impact estimate · ${Math.round(impactX)}, ${Math.round(impactY)}` +
           (aimPoint.leadTime ? ` · lead ${Math.round(aimPoint.leadTime * 1000)} ms` : '') +
           (penetrated ? ` · through ${penetrated} ${penetrated === 1 ? 'shape' : 'shapes'}` : '') +
           (cleared ? ` · clearing ${cleared} ${cleared === 1 ? 'shape' : 'shapes'} first` : '')
       ];
     }

     drawAimDebugPanel(ctx, panel, lines);
     ctx.restore();
   }

   function drawAimDebugPanel(ctx, panel, lines) {
     const padding = 8;
     const lineHeight = 17;
     if (panel.width <= 2 * padding) return;
     ctx.globalAlpha = 1;
     ctx.font = '600 12px Ubuntu, Arial, sans-serif';
     ctx.textAlign = 'left';
     ctx.textBaseline = 'top';
     const textWidth = panel.width - 2 * padding;
     ctx.fillStyle = 'rgba(16, 24, 33, 0.92)';
     ctx.fillRect(panel.x, panel.y, panel.width, panel.height);
     lines.forEach((line, index) => {
       ctx.fillStyle = ['#67d8fa', '#e1eaf6', '#ffd47a'][index];
       ctx.fillText(line, panel.x + padding, panel.y + padding + index * lineHeight, textWidth);
     });
   }

   /** A 4px bar centred on x; `fraction` is health / maxHealth. */
   function drawHealthBar(ctx, x, y, width, fraction, color) {
     const k = Math.max(0, Math.min(1, fraction));
     ctx.globalAlpha = 0.85;
     ctx.fillStyle = 'rgba(0,0,0,0.55)';
     ctx.fillRect(x - width / 2, y, width, 4);
     ctx.fillStyle = color;
     ctx.fillRect(x - width / 2, y, width * k, 4);
   }

   /** Outlined text, readable on any background. */
   function drawLabel(ctx, text, x, y, color) {
     ctx.globalAlpha = 1;
     ctx.lineWidth = 3;
     ctx.strokeStyle = 'rgba(0,0,0,0.75)';
     ctx.strokeText(text, x, y);
     ctx.fillStyle = color;
     ctx.fillText(text, x, y);
     ctx.lineWidth = 2;
   }

   function drawHudStatus(ctx, width, height, text) {
     if (hudEdit) return;
     drawEntityStatusPanel(ctx, hudWidgetRect('entityStatus', width, height), text);
   }

   function drawEntityStatusPanel(ctx, panel, text) {
     ctx.globalAlpha = 0.8;
     ctx.font = '600 12px Ubuntu, Arial, sans-serif';
     ctx.textAlign = 'left';
     ctx.textBaseline = 'alphabetic';
     ctx.lineWidth = 3;
     ctx.strokeStyle = 'rgba(0,0,0,0.75)';
     ctx.strokeText(text, panel.x, panel.y + panel.height, panel.width);
     ctx.fillStyle = '#ffffff';
     ctx.fillText(text, panel.x, panel.y + panel.height, panel.width);
     ctx.globalAlpha = 1;
   }

   /**
    * Your level, unspent points and stat levels for
    * `diepAssistPro.tankStats()`, or null before you spawn.
    */
   function tankStats() {
     const tank = hud.tank;
     if (!tank) return null;
     return {
       class: tankClassName(tank.classId),
       classId: tank.classId,
       level: tank.level,
       points: tank.points,
       stats: Object.fromEntries(tank.names.map((name, slot) =>
         [name || `Stat ${slot + 1}`, { level: tank.levels[slot], max: tank.max[slot] }]
       ))
     };
   }

   /** A snapshot of decoded entities for `diepAssistPro.entities()`. */
   function listEntities() {
     const me = findMyTank();
     const out = [];
     for (const e of hud.entities.values()) {
       const kind = entityKind(e);
       if (!kind) continue;
       out.push({
         id: e.id,
         kind,
         relation: entityRelation(e, kind, me),
         team: TEAM_COLORS[e.color] || null,
         name: e.name || null,
         x: e.x,
         y: e.y,
         health: e.health,
         maxHealth: e.maxHealth,
         owner: e.owner
       });
     }
     return out;
   }

   // =================================================================
   // Input hooks and ClickGUI
   // =================================================================

   const originalAdd = EventTarget.prototype.addEventListener;
   const originalRemove = EventTarget.prototype.removeEventListener;

   const mouseListeners = [];
   const physicalKeys = new Set();
   const gameKeys = new Set();
   const consumedKeys = new Set();

   let farmingEnabled = false;
   let farmingAiming = false;
   let mouseX = innerWidth / 2;
   let mouseY = innerHeight / 2;

   let menuOpen = false;
   let selectedCategory = 'Render';
   let expandedModule = null;
   let bindingModule = null;
   let closeTimer = null;
   let gui = null;
   let hudEdit = null;

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

   function releaseFarmingAim() {
     hud.farmLock = null;
     if (!farmingAiming) return;

     farmingAiming = false;
     sendMouse(mouseX, mouseY);
   }

   function setFarmingEnabled(enabled) {
     if (!enabled) releaseFarmingAim();

     farmingEnabled = enabled;
     updateModuleState('farming', enabled);
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

     if (!farmingAiming && !menuOpen) return;
     const activeGui = hudEdit ? gui.editor.root : gui?.window;
     if (menuOpen && activeGui?.contains(event.target)) return;

     event.stopImmediatePropagation();
   }

   /**
    * Blocks game clicks while farming or ClickGUI is enabled.
    *
    * @param {MouseEvent|PointerEvent} event
    */
   function onMouseButton(event) {
     if (gui?.root.contains(event.target)) return;
     if (!farmingEnabled && !menuOpen) return;

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
     if (target.isContentEditable) return true;
     if (target.matches('.dap-dropdown-trigger[aria-expanded="true"]')) return true;

     const field = target.closest('input, textarea, select');
     if (!field) return false;

     if (field.matches('textarea, select')) {
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
       (settings.guiMove && !hudEdit && !bindingModule &&
        !editableTarget(document.activeElement));
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

   function blockKeyEvent(event) {
     event.preventDefault();
     event.stopImmediatePropagation();
   }

   /** Checks whether another modifier is held with this physical key. */
   function hasKeyModifiers(event) {
     const { code } = event;
     return (event.ctrlKey && !code.startsWith('Control')) ||
       (event.altKey && !code.startsWith('Alt')) ||
       (event.metaKey && !code.startsWith('Meta')) ||
       (event.shiftKey && !code.startsWith('Shift'));
   }

   /**
    * Handles module shortcuts and physical movement-key state.
    *
    * @param {KeyboardEvent} event
    */
   function onKeyDown(event) {
     if (!event.isTrusted) return;

     const { code } = event;
     if (consumedKeys.has(code)) {
       blockKeyEvent(event);
       return;
     }
     if (hudEdit) {
       handleHudEditorKey(event);
       return;
     }
     if (bindingModule) {
       blockKeyEvent(event);
       if (event.repeat) return;

       consumedKeys.add(code);
       captureModuleKey(event);
       return;
     }

     if (menuOpen && !event.repeat && !event.isComposing &&
         event.target instanceof Element &&
         event.target.matches('.dap-dropdown-trigger') &&
         handleDropdownKey(event.target, event)) {
       consumedKeys.add(code);
       blockKeyEvent(event);
       return;
     }

     const editing = editableTarget(event.target);
     if (!editing && !event.isComposing && !hasKeyModifiers(event)) {
       const module = modules.find(({ id }) => moduleKey(id) === code);
       if (module && !event.repeat) {
         consumedKeys.add(code);
         blockKeyEvent(event);
         module.toggle();
         return;
       }
     }

     if (code === 'Escape' && menuOpen && !editing) {
       consumedKeys.add(code);
       blockKeyEvent(event);
       setMenuOpen(false);
       return;
     }

     if (movementKeys.has(code)) {
       physicalKeys.add(code);

       if (menuOpen && !movementAllowed()) {
         if (!editing) blockKeyEvent(event);
       } else {
         gameKeys.add(code);
       }

       return;
     }

     if (menuOpen && !gui?.root.contains(event.target)) {
       blockKeyEvent(event);
     }
   }

   /**
    * Tracks movement-key releases even when the GUI has focus.
    *
    * @param {KeyboardEvent} event
    */
   function onKeyUp(event) {
     if (!event.isTrusted) return;

     if (consumedKeys.delete(event.code)) {
       blockKeyEvent(event);
       return;
     }

     if (movementKeys.has(event.code)) {
       physicalKeys.delete(event.code);

       if (hudEdit) {
         blockKeyEvent(event);
         return;
       }

       if (gameKeys.has(event.code) &&
           menuOpen &&
           editableTarget(event.target)) {
         sendGameKey('keyup', event.code);
       }

       gameKeys.delete(event.code);
       return;
     }

     if (menuOpen && !gui?.root.contains(event.target)) {
       blockKeyEvent(event);
     }
   }

   originalAdd.call(window, 'keydown', onKeyDown, true);
   originalAdd.call(window, 'keyup', onKeyUp, true);

   originalAdd.call(window, 'blur', () => {
     physicalKeys.clear();
     consumedKeys.clear();
     syncMovementKeys();
     releaseFarmingAim();
   });

   originalAdd.call(document, 'visibilitychange', () => {
     if (document.hidden) releaseFarmingAim();
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

   const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

   /**
    * Returns the current opening/closing animation duration.
    *
    * @returns {number}
    */
   function transitionDuration() {
     return settings.animations && !reduceMotion.matches
       ? settings.animationSpeed
       : 0;
   }

   /**
    * Applies the saved blur and animation settings to ClickGUI.
    *
    * @param {number} [duration]
    */
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
     if (!open) {
       closeHudEditor(false);
       stopBinding();
       dismissDropdown();
     }
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

   const HUD_EDITOR_ARROWS = {
     ArrowLeft: [-1, 0],
     ArrowRight: [1, 0],
     ArrowUp: [0, -1],
     ArrowDown: [0, 1]
   };

   function openHudEditor() {
     if (hudEdit) return;

     stopBinding();
     dismissDropdown();
     hudEdit = { layout: { ...settings.hudLayout }, drag: null };
     gui.root.classList.add('dap-editing-hud');
     gui.editor.root.hidden = false;
     positionHudPreviews();
     gui.editor.done.focus({ preventScroll: true });
     syncMovementKeys();
   }

   function closeHudEditor(save) {
     if (!hudEdit) return;

     finishHudDrag(false);
     if (save) {
       settings.hudLayout = hudEdit.layout;
       saveSettings();
     }
     hudEdit = null;
     gui.editor.root.hidden = true;
     gui.root.classList.remove('dap-editing-hud');
     if (menuOpen) gui.editor.open.focus({ preventScroll: true });
     syncMovementKeys();
   }

   function positionHudPreviews() {
     const { toolbar, widgets, preview } = gui.editor;
     const panels = Array.from(widgets, widget => {
       const id = widget.dataset.hudWidget;
       return { id, ...hudWidgetRect(id, innerWidth, innerHeight, hudEdit.layout[id]) };
     });
     positionHudToolbar(toolbar, panels);
     renderHudEditorPreview(preview, panels);

     widgets.forEach((widget, index) => {
       const rect = panels[index];
       Object.assign(widget.style, {
         left: `${rect.x}px`, top: `${rect.y}px`,
         width: `${rect.width}px`, height: `${rect.height}px`
       });
     });
   }

   function renderHudEditorPreview(ctx, panels) {
     const { canvas } = ctx;
     const dpr = devicePixelRatio || 1;
     const width = Math.round(innerWidth * dpr);
     const height = Math.round(innerHeight * dpr);
     if (canvas.width !== width) canvas.width = width;
     if (canvas.height !== height) canvas.height = height;

     ctx.setTransform(1, 0, 0, 1, 0, 0);
     ctx.clearRect(0, 0, width, height);
     ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
     for (const panel of panels) {
       const preview = HUD_WIDGETS[panel.id].preview;
       if (panel.id === 'aimDebug') drawAimDebugPanel(ctx, panel, preview);
       else if (panel.id === 'entityStatus') drawEntityStatusPanel(ctx, panel, preview[0]);
       else if (panel.id === 'targetHud') drawTargetPanel(ctx, panel, preview);
       else drawArrayListPanel(ctx, panel, preview.map((name, index) =>
         ({ name, index, opacity: 1 })
       ));
     }
   }

   /** Keeps the floating controls clear of the HUD panels where space permits. */
   function positionHudToolbar(toolbar, panels) {
     const { left, right, top, height } = toolbar.getBoundingClientRect();
     const inset = 12;
     const bottom = Math.max(0, innerHeight - height - inset);
     const candidates = [inset, bottom, (innerHeight - height) / 2];
     for (const panel of panels) {
       candidates.push(panel.y + panel.height + inset, panel.y - height - inset);
     }
     for (const panel of panels) {
       candidates.push(panel.y + panel.height, panel.y - height);
     }
     if (hudEdit.drag) candidates.unshift(top);

     let bestTop = inset;
     let bestOverlap = Infinity;
     for (const candidate of candidates) {
       const y = Math.max(Math.min(inset, bottom), Math.min(bottom, candidate));
       let overlap = 0;
       for (const panel of panels) {
         const overlapX = Math.min(right, panel.x + panel.width) - Math.max(left, panel.x);
         const overlapY = Math.min(y + height, panel.y + panel.height) - Math.max(y, panel.y);
         overlap += Math.max(0, overlapX) * Math.max(0, overlapY);
       }
       if (overlap < bestOverlap) {
         bestTop = y;
         bestOverlap = overlap;
       }
       if (!overlap) break;
     }
     toolbar.style.top = `${bestTop}px`;
   }

   function startHudDrag(event) {
     if (!hudEdit || hudEdit.drag || event.button !== 0) return;

     const widget = event.currentTarget;
     const id = widget.dataset.hudWidget;
     const rect = widget.getBoundingClientRect();
     hudEdit.drag = {
       widget, id, pointerId: event.pointerId,
       offsetX: event.clientX - rect.left,
       offsetY: event.clientY - rect.top,
       start: hudEdit.layout[id]
     };
     widget.focus({ preventScroll: true });
     widget.setPointerCapture(event.pointerId);
     widget.classList.add('dap-dragging');
     event.preventDefault();
   }

   /** Snaps a panel to the nearest edge or center within eight pixels. */
   function snapHudAxis(offset, travel, inset, extent) {
     const clamped = Math.max(0, Math.min(travel, offset));
     let result = { offset: clamped, guide: null };
     let nearest = 8;
     if (!travel) return result;

     for (const [stop, guide] of [[0, inset], [travel / 2, extent / 2], [travel, extent - inset]]) {
       const distance = Math.abs(clamped - stop);
       if (distance <= nearest) {
         nearest = distance;
         result = { offset: stop, guide };
       }
     }
     return result;
   }

   function dragHudWidget(event) {
     const drag = hudEdit?.drag;
     if (!drag || drag.pointerId !== event.pointerId) return;

     const { guideX, guideY } = gui.editor;
     const position = hudEdit.layout[drag.id];
     const panel = hudWidgetRect(drag.id, innerWidth, innerHeight, position);
     const x = snapHudAxis(
       event.clientX - drag.offsetX - panel.insetX,
       panel.travelX, panel.insetX, innerWidth
     );
     const y = snapHudAxis(
       event.clientY - drag.offsetY - panel.insetY,
       panel.travelY, panel.insetY, innerHeight
     );
     hudEdit.layout[drag.id] = {
       x: panel.travelX ? x.offset / panel.travelX : position.x,
       y: panel.travelY ? y.offset / panel.travelY : position.y
     };
     guideX.hidden = x.guide === null;
     guideY.hidden = y.guide === null;
     if (x.guide !== null) guideX.style.left = `${x.guide}px`;
     if (y.guide !== null) guideY.style.top = `${y.guide}px`;
     positionHudPreviews();
   }

   function finishHudDrag(cancel) {
     const drag = hudEdit?.drag;
     if (!drag) return;

     hudEdit.drag = null;
     if (cancel) hudEdit.layout[drag.id] = drag.start;
     drag.widget.classList.remove('dap-dragging');
     if (drag.widget.hasPointerCapture(drag.pointerId)) {
       drag.widget.releasePointerCapture(drag.pointerId);
     }
     gui.editor.guideX.hidden = true;
     gui.editor.guideY.hidden = true;
     positionHudPreviews();
   }

   function handleHudEditorKey(event) {
     const { code } = event;
     if (code === 'Escape' || (code === settings.menuKey && !hasKeyModifiers(event))) {
       if (!event.repeat) {
         consumedKeys.add(code);
         closeHudEditor(false);
       }
       blockKeyEvent(event);
       return;
     }

     if (!movementKeys.has(code)) {
       if (!gui.editor.root.contains(event.target)) blockKeyEvent(event);
       return;
     }

     const widget = event.target instanceof Element && event.target.dataset?.hudWidget;
     const direction = HUD_EDITOR_ARROWS[code];
     if (widget && direction && !hudEdit.drag) {
       const position = hudEdit.layout[widget];
       const panel = hudWidgetRect(widget, innerWidth, innerHeight, position);
       const step = event.shiftKey ? 10 : 1;
       hudEdit.layout[widget] = {
         x: panel.travelX
           ? Math.max(0, Math.min(1, position.x + direction[0] * step / panel.travelX))
           : position.x,
         y: panel.travelY
           ? Math.max(0, Math.min(1, position.y + direction[1] * step / panel.travelY))
           : position.y
       };
       positionHudPreviews();
     } else {
       physicalKeys.add(code);
     }
     blockKeyEvent(event);
   }

   function bindHudEditor(guiRoot) {
     const root = guiRoot.querySelector('.dap-hud-editor');
     const open = guiRoot.querySelector('.dap-hud-open');
     const done = root.querySelector('.dap-hud-done');
     const stage = root.querySelector('.dap-hud-stage');
     const widgets = stage.querySelectorAll('[data-hud-widget]');

     open.addEventListener('click', openHudEditor);
     done.addEventListener('click', () => closeHudEditor(true));
     root.querySelector('.dap-hud-cancel').addEventListener('click', () => closeHudEditor(false));
     root.querySelector('.dap-hud-reset').addEventListener('click', () => {
       finishHudDrag(false);
       hudEdit.layout = defaultHudLayout();
       positionHudPreviews();
     });

     for (const widget of widgets) {
       widget.addEventListener('pointerdown', startHudDrag);
       widget.addEventListener('pointermove', dragHudWidget);
       for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
         widget.addEventListener(type, event => {
           if (hudEdit?.drag?.pointerId === event.pointerId) {
             finishHudDrag(type !== 'pointerup');
           }
         });
       }
     }
     originalAdd.call(window, 'resize', () => {
       if (hudEdit) positionHudPreviews();
     });

     return {
       root, open, done, widgets,
       toolbar: root.querySelector('.dap-hud-toolbar'),
       preview: stage.querySelector('.dap-hud-preview').getContext('2d'),
       guideX: stage.querySelector('.dap-hud-guide-x'),
       guideY: stage.querySelector('.dap-hud-guide-y')
     };
   }

   function toggleSavedModule(id) {
     settings[id] = !settings[id];
     if (id === 'arrayList' && !settings.arrayList) {
       arrayListRows.clear();
       arrayListFrame = 0;
     }
     saveSettings();
     updateModuleState(id, settings[id]);
   }

   const modules = [
     {
       id: 'farming',
       name: 'Shape Farming',
       category: 'Player',
       description: 'Aim at the visible shape with the best expected XP per second.',
       enabled: () => farmingEnabled,
       toggle: () => setFarmingEnabled(!farmingEnabled)
     },
     {
       id: 'guiMove',
       name: 'GUI Move',
       category: 'Movement',
       description: 'Use WASD or arrow keys while ClickGUI is open.',
       enabled: () => settings.guiMove,
       toggle: toggleGuiMove
     },
     {
       id: 'entityHud',
       name: 'Entity HUD',
       category: 'Render',
       description: 'Highlight tanks, projectiles and shapes from game packets.',
       enabled: () => settings.entityHud,
       toggle: () => toggleSavedModule('entityHud')
     },
     {
       id: 'arrayList',
       name: 'Arraylist',
       category: 'Render',
       description: 'List active modules on the HUD.',
       enabled: () => settings.arrayList,
       toggle: () => toggleSavedModule('arrayList')
     },
     {
       id: 'targetHud',
       name: 'Target HUD',
       category: 'Render',
       description: 'Show health and details for your target.',
       enabled: () => settings.targetHud,
       toggle: () => toggleSavedModule('targetHud')
     },
     {
       id: 'tracers',
       name: 'Tracers',
       category: 'Render',
       description: 'Draw lines from your tank to selected entity types.',
       enabled: () => settings.tracers,
       toggle: () => toggleSavedModule('tracers')
     },
     {
       id: 'bulletSpread',
       name: 'Bullet Spread',
       category: 'Render',
       description: 'Show firing cones for visible tanks.',
       enabled: () => settings.bulletSpread,
       toggle: () => toggleSavedModule('bulletSpread')
     },
     {
       id: 'widerView',
       name: 'Wider View',
       category: 'Render',
       description: 'Zoom out to show what the server sends past your screen.',
       enabled: () => settings.widerView,
       toggle: () => toggleSavedModule('widerView')
     },
     {
       id: 'clickgui',
       name: 'ClickGUI',
       category: 'Render',
       description: 'Open the menu and customize its appearance.',
       enabled: () => menuOpen,
       toggle: () => setMenuOpen(!menuOpen)
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

   function moduleKey(id) {
     return id === 'clickgui' ? settings.menuKey : settings.moduleKeys[id];
   }

   function setModuleKey(id, code) {
     if (id === 'clickgui') settings.menuKey = code;
     else settings.moduleKeys[id] = code;
     saveSettings();
     updateKeybindButtons(id);
   }

   function updateKeybindButtons(id, message) {
     const row = gui?.list.querySelector(`[data-module="${id}"]`);
     if (!row) return;

     const code = moduleKey(id);
     const label = code?.replace(/^(?:Key|Digit)(?=[A-Z0-9]$)/, '');
     const bind = row.querySelector('.dap-bind-button');
     bind.textContent = message ||
       (bindingModule === id ? 'Press a key…' : label || 'Unbound');

     const clear = row.querySelector('.dap-bind-clear');
     if (clear) clear.disabled = !code;
   }

   function stopBinding(message) {
     if (!bindingModule) return;

     const id = bindingModule;
     bindingModule = null;
     updateKeybindButtons(id, message);
     syncMovementKeys();
   }

   function captureModuleKey(event) {
     const { code } = event;
     if (code === 'Escape') {
       stopBinding();
     } else if (movementKeys.has(code)) {
       stopBinding('Movement key reserved');
     } else if (!bindableKey(code) || event.isComposing || hasKeyModifiers(event)) {
       stopBinding('Choose a single key');
     } else {
       const conflict = modules.find(({ id }) =>
         id !== bindingModule && moduleKey(id) === code
       );
       if (conflict) {
         stopBinding(`Used by ${conflict.name}`);
       } else {
         setModuleKey(bindingModule, code);
         stopBinding();
       }
     }
   }

   function dropdownOptions(trigger) {
     return trigger.nextElementSibling.querySelector('.dap-dropdown-options');
   }

   function dropdownIsOpen(trigger) {
     return trigger.getAttribute('aria-expanded') === 'true';
   }

   function highlightDropdownOption(trigger, option) {
     const options = dropdownOptions(trigger);
     options.querySelector('.dap-highlighted')?.classList.remove('dap-highlighted');
     option.classList.add('dap-highlighted');
     trigger.setAttribute('aria-activedescendant', option.id);
   }

   function setDropdownOpen(trigger, open) {
     if (dropdownIsOpen(trigger) === open) return;
     if (open) dismissDropdown();

     const panel = trigger.nextElementSibling;
     trigger.setAttribute('aria-expanded', String(open));
     panel.inert = !open;
     if (open) {
       const options = dropdownOptions(trigger);
       highlightDropdownOption(trigger, options.querySelector('[aria-selected="true"]'));
       trigger.focus({ preventScroll: true });
       options.scrollIntoView({ block: 'nearest', inline: 'nearest' });
     } else {
       trigger.removeAttribute('aria-activedescendant');
     }
     syncMovementKeys();
   }

   function updateDropdownValue(trigger, value) {
     for (const option of dropdownOptions(trigger).children) {
       const selected = option.dataset.value === String(value);
       option.setAttribute('aria-selected', String(selected));
       if (selected) {
         trigger.querySelector('.dap-dropdown-value').textContent = option.textContent;
       }
     }
   }

   function selectDropdownOption(trigger, option) {
     const { value } = option.dataset;
     settings.animationSpeed = Number(value);
     updateDropdownValue(trigger, value);
     applyMenuAppearance();
     saveSettings();
     setDropdownOpen(trigger, false);
   }

   function dismissDropdown() {
     const trigger = gui?.list.querySelector('.dap-dropdown-trigger[aria-expanded="true"]');
     if (!trigger) return;

     setDropdownOpen(trigger, false);
     trigger.blur();
   }

   /** Keeps focus on the control while moving through its options. */
   function handleDropdownKey(trigger, event) {
     const options = dropdownOptions(trigger);
     const wasOpen = dropdownIsOpen(trigger);
     const { code, key } = event;
     if (code === 'Escape') {
       if (!wasOpen) return false;
       setDropdownOpen(trigger, false);
       return true;
     }

     if (code === 'Enter' || code === 'Space') {
       if (!wasOpen) setDropdownOpen(trigger, true);
       else selectDropdownOption(trigger, options.querySelector('.dap-highlighted'));
       return true;
     }

     if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(code)) {
       if (key.length !== 1 || event.ctrlKey || event.altKey || event.metaKey) {
         return false;
       }
       const match = Array.from(options.children).find(option =>
         option.textContent.trim().toLowerCase().startsWith(key.toLowerCase())
       );
       if (!match) return false;
       if (!wasOpen) selectDropdownOption(trigger, match);
       else highlightDropdownOption(trigger, match);
       return true;
     }

     setDropdownOpen(trigger, true);

     const choices = Array.from(options.children);
     const last = choices.length - 1;
     let index = choices.findIndex(option => option.classList.contains('dap-highlighted'));
     if (code === 'Home') index = 0;
     if (code === 'End') index = last;
     if (wasOpen && code === 'ArrowDown') index = Math.min(last, index + 1);
     if (wasOpen && code === 'ArrowUp') index = Math.max(0, index - 1);
     highlightDropdownOption(trigger, choices[index]);
     return true;
   }

   function dropdownSetting(id, label, choices, value) {
     return `
       <div class="dap-setting-row dap-dropdown-row">
         <span class="dap-dropdown-label" id="dap-${id}-label">${label}</span>
         <div class="dap-dropdown">
           <button class="dap-dropdown-trigger" type="button" role="combobox"
             aria-labelledby="dap-${id}-label" aria-controls="dap-${id}-options"
             aria-expanded="false" data-dropdown-id="${id}">
             <span class="dap-dropdown-value">${choices[value]}</span>
           </button>
           <div class="dap-dropdown-panel" inert>
             <div class="dap-dropdown-clip">
               <div class="dap-dropdown-options" id="dap-${id}-options"
                 role="listbox" aria-labelledby="dap-${id}-label">
                 ${Object.entries(choices).map(([key, name]) => `
                   <div class="dap-dropdown-option" id="dap-${id}-${key}"
                     role="option" data-value="${key}"
                     aria-selected="${key === String(value)}">${name}</div>
                 `).join('')}
               </div>
             </div>
           </div>
         </div>
       </div>
     `;
   }

   function bindDropdown(trigger) {
     const panel = trigger.nextElementSibling;
     const options = dropdownOptions(trigger);
     trigger.addEventListener('click', () => {
       if (dropdownIsOpen(trigger)) trigger.blur();
       else setDropdownOpen(trigger, true);
     });
     trigger.addEventListener('blur', () => setDropdownOpen(trigger, false));
     options.addEventListener('mousedown', event => event.preventDefault());
     options.addEventListener('pointerover', event => {
       const option = event.target.closest('.dap-dropdown-option');
       if (option) highlightDropdownOption(trigger, option);
     });
     options.addEventListener('click', event => {
       const option = event.target.closest('.dap-dropdown-option');
       if (option) {
         selectDropdownOption(trigger, option);
         trigger.blur();
       }
     });
     panel.addEventListener('transitionend', event => {
       if (event.propertyName === 'grid-template-rows' && dropdownIsOpen(trigger)) {
         options.scrollIntoView({ block: 'nearest', inline: 'nearest' });
       }
     });
   }

   /**
    * Returns the settings controls for a module.
    *
    * @param {string} id
    * @returns {string}
    */
   function moduleSettings(id) {
     if (id === 'farming') {
       return `
         <label class="dap-setting-row">
           <span>Lead moving shapes</span>
           <input data-setting="farmLeadShapes" type="checkbox">
         </label>
         <label class="dap-setting-row">
           <span>Aim Debug overlay</span>
           <input data-setting="farmAimDebug" type="checkbox">
         </label>
         <fieldset class="dap-setting-group">
           <legend>Target shapes</legend>
           <div class="dap-farm-target-grid">
             ${Object.entries(FARM_TARGETS).map(([type, { label }]) => `
               <label>
                 <input data-farm-target="${type}" type="checkbox">
                 <span>${label}</span>
               </label>
             `).join('')}
           </div>
         </fieldset>
       `;
     }

     if (id === 'arrayList') {
       return `
         <label class="dap-setting-row">
           <span>Include render modules</span>
           <input data-setting="arrayListRender" type="checkbox">
         </label>
       `;
     }

     if (id === 'tracers') {
       return `
         <fieldset class="dap-setting-group">
           <legend>Draw lines to</legend>
           <div class="dap-farm-target-grid">
             ${Object.entries(TRACER_TARGETS).map(([type, label]) => `
               <label>
                 <input data-tracer-target="${type}" type="checkbox">
                 <span>${label}</span>
               </label>
             `).join('')}
           </div>
         </fieldset>
       `;
     }

     if (id === 'widerView') {
       return `
         <div class="dap-fields">
           <label>
             Extra view (%)
             <input class="dap-wider-percent" type="number" min="1" max="40" step="any">
           </label>
         </div>
         <p class="dap-settings-help">Takes effect on your next spawn or level-up. The server only sends things about 12% past the normal view, so wider settings leave the edges empty.</p>
       `;
     }

     if (id === 'bulletSpread') {
       return `
         <label class="dap-setting-row">
           <span>My tank</span>
           <input data-setting="spreadSelf" type="checkbox">
         </label>
         <label class="dap-setting-row">
           <span>Teammates</span>
           <input data-setting="spreadTeam" type="checkbox">
         </label>
         <label class="dap-setting-row">
           <span>Enemies</span>
           <input data-setting="spreadEnemy" type="checkbox">
         </label>
         <div class="dap-fields">
           <label>
             Fallback half-angle (°)
             <input class="dap-spread-angle" type="number" min="1" max="45" step="any">
           </label>
           <label>
             Cone length (× tank radius)
             <input class="dap-spread-length" type="number" min="1" max="100" step="any">
           </label>
         </div>
         <p class="dap-settings-help">Dashed cones use the fallback angle. Solid cones use recent shots.</p>
       `;
     }

     if (id === 'entityHud') {
       return `
         <label class="dap-setting-row">
           <span>Labels (name, team, health)</span>
           <input data-setting="hudLabels" type="checkbox">
         </label>

         <label class="dap-setting-row">
           <span>Bullets, drones and traps</span>
           <input data-setting="hudProjectiles" type="checkbox">
         </label>

         <label class="dap-setting-row">
           <span>Shapes</span>
           <input data-setting="hudShapes" type="checkbox">
         </label>
       `;
     }

     if (id === 'clickgui') {
       return `
         <label class="dap-setting-row">
           <span>Animations</span>
           <input data-setting="animations" type="checkbox">
         </label>

         ${dropdownSetting('animation-speed', 'Animation speed',
           ANIMATION_SPEEDS, settings.animationSpeed)}

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
     stopBinding();
     dismissDropdown();
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
     stopBinding();
     dismissDropdown();

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

     for (const module of visible) {
       const enabled = module.enabled();

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
           <div class="dap-setting-row">
             <span>Keybind</span>
             <div class="dap-bind-controls">
               <button class="dap-bind-button" type="button"
                 title="Press a key to bind it. Escape cancels."></button>
               ${module.id === 'clickgui' ? '' :
                 '<button class="dap-bind-clear" type="button">Clear</button>'}
             </div>
           </div>
           ${moduleSettings(module.id)}
         </div>
       `;

       gui.list.appendChild(row);

       const settingsPanel = row.querySelector('.dap-module-settings');
       const expandButton = row.querySelector('.dap-expand');

       if (expandedModule === module.id) {
         settingsPanel.classList.add('dap-expanded');
         settingsPanel.setAttribute('aria-hidden', 'false');
         expandButton.classList.add('dap-expanded');
         expandButton.setAttribute('aria-expanded', 'true');
       }

       row.querySelector('.dap-module-toggle').addEventListener('click', () => {
         module.toggle();
       });

       expandButton.addEventListener('click', () => {
         toggleModuleSettings(module.id);
       });

       row.addEventListener('contextmenu', event => {
         if (event.target.closest('.dap-module-settings')) return;

         event.preventDefault();
         toggleModuleSettings(module.id);
       });

       for (const trigger of row.querySelectorAll('.dap-dropdown-trigger')) {
         bindDropdown(trigger);
       }

       updateKeybindButtons(module.id);
       row.querySelector('.dap-bind-button').addEventListener('click', () => {
         const wasBinding = bindingModule === module.id;
         stopBinding();
         if (wasBinding) return;

         bindingModule = module.id;
         updateKeybindButtons(module.id);
         syncMovementKeys();
       });
       row.querySelector('.dap-bind-clear')?.addEventListener('click', () => {
         stopBinding();
         setModuleKey(module.id, null);
       });

       for (const input of row.querySelectorAll('[data-setting], [data-farm-target], [data-tracer-target]')) {
         const { setting, farmTarget, tracerTarget } = input.dataset;
         const values = farmTarget ? settings.farmTargets : tracerTarget ? settings.tracerTargets : settings;
         const key = farmTarget ?? tracerTarget ?? setting;
         input.checked = values[key];

         input.addEventListener('change', () => {
           values[key] = input.checked;
           if (key === 'farmLeadShapes') {
             for (const entity of hud.entities.values()) entity.leadMotion = null;
           }
           saveSettings();
           if (module.id === 'clickgui') applyMenuAppearance();
         });
       }
       const spreadAngle = row.querySelector('.dap-spread-angle');
       if (spreadAngle) {
         spreadAngle.value = settings.spreadHalfAngle;
         spreadAngle.addEventListener('change', () => {
           const value = spreadAngle.valueAsNumber;
           settings.spreadHalfAngle = Number.isFinite(value) ? Math.max(1, Math.min(45, value)) : 8;
           spreadAngle.value = settings.spreadHalfAngle;
           saveSettings();
         });
       }

       const widerPercent = row.querySelector('.dap-wider-percent');
       if (widerPercent) {
         widerPercent.value = settings.widerViewPercent;
         widerPercent.addEventListener('change', () => {
           const value = widerPercent.valueAsNumber;
           settings.widerViewPercent = Number.isFinite(value) ? Math.max(1, Math.min(40, value)) : 12;
           widerPercent.value = settings.widerViewPercent;
           saveSettings();
         });
       }

       const spreadLength = row.querySelector('.dap-spread-length');
       if (spreadLength) {
         spreadLength.value = settings.spreadLength;
         spreadLength.addEventListener('change', () => {
           const value = spreadLength.valueAsNumber;
           settings.spreadLength = Number.isFinite(value) ? Math.max(1, Math.min(100, value)) : 9;
           spreadLength.value = settings.spreadLength;
           saveSettings();
         });
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
       #dap-clickgui input {
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

       #dap-clickgui input:not([type="checkbox"]) {
         user-select: text;
         -webkit-user-select: text;
       }

       #dap-clickgui input:focus {
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

       #dap-clickgui .dap-hud-open {
         margin: 0 10px 10px;
         padding: 8px 10px;
         border: 1px solid #364454;
         border-radius: 8px;
         background: #1a2532;
         color: #dfeaf4;
         text-align: left;
       }

       #dap-clickgui .dap-hud-open:hover,
       #dap-clickgui .dap-hud-open:focus-visible {
         border-color: #59bce8;
       }

       #dap-clickgui.dap-editing-hud .dap-window {
         display: none;
       }

       #dap-clickgui.dap-editing-hud .dap-scrim {
         background: rgba(8, 15, 25, 0.34);
         backdrop-filter: none;
         -webkit-backdrop-filter: none;
       }

       #dap-clickgui .dap-hud-editor {
         position: absolute;
         top: 0;
         left: 0;
         width: 100vw;
         height: 100vh;
       }

       #dap-clickgui .dap-hud-toolbar {
         position: absolute;
         z-index: 1;
         top: 12px;
         right: 12px;
         width: min(384px, calc(100% - 24px));
         display: flex;
         align-items: center;
         justify-content: space-between;
         flex-wrap: wrap;
         gap: 10px 20px;
         padding: 12px 14px;
         border: 1px solid #3c5367;
         border-radius: 10px;
         background: #111a26;
         box-shadow: 0 4px 20px #0006;
       }

       #dap-clickgui .dap-hud-toolbar h2 {
         margin: 0;
         color: #e8f5ff;
         font-size: 17px;
         font-weight: 600;
       }

       #dap-clickgui .dap-hud-toolbar p {
         margin: 3px 0 0;
         color: #a1b5c9;
         font-size: 12px;
       }

       #dap-clickgui .dap-hud-actions {
         display: flex;
         align-items: center;
         flex-wrap: wrap;
         gap: 6px;
       }

       #dap-clickgui .dap-hud-actions button {
         padding: 7px 12px;
         border: 1px solid #3e5568;
         border-radius: 7px;
         background: #1b2a3a;
         color: #dcebf6;
       }

       #dap-clickgui .dap-hud-actions .dap-hud-done {
         background: #28688c;
         border-color: #4288a9;
         color: #fff;
       }

       #dap-clickgui .dap-hud-actions button:hover,
       #dap-clickgui .dap-hud-actions button:focus-visible {
         border-color: #67d8fa;
       }

       #dap-clickgui .dap-hud-stage {
         position: absolute;
         inset: 0;
         overflow: hidden;
         isolation: isolate;
         background:
           radial-gradient(circle, rgba(191, 224, 248, 0.26) 1px, transparent 1.5px)
             0 0 / 24px 24px,
           rgba(7, 16, 28, 0.16);
       }

       #dap-clickgui .dap-hud-widget {
         position: absolute;
         z-index: 1;
         padding: 0;
         border: 1px dashed #79a9c1;
         background: transparent;
         touch-action: none;
         cursor: grab;
       }

       #dap-clickgui .dap-hud-preview {
         position: absolute;
         inset: 0;
         width: 100%;
         height: 100%;
         pointer-events: none;
       }

       #dap-clickgui .dap-hud-widget:hover,
       #dap-clickgui .dap-hud-widget:focus,
       #dap-clickgui .dap-hud-widget.dap-dragging {
         z-index: 2;
         border-style: solid;
         border-color: #67d8fa;
       }

       #dap-clickgui .dap-hud-widget.dap-dragging {
         cursor: grabbing;
       }

       #dap-clickgui .dap-hud-guide {
         position: absolute;
         z-index: 0;
         pointer-events: none;
         background: #67d8fa;
       }

       #dap-clickgui .dap-hud-guide-x {
         top: 0;
         bottom: 0;
         width: 1px;
       }

       #dap-clickgui .dap-hud-guide-y {
         left: 0;
         right: 0;
         height: 1px;
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

       #dap-clickgui [data-module="farming"] .dap-module-settings.dap-expanded {
         max-height: 1040px;
       }

       #dap-clickgui .dap-fields {
         display: grid;
         grid-template-columns: 1fr 1fr;
         gap: 12px;
         margin-top: 8px;
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

       #dap-clickgui .dap-fields input {
         background: #101821;
         border: 1px solid #364454;
         border-radius: 7px;
         color: #e1eaf6;
         padding: 8px;
         min-width: 0;
       }

       #dap-clickgui .dap-bind-button {
         border: 1px solid #3b85ae;
         border-radius: 7px;
         background: #235b7a;
         color: #e3f5ff;
         padding: 7px 12px;
         transition: background 160ms ease;
       }

       #dap-clickgui .dap-bind-button:hover {
         background: #2e7298;
       }

       #dap-clickgui .dap-bind-controls {
         display: flex;
         flex-wrap: wrap;
         justify-content: flex-end;
         align-items: center;
         gap: 8px;
       }

       #dap-clickgui .dap-bind-clear {
         border: 0;
         background: transparent;
         color: #a2afc0;
         padding: 7px 4px;
       }

       #dap-clickgui .dap-bind-clear:hover {
         color: #e3f5ff;
       }

       #dap-clickgui .dap-bind-clear:disabled {
         opacity: 0.45;
         cursor: default;
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

       #dap-clickgui .dap-dropdown-row {
         align-items: flex-start;
       }

       #dap-clickgui .dap-dropdown-label {
         padding-top: 8px;
       }

       #dap-clickgui .dap-dropdown {
         flex: 0 1 164px;
         min-width: 0;
         display: grid;
       }

       #dap-clickgui .dap-dropdown-trigger {
         display: flex;
         align-items: center;
         justify-content: space-between;
         gap: 8px;
         padding: 7px 9px;
         background: #101821;
         color: #e1eaf6;
         border: 1px solid #364454;
         border-radius: 7px;
         text-align: left;
         transition: border-color var(--dap-duration) ease;
       }

       #dap-clickgui .dap-dropdown-trigger::after {
         content: '';
         flex: 0 0 6px;
         height: 6px;
         border-right: 1px solid currentColor;
         border-bottom: 1px solid currentColor;
         transform: translateY(-2px) rotate(45deg);
         transition: transform var(--dap-duration) ease;
       }

       #dap-clickgui .dap-dropdown-trigger:focus-visible,
       #dap-clickgui .dap-dropdown-trigger[aria-expanded="true"] {
         border-color: #56bcec;
       }

       #dap-clickgui .dap-dropdown-trigger[aria-expanded="true"]::after {
         transform: translateY(2px) rotate(225deg);
       }

       #dap-clickgui .dap-dropdown-panel {
         display: grid;
         grid-template-rows: 0fr;
         opacity: 0;
         visibility: hidden;
         transition:
           grid-template-rows var(--dap-duration) ease,
           opacity var(--dap-duration) ease,
           visibility 0s linear var(--dap-duration);
       }

       #dap-clickgui .dap-dropdown-trigger[aria-expanded="true"] + .dap-dropdown-panel {
         grid-template-rows: 1fr;
         opacity: 1;
         visibility: visible;
         transition-delay: 0s;
       }

       #dap-clickgui .dap-dropdown-clip {
         min-height: 0;
         overflow: hidden;
       }

       #dap-clickgui .dap-dropdown-options {
         display: grid;
         margin-top: 4px;
         padding: 3px;
         background: #101821;
         border: 1px solid #364454;
         border-radius: 7px;
       }

       #dap-clickgui .dap-dropdown-option {
         padding: 6px 8px;
         border-radius: 4px;
         cursor: pointer;
       }

       #dap-clickgui .dap-dropdown-option[aria-selected="true"] {
         color: #8bd5f7;
         font-weight: 600;
       }

       #dap-clickgui .dap-dropdown-option.dap-highlighted {
         background: #263b4e;
       }

       #dap-clickgui .dap-setting-group {
         min-inline-size: 0;
         margin: 4px 0 0;
         padding: 8px 10px 10px;
         border: 1px solid #364454;
         border-radius: 7px;
         color: #c4cfdd;
         font-size: 12px;
       }

       #dap-clickgui .dap-setting-group legend {
         padding: 0 4px;
       }

       #dap-clickgui .dap-settings-help {
         margin: 8px 0 0;
         color: #9ca9bc;
         font-size: 11px;
       }

       #dap-clickgui .dap-farm-target-grid {
         display: grid;
         grid-template-columns: repeat(auto-fit, minmax(min(100%, 135px), 1fr));
         gap: 6px 12px;
       }

       #dap-clickgui .dap-farm-target-grid label {
         display: flex;
         align-items: center;
         gap: 6px;
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
         #dap-clickgui .dap-dropdown-trigger {
           gap: 5px;
           padding-inline: 6px;
         }

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
           <button class="dap-hud-open" type="button">HUD Editor</button>
         </aside>

         <main class="dap-main">
           <input class="dap-search"
             type="search"
             placeholder="Search modules…"
             autocomplete="off">

           <div class="dap-content"></div>
         </main>
       </section>

       <section class="dap-hud-editor" role="dialog" aria-labelledby="dap-hud-title" hidden>
         <header class="dap-hud-toolbar">
           <div>
             <h2 id="dap-hud-title">HUD Editor</h2>
             <p id="dap-hud-help">Drag panels to place them. Arrow keys nudge.</p>
           </div>
           <div class="dap-hud-actions">
             <button class="dap-hud-reset" type="button">Reset layout</button>
             <button class="dap-hud-cancel" type="button">Cancel</button>
             <button class="dap-hud-done" type="button">Done</button>
           </div>
         </header>
         <div class="dap-hud-stage" role="region" aria-label="HUD layout preview"
           aria-describedby="dap-hud-help">
           <div class="dap-hud-guide dap-hud-guide-x" aria-hidden="true" hidden></div>
           <div class="dap-hud-guide dap-hud-guide-y" aria-hidden="true" hidden></div>
           <canvas class="dap-hud-preview" aria-hidden="true"></canvas>
           ${Object.entries(HUD_WIDGETS).map(([id, { label }]) => `
             <button class="dap-hud-widget" type="button" data-hud-widget="${id}"
               aria-label="${label}"></button>
           `).join('')}
         </div>
       </section>
     `;

     document.body.appendChild(root);

     gui = {
       root,
       window: root.querySelector('.dap-window'),
       nav: root.querySelector('.dap-nav'),
       search: root.querySelector('.dap-search'),
       list: root.querySelector('.dap-content'),
       editor: bindHudEditor(root)
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
       if (!hudEdit && settings.outsideClose) {
         setMenuOpen(false);
       }
     });

     root.addEventListener('pointerdown', event => {
       if (!event.target.closest('.dap-dropdown')) dismissDropdown();
     });

     /**
      * Prevents GUI buttons from retaining keyboard focus
      * after a mouse click.
      */
     root.addEventListener('mousedown', event => {
       if (
         !hudEdit && event.button === 0 &&
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

       if (button && !bindingModule &&
           !button.matches('.dap-dropdown-trigger, .dap-hud-editor button')) {
         button.blur();
         syncMovementKeys();
       }
     });

     /**
      * Removes focus from completed setting interactions.
      *
      * This prevents checkboxes from holding
      * keyboard focus after the setting has changed.
      */
     root.addEventListener('change', event => {
       const target = event.target;

       if (
         target instanceof HTMLInputElement &&
         ['checkbox', 'radio', 'range'].includes(target.type)
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

   /** Mounts ClickGUI and the Entity HUD overlay. */
   function startUi() {
     createGui();
     createHudOverlay();
   }

   if (document.readyState === 'loading') {
     document.addEventListener('DOMContentLoaded', startUi, {
       once: true
     });
   } else {
     startUi();
   }

   // Page-level controls for ClickGUI and diagnostics.
   window.diepAssistPro = {
     openMenu: () => setMenuOpen(true),
     closeMenu: () => setMenuOpen(false),
     entities: listEntities,
     hudStats: () => ({ ...hud.stats, tracked: hud.entities.size }),
     tankStats,
     capture: captureApi
   };
 })();
