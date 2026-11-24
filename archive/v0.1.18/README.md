# Diep Assist Pro

Diep Assist Pro is a standalone userscript for Diep.io. Update the existing Tampermonkey entry with [Diep Assist Pro.user.js](Diep%20Assist%20Pro.user.js), save it, and reload the game. Press **Right Shift** to open ClickGUI. The chevron beside a module opens its settings.

## Modules

| Module | Where | What it does |
| --- | --- | --- |
| **Entity HUD** | Render | Marks visible tanks, projectiles, and recognized neutral shapes. Enabled by default. Click the module name to toggle it. |
| **Mouse Control** | Player | Enter X and Y in viewport pixels, then click **Apply position**. Click the enabled module again to release the mouse. |
| **GUI Move** | Movement | Lets physical WASD and arrow keys reach the game while ClickGUI is open. Editing a field takes keyboard focus. Disabled by default. |
| **ClickGUI** | Render | Configures the menu shortcut, animations, animation speed, background blur, and outside-click behavior. |

Preferences are stored under `diepAssistPro.settings` in the site's local storage.

## Reading the HUD

- **Source at last draw** in Entity HUD settings shows `canvas`, `telemetry`, or `none`. Canvas is the default. A fresh structured frame takes priority.
- **You (inferred)** identifies the tank the HUD associates with the camera center and tracks as the camera moves.
- **Paint color** comes from the game’s draw calls. In recognized team modes the HUD uses the local tank’s paint to infer friendly or opposing affiliation. In FFA and unrecognized modes it reports paint color.
- **Likely shooter** means the projectile was first observed near a visible muzzle and its later motion matched one candidate. Crowded or off-screen origins can leave shooter identity unknown.
- Shape labels use known neutral colors and normalized polygon outlines. Label placement persists across small movements, and the overlay can hold a marker through a brief detection gap.

## Non-visual data

`diepAssistPro.playerRoster()` reads the rows in the official custom-server **Admin → Players** panel. While the rows are present, it returns their player IDs, names, teams, local-player flag, spectator status, and team relationship. This panel provides roster information. Entity coordinates and projectile owners need a separate source.

A server or simulator you control can publish a complete frame through the page API. The HUD projects entity coordinates using the supplied camera and classifies affiliation and ownership from IDs. A fresh frame can render over a blank game canvas. Canvas detection resumes when the feed goes 650 ms without an update.

```js
diepAssistPro.publishEntityFrame({
  version: 1,
  tick: 1,
  mode: 'teams',
  localPlayerId: 0,
  camera: { x: 100, y: 200, pixelsPerUnit: 1.5 },
  players: [{ id: 0, teamId: 0 }, { id: 1, teamId: 1 }],
  entities: [
    { id: 'tank-0', kind: 'tank', playerId: 0, x: 100, y: 200, radius: 24, visible: true },
    { id: 'shot-1', kind: 'bullet', ownerId: 1, x: 180, y: 200, radius: 8, visible: true }
  ]
});
```

- Submit increasing integer ticks. A stale tick returns `false`, and invalid data throws a `TypeError`. Call `resetEntityFeed()` before starting a provider with a new tick sequence.
- Use stable entity IDs and player IDs. `ownerId` references a player ID. Coordinates, the camera center, and radius use the same world units. Supported entity kinds are `tank`, `bullet`, `projectile`, and `shape`.
- The provider supplies `visible` for each entity. A frame with an empty `entities` array clears the HUD. Unknown fields can be omitted, and an explicit `teamId` supplies affiliation even when `ownerId` is unavailable.
- Use `mode: 'teams'` or `mode: 'ffa'`. Team IDs `0`–`3` display as Blue, Red, Purple, and Green. Other IDs are displayed as `Team <id>`.

Diep.io’s published custom-server interface does not document a live entity feed. On the official site, the HUD starts with Canvas detection and can read the Admin roster when it is present. [Diep.io custom-server commands](https://diep.io/commands)

## Code map

The userscript registers its observers at document start so it can follow the renderer and the game’s input listeners. ClickGUI mounts once the DOM is ready.

- `installEntityHud()` collects Canvas 2D geometry, classifies shapes and tanks, and tracks projectiles across rendered frames. `drawHud()` converts backing-canvas coordinates to CSS pixels. `updateMarkers()` keeps display placement separate from observations.
- `createEntityFeed()` validates structured frames, resolves player and projectile identities, and projects world coordinates into the HUD. `readAdminRoster()` reads the custom-server player rows independently of Canvas.
- `move()` and `release()` manage Mouse Control. `syncMovementKeys()` reconciles physical keys with the movement keys currently delivered to the game when the menu or focus changes.
- `createGui()` builds ClickGUI. `renderModules()` handles category and search results, and `applyMenuAppearance()` applies the saved appearance settings.

### Console API

| Call | Result |
| --- | --- |
| `diepAssistPro.visibleEntities()` | Latest observed entities and their `source`. Structured entries also include `entityId`, `playerId`, and `ownerId`. Coordinates and radius are CSS pixels relative to the game canvas. Undetermined classifications return `'unknown'`. |
| `diepAssistPro.entitySource()` | `canvas`, `telemetry`, or `none`. |
| `diepAssistPro.playerRoster()` | Structured player rows currently available in the custom-server Admin panel. |
| `diepAssistPro.publishEntityFrame(frame)` / `diepAssistPro.resetEntityFeed()` | Publishes a complete renderer-independent frame or resets the provider state. |
| `diepAssistPro.move(x, y)` | Applies a position in CSS pixels relative to the browser viewport. |
| `diepAssistPro.release()` | Releases Mouse Control. |
| `diepAssistPro.openMenu()` / `diepAssistPro.closeMenu()` | Opens or closes ClickGUI. |

Check syntax from the project directory with `node --check "Diep Assist Pro.user.js"`.
