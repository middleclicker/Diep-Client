# Diep Assist Pro

A Diep.io userscript with a packet-based entity HUD, smart shape farming, tracers, bullet spread cones, a wider view, and a customizable ClickGUI.

Instead of guessing from pixels, it reads the game's own network data. It knows exactly what every entity is (you, teammates, enemies, bullets, drones, shapes), who owns it, its team and health, and your own level, stat upgrades and tank class.

> [!WARNING]
> **Use at your own risk, on a throwaway account.** Diep.io's server sends an anti-cheat script that detects the hooks this userscript relies on, and accounts or networks using it can be banned. Using it also breaks Diep.io's rules. It's tied to the current game version, so a Diep.io update can break parts of it until the decoder is updated.

## Getting started

1. **Install Tampermonkey** for your browser from [tampermonkey.net](https://www.tampermonkey.net/).
2. **Allow userscripts** (Chrome and Edge): open the extensions page, open **Details** for Tampermonkey, and turn on **Allow User Scripts**. On older versions, turn on **Developer mode** on the extensions page instead.
3. **Install the script:** open the [raw script](https://raw.githubusercontent.com/middleclicker/Diep-Client/main/Diep%20Assist%20Pro.user.js) and click **Install** in the Tampermonkey tab that appears. Alternatively, create a new script in Tampermonkey, paste in [Diep Assist Pro.user.js](Diep%20Assist%20Pro.user.js) and save.
4. **Open [diep.io](https://diep.io)** (reload it if it was already open) and spawn.
5. **Press Right Shift** to open ClickGUI. Turn modules on or off by clicking their cards, and open their settings with the chevron.

The bottom-left status line shows whether the HUD is working. For example, `Entity HUD · 12 shown · 10 snapped · 16 tracked` means everything is decoded and lined up. See [Status line](#status-line) if it says something else.

To update, repeat step 3 with the newest version. Your settings are kept.

### Quick tour

- **Render → Entity HUD:** coloured rings and labels: you (blue), teammates (green), enemies (red), shapes (yellow).
- **Player → Shape Farming:** aims at the shape with the best expected XP per second. You do the shooting; turn on autofire with **E**.
- **Render → Tracers / Target HUD / Bullet Spread / Wider View:** extra overlays and a slightly zoomed-out view.
- **HUD Editor** (ClickGUI sidebar): drag the on-screen panels where you want them.
- **Console:** `diepAssistPro.tankStats()` shows your class, level and stat upgrades.

## Using ClickGUI

Press **Right Shift** to open ClickGUI by default. Right-click a module card or use its chevron to expand or collapse its settings. Dropdowns use ClickGUI’s animation speed and respect reduced-motion preferences.

### Module keybinds

Open any module’s settings, click its **Keybind** button, and press a single key. Press **Escape** to cancel, or click **Clear** to remove a module’s shortcut. ClickGUI always keeps a shortcut so you can reopen the menu. WASD, arrow keys, and Escape are reserved, and each shortcut can be assigned to one module. Shortcuts are saved across reloads and pause while you type in a field.

## Modules

| Module | Where | What it does |
| --- | --- | --- |
| **Shape Farming** | Player | Aims at eligible visible shapes, including while ClickGUI is open. Blocks game clicks while enabled. Starts disabled after each reload and releases aim when the tab loses focus or no eligible target is visible. |
| **GUI Move** | Movement | Lets physical WASD and arrow keys reach the game while ClickGUI is open. Editing a field takes keyboard focus. Disabled by default. |
| **Entity HUD** | Render | Rings and labels tanks, bullets, drones and traps on screen, and optionally shapes. Enabled by default. See [Entity HUD](#entity-hud). |
| **Arraylist** | Render | Lists active modules from widest name to narrowest. Its settings let you show or hide render modules in the list. |
| **Target HUD** | Render | Shows the active farming target or the tank or shape under the cursor. Displays remaining HP and estimated XP for known shapes. |
| **Tracers** | Render | Draws color-coded lines from your tank to the visible entity types selected in its settings. |
| **Bullet Spread** | Render | Draws firing cones for your tank, enemies, or teammates. Dashed cones use a configurable fallback half-angle. Solid cones use recent bullet directions matched to a visible barrel. |
| **Wider View** | Render | Zooms the game out to show what the server sends past your screen. See [Wider View](#wider-view). |
| **ClickGUI** | Render | Configures the menu shortcut, animations, animation speed, background blur, and outside-click behavior. |

Preferences are stored under `diepAssistPro.settings` in the site's local storage.

## HUD Editor

Open **HUD Editor** from the ClickGUI sidebar. The editor fills the game viewport and shows **Aim Debug**, **Entity HUD status**, **Arraylist**, and **Target HUD** at their in-game positions. Drag a panel and use the alignment guides to snap it to an edge or the center. Focus a panel and press the arrow keys to move it by one pixel, or hold **Shift** to move it by ten. The toolbar moves away from the panels as needed.

**Done** saves the layout across reloads and keeps positions relative to the available space as the viewport resizes. **Cancel** or **Escape** discards the current edits. **Reset layout** restores the default positions in the editor, ready to save with **Done**.

## Shape Farming

Under **Player → Shape Farming**, open the settings chevron. **Target shapes** lets you enable any combination of squares, triangles, pentagons, Alpha Pentagons, hexagons, shiny shapes, Crashers, and other shapes. Crashers start unchecked. With every box unchecked, the module has no eligible targets.

### Smart targeting

Shape Farming aims at the visible shape with the best expected XP per second. The XP for each shape type is fixed in the game:

| Shape | XP |
| --- | --- |
| Square | 10 |
| Triangle | 25 |
| Pentagon | 130 |
| Hexagon | 1,500 |
| Alpha Pentagon | 3,000 |
| Crasher | 15 small, 25 large |

Shiny shapes give 100 times their base XP. Unrecognized shapes count as 0 XP.

The time to finish a shape combines its remaining HP, damage per shot, your reload interval, bullet travel time, and the chance of a hit given the shape's recent motion. It also includes any bullet HP spent penetrating other shapes. The estimate assumes you secure the kill.

The current target is kept until another shape's rate is more than 15% higher, so aim doesn't flick between near-equal shapes. Equal rates go to the closer shape.

**Lead moving shapes** is off by default. It estimates drift from consecutive position updates and damps the lead when the shape is slowing down. Sharp turns and stale observations send aim back to the current position. The forecast is capped at 280 ms and tapers to direct aim as estimated flight time approaches 500 ms. It uses the median speed of your own bullets, or 600 world units per second before any are seen. Motion is timed by server ticks, so uneven packet arrival doesn't show up as speed.

Shapes in the way are part of the estimate, including types you don't farm:

- **Bullets punch through:** if one bullet can pass through every shape in the way with HP left, it destroys them and reaches the target weakened. Later shots have a clear line. The blockers' XP is added.
- **Bullets can't get through:** the blockers have to be shot down first. Their time to destroy is added, and so is their XP.

A pentagon behind a cheap square can stay the best target, while one behind other pentagons usually drops below a clear shot. Penetration uses whole collision steps, your bullet HP and damage per hit, and each shape's estimated contact damage. Until damage per hit is measured, bullets are assumed not to punch through. [Diep.io collision experiments](https://sites.google.com/site/archiversassociation/all-works/diep-io-sciences/diep-loop-duration-measurement)

Enable **Aim Debug overlay** in Shape Farming's settings to see:

- the selected target;
- its XP, expected XP/s and time to finish;
- how many shapes in the way it punches through or clears first;
- the estimated impact point in viewport pixels.

The cyan ring marks the current target, and the gold crosshair marks the estimated contact point on the direct or led shot. Aim Debug is off by default and can run with Entity HUD disabled.

### Measured shot stats

Shot stats come from your own play; there's nothing to enter.

| Stat | How it's measured | Before it's measured |
| --- | --- | --- |
| Shot interval | Time per bullet across a run of at least four of your bullets, with no pause over 1.5 s | 450 ms |
| Bullet damage per hit | Median health a shape loses per tick while only your bullets touch it (at least two samples) | Bullets are assumed not to punch through |
| Damage per shot | Damage per hit × hits one bullet survives against that shape (bullet HP ÷ the shape's contact damage) | 20 HP |
| Bullet HP and speed | Your bullets currently on screen | Speed: 600 units/s |

Measurements reset when your tank changes. Changing class resets all of them. Upgrading **Reload** resets the shot interval, and upgrading **Bullet Damage** resets damage per hit, since those upgrades change them. Bullet HP and speed are read from live bullets, so they update by themselves.

## Wider View

**Render → Wider View** zooms the game out so you can see the area the server sends beyond your normal view. It's off by default. **Extra view (%)** sets how much wider the view gets (default 12, from 1 to 40).

- **How it works:** the game's zoom comes from your camera's field of view, which the server sends when you spawn and when you level up. Wider View scales that value down in the decrypted packet before the game reads it. The game then draws a wider area itself, with its own UI unchanged and aim still lined up.
- **Takes effect on your next spawn or level-up**, because that's when the game reads the value. The same goes for turning it off.
- **Edges may be empty:** the server only sends things about 12% past the normal view to the sides (more above and below), so anything wider shows empty bands at the edges.
- **Detection:** it changes game data in memory before the game reads it, which is more invasive than reading it.

## Bullet Spread

Open **Render → Bullet Spread** and choose which tanks to show. Each cone follows an individual drawn barrel when one can be matched. When barrel geometry is unavailable, recent outgoing shots can supply a direction. A solid cone shows the largest observed angular deviation across at least three recent shots matched to that barrel. A dashed cone uses the configured fallback. **Cone length** sets how far cones reach, in multiples of the tank's radius on screen (default 9, from 1 to 100). Cones never extend past the screen diagonal. Length is for display only; it doesn't reflect bullet range.

## Entity HUD

Each entity on screen gets a ring. Tanks and shapes also get a label and a health bar.

| Colour | Meaning |
| --- | --- |
| Blue | You, and your bullets and drones |
| Green | Teammates and their projectiles (team modes) |
| Red | Enemies and their projectiles |
| Yellow | Shapes (optional) |
| Pink | Crashers (optional) |

Labels read like `Enemy "Name" · Red 120/200`, `You · Twin 50/50` or `Square 10/10`. Only your own tank shows its class, because the game only sends your class. The settings toggle labels, projectiles and shapes.

### How it works

| Stage | What happens |
| --- | --- |
| Packet capture | Diep's packets are encrypted on the wire and decrypted in place inside WebAssembly memory. `installPacketCapture()` copies each one out right after the game decrypts it. |
| Decoding | `decodePacket()` and `processPacket()` turn packets into an entity table: what each entity is, who owns it, its team colour, health and world position. |
| Draw capture | `installDrawCapture()` records where the game drew each circle and polygon this frame, and the view scale. |
| Overlay | `renderHud()` runs right after each game frame. It predicts each entity's screen position from packets, then `snapItems()` moves each ring onto the shape the game actually drew. |

Packets decide *what* each thing is, and the draw calls decide *where* it is.

Snapping has three parts:

- **Camera correction:** `estimateDrawOffset()` finds the offset most entity/shape pairs agree on, starting from the previous frame's offset. This survives sudden jumps such as Destroyer recoil.
- **Matching:** a ring only takes a drawn shape of the right kind (circle or polygon) and a plausible size.
- **Per-entity memory:** each entity remembers its own offset from its shape for 250 ms. This keeps rings on your tank during hard stops and stops neighbours swapping in crowds.

### Status line

The bottom-left line shows how the HUD is doing.

| Status | Meaning |
| --- | --- |
| `N shown · M snapped · K tracked` | Working. M is the number of rings locked onto drawn shapes. |
| `0 snapped` while playing | Draw capture isn't matching; rings fall back to packet estimates. |
| `waiting for camera` | Packets decode but your camera hasn't been seen. Respawning fixes it. |
| `no game packets captured yet` | The capture hook isn't running. Check the Tampermonkey install. |

### Protocol reference

Update packets are `[0x00][varint][tick][deleteCount][(gen, id)…][recordCount][record…][trailer]`. Each record is `[gen][id][0 = update | 1 = create][bitmask]`, followed by values.

| Update field | Meaning | Type |
| --- | --- | --- |
| 53, 69 | X, Y world position | zigzag varint |
| 100 | Angle | varint |
| 28 / 67 | Health / max health | float |
| 39 | Colour (team: 3 blue, 4 red, 5 purple, 6 green) | varint |
| 77 | Size | float |
| 6 | Opacity (fades on death) | float |
| 95 | Score | float |
| 86, 92 | Camera X, Y | float |
| 52 | Field of view | float |
| 110 | Your level (camera) | zigzag varint |
| 96 | Unspent stat points (camera) | zigzag varint |
| 42 | Your stat levels (camera), in the camera's stat-name order | masked array of zigzag varints |
| 58 | Your tank class id (camera), e.g. 1 Twin, 3 Triple Shot, 14 Penta Shot | zigzag varint |

Create records list components instead of fields. The HUD uses these:

| Component | Contents |
| --- | --- |
| 9 | Size, sides, colour |
| 14 | Name |
| 17 | Position |
| 20 | Score (present only on tanks) |
| 16 | The camera, including your tank's id |
| 2 | Owner (bullet → tank, tank → camera) |
| 10 | Health and max health |

The full tables are `FIELD_TYPES` and `CREATE_SLOTS` in the script. A record the decoder can't read is skipped by finding where the following records start (`stats.resynced`). If that fails, the rest of the packet is lost (`stats.dropped`).

### Limits

- **Detectable.** Diep.io's server-pushed anti-cheat checks for wrapped WebAssembly, WebSocket and canvas drawing functions, and for extra canvases, so this module is visible to it. Use a throwaway account.
- **Tied to the current game build.** A Diep.io update that renumbers fields or changes how entities are drawn will break decoding or snapping until the tables are refreshed.
- **Tested modes.** Tested in 2 Teams and Sandbox only. Other modes may have entity types without layouts yet; those entities get no ring.
- **Compressed join data.** When the join data arrives compressed (seen in 2 Teams), entities already on screen have no type until they leave and re-enter view.
- **Drone vs. trap** is guessed from shape and flags.
- **Dense bullets.** Identical bullets packed tightly together can occasionally swap rings for a frame.

## Code map

The script is one IIFE in four parts, in this order:

1. **Settings:** defaults and `localStorage` persistence.
2. **Entity tracking and HUD:** protocol tables, decoder, entity table, packet and draw capture, classification, shape targeting, matching and overlay.
3. **Input hooks:** captures the game's mouse listeners for Shape Farming. `syncMovementKeys()` reconciles physical keys with the movement keys delivered to the game.
4. **ClickGUI:** `createGui()` builds the menu, `renderModules()` handles categories and search, and `applyMenuAppearance()` applies the saved appearance. Module shortcuts and card clicks use the same toggle handlers.

Hooks are installed at document start, before the game loads. ClickGUI and the overlay mount once the DOM is ready.

### Console API

| Call | Result |
| --- | --- |
| `diepAssistPro.openMenu()` / `diepAssistPro.closeMenu()` | Opens or closes ClickGUI. |
| `diepAssistPro.entities()` | Lists decoded entities: kind, relation, team, name, position, health, owner. |
| `diepAssistPro.hudStats()` | Decoder and snapping counters: `packets`, `resynced`, `dropped`, `misses`, `snapped`, `tracked`. |
| `diepAssistPro.capture.start()` / `.mark(label)` / `.stop()` / `.status()` | Records raw data about your own tank. See [Capture mode](#capture-mode). |
| `diepAssistPro.tankStats()` | Your level, unspent points, and each stat's level and cap, e.g. `{ class: 'Twin', classId: 1, level: 45, points: 30, stats: { Reload: { level: 2, max: 7 }, … } }`. `null` before you spawn. |

### Capture mode

Capture mode records raw game data about your own tank, so fields that aren't decoded yet can be found from a session where you change them. Tank class was found this way.

1. Spawn, then run this in the browser console:

   ```js
   diepAssistPro.capture.start()
   ```

2. Do the thing to capture: for example, level up (Sandbox → Max Level is quickest) and pick classes.
3. Right after each change, label it:

   ```js
   diepAssistPro.capture.mark('picked Twin')
   ```

4. Copy the log to your clipboard:

   ```js
   copy(diepAssistPro.capture.stop())
   ```

`diepAssistPro.capture.status()` shows whether a capture is running and how many events it holds. The log keeps:

- creations of your camera, tank and tank parts (barrels and decorations);
- changed fields on them;
- deletions;
- raw bytes of any record about them that the decoder can't read.

It leaves out movement, aim and health ticks, and your bullets and drones. It stops recording after 5,000 events, which is several minutes of play, and notes that it did.

To check syntax, run this from the project directory:

```bash
node --check "Diep Assist Pro.user.js"
```

## Archived release

[Version 0.1.18](archive/v0.1.18/README.md) contains the earlier visual Entity HUD, its documentation, and the preview.
