# Real game patterns

Patterns observed in real projects: durak (card game), checkers (board game), slot_beijin_duck + slot_freya (slots), soccer-x-game-v2 (crash/multiplier).

## DI: tsyringe container

All complex projects use `tsyringe` for dependency injection.

`/games/<project>/assets/src/types/diTokens.ts` (or in lib):
```typescript
import { InjectionToken } from 'tsyringe';
export const EventBusToken: InjectionToken<EventBus> = Symbol('EventBus');
export const ClientProviderToken: InjectionToken<ClientProvider> = Symbol('ClientProvider');
export const ConnectionServiceToken: InjectionToken<ConnectionService> = Symbol('ConnectionService');
export const UiManagerToken: InjectionToken<UIManager> = Symbol('UIManager');
export const GameManagerToken: InjectionToken<GameManager> = Symbol('GameManager');
```

Registration via Installer pattern (`/assets/src/installers/libInstaller.ts`):
```typescript
class LibInstaller {
  init() {
    container.registerSingleton(EventBusToken, EventBus);
    container.registerSingleton(ClientProviderToken, ClientProvider);
    container.registerSingleton(GameManagerToken, GameManager);
    // ...
  }
}
```

Resolution in components:
```typescript
import { container } from 'tsyringe';
import { EventBusToken } from '../types/diTokens';

class MyComponent extends Container {
  private eventBus?: EventBus;
  
  init() {
    super.init();
    this.eventBus = container.resolve<EventBus>(EventBusToken);
    this.eventBus.on('event-name', this.handler, this);
  }
  
  onRemove() {
    super.onRemove();
    this.eventBus?.off('event-name', this.handler, this);
  }
}
```

**Requires `reflect-metadata` import at game.ts top** (already there).

## EventBus (mitt-based)

`/libs/skill-games-client-lib/assets/src/services/eventBus.ts`:
```typescript
import mitt, { Emitter } from 'mitt';

class EventBus {
  private emitter: Emitter<EventMap> = mitt();
  
  on<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void, context?: any) { ... }
  off<K extends keyof EventMap>(event: K, handler: Function, context?: any) { ... }
  emit<K extends keyof EventMap>(event: K, data?: EventMap[K]) { ... }
}
```

**Event types observed:**

Card games (durak): `auth`, `begin`, `find`, `found`, `gameover`, `wallet`, `actionsAvailable`, `cardsChanged`, `roundFinish`, `logon`

Board (checkers): `game/room_update`, `game/table_update`, `game/game_offer`, `game/round_begin`, `game/turn_offer`, `game/turn_make`, `game/game_end`, `bankerfun/balance_update`, `lobby/timeout`, `close`

Slots: `roundResultConfirmed`, `playerBetSet`, `bonusGameEnded`, `freeSpinsShown`, `spinComplete`

Crash: `flightTick { coefficient }`, `betWin { bet }`, `roundSwitched { round }`, `streakMeterUpdate`, `gameLogin { player }`, `connectStatusChanged(status)`

## State machines (XState-like)

Used heavily in checkers + slots:

`/games/livegames-checkers/assets/src/utils/stateMachine.ts` (custom impl):
```typescript
class StateMachine<TContext, TEvent> {
  current: BaseState<TContext>;
  context: TContext;
  
  send(event: TEvent) {
    const transition = this.current.transitions[event.type];
    if (transition) {
      this.current.exit(this.context);
      this.current = transition.target;
      this.current.enter(this.context, event);
    }
  }
}

abstract class BaseState<TContext> {
  abstract transitions: Record<string, StateTransition>;
  abstract enter(context, event): void;
  abstract exit(context): void;
}
```

**Slot state graph:**
```
IdleState
  ├─[IdleToSpinTransition]→ SpinState
SpinState
  ├─[SpinToIdleTransition]→ IdleState (early exit)
  ├─[SpinToResultTransition]→ SpinResultState
SpinResultState → WinCombinationState
WinCombinationState → BonusState | FreeSpinState | IdleState
BonusState → IdleState
FreeSpinState → FreeSpinTickState → ... → IdleState
AutoplayState (loops IdleToSpin)
SyncState (reconnect)
RoundEndState
```

**Crash state graph:**
```
'init' → 'start' → 'prepare' (0.8s) → 'game' → 'award'
```

## Screen registry pattern

`/libs/skill-games-client-lib/assets/src/interfaces/screen.ts`:
```typescript
interface IScreen {
  show(): void;
  close(): void;
}

interface IUIManager {
  add(screen: IScreen, name: string): void;
  remove(name: string): void;
  show(name: string): IScreen | undefined;
  close(name: string): void;
}
```

`/libs/ui-common-lib/assets/src/custom/screens/screen-base.c.ts`:
```typescript
export default class BaseScreen extends Resizer implements IScreen {
  init(): void {
    super.init();
    const uiManager = container.resolve<IUIManager>(UiManagerToken);
    uiManager.add(this, this.name!);
  }
  
  show(): void { this.visible = true; }
  close(): void { this.visible = false; }
  
  onRemove(): void {
    super.onRemove();
    const uiManager = container.resolve<IUIManager>(UiManagerToken);
    uiManager.remove(this.name!);
  }
}
```

UIManager keeps Map<name, IScreen>, exposes show/close by name.

## Bootstrap pattern

`/games/<project>/assets/src/custom/scene/main.c.ts`:
```typescript
export default class Main extends Scene {
  init() {
    new LibBootstrap().init();
    super.init();
  }
}
```

`/games/<project>/assets/src/installers/libBootstrap.ts`:
```typescript
export class LibBootstrap implements IInitable {
  public init(): void {
    new LibInstaller().init();
    
    const gameManager = container.resolve<GameManager>(GameManagerToken);
    gameManager.init();
  }
}
```

`GameManager.init()` typically:
- Resolves UIManager + ConnectionService
- Calls `uiManager.init()` (sets up screen visibility handlers)
- Calls `connectionService.connect()`
- Wires page visibility events

**Skip re-init if preloader already ran:**
```typescript
init() {
  if (!(window as any).fromPreloader) {
    new LibBootstrap().init();
  }
  super.init();
}
```

## Networking

### Card games (durak SDK)
`/games/skill-games-durak/assets/src/services/connectionService.ts`:
- WebSocket via `@skillgames/durak` + `@updau/durak-sdk`
- DurakClient instance:
  ```typescript
  this.client = new DurakClient({ url, deviceCode });
  this.client.on('authResponse', (data) => eventBus.emit('auth', data));
  this.client.on('beginResponse', (data) => eventBus.emit('begin', data));
  // ...
  ```
- Actions: `client.attack(cards)`, `client.defend(card)`, `client.transfer(card)`, `client.take()`, `client.finish()`

### Board games (checkers + livegames protocol)
`/games/livegames-checkers/assets/src/services/connectionService.ts`:
```typescript
import { WebSocketTransport, LivegamesKernel, MessageBuilder, PackBuilder } from '@livegames/protocol';
import Checkers from '@livegames/backgammon';

// Connection stack: WebSocketTransport → LivegamesKernel → Checkers client → EventBus
const transport = new WebSocketTransport(wssUrl);
const kernel = new LivegamesKernel(transport, messageBuilder, packBuilder);
await kernel.logon(deviceCode);
this.checkers = new Checkers(kernel);
this.checkers.on('game/room_update', (data) => eventBus.emit('game/room_update', data));
```

### Slots (Trueplay SDK)
`/libs/slots_lib/assets/src/games-libs/providers/trueplay/trueplaySlots.ts`:
```typescript
import { Client } from '@trueplay/slot-clients/classic';

class TrueplaySlots implements IGameProvider {
  makeBet(options: BetOptions) {
    return this.client.spin({ amount: options.amount, lines: options.lines });
  }
  confirmResults() { /* ack server */ }
  bonusGameAction(variant) { /* pick-me selection */ }
}
```

Server returns `SlotClassicRound { spin: { symbols: string[][], result: { wins: Win[], scatters: ... } } }`.

### Crash (Trueplay Crash SDK)
`/libs/cosmotrip-lib-v2/assets/src/games-libs/trueplay/trueplayCosmotrip.ts`:
- Real-time multiplier streaming via `flightTick` events
- 3-slot betting (SlotA/B/C)
- `streakMeter` insurance (0.5× protection on losses)

## Network → EventBus flow

```
Server message
  ↓
ConnectionService.client.on(eventType, handler)
  ↓
handler maps to EventBus.emit(eventName, payload)
  ↓
Component listeners (registered in init via eventBus.on)
  ↓
StateMachine.send() OR direct UI update
```

## Balance crypto (security)

Slots + checkers protect balance:
```typescript
import { BalanceCrypto } from '@skillgames/core';

this.balance = BalanceCrypto.balanceDecode(info.user.balance, info.session.key) / 100;
```

Server sends encrypted balance; client decrypts with session key (anti-tamper).

## Device code persistence

```typescript
localStorage.setItem('quick-login', logonResponse.user.login);
localStorage.setItem('quick-password', logonResponse.user.password);
// deviceCode generated from browser fingerprint
const deviceCode = await generateDeviceCode();
```

## OrientationService pattern (durak)

Decouples layout from game.isPortrait polling:
```typescript
class OrientationService {
  private isPortrait = false;
  
  init() {
    setInterval(() => {
      if (this.isPortrait !== game.isPortrait) {
        this.isPortrait = game.isPortrait;
        eventBus.emit('orientationChanged', { isPortrait: this.isPortrait });
      }
    }, 100);
  }
}
```

Or use OrientationTrigger component (built-in) for declarative variants.

## Slot engine patterns

### Reel base
- `SymbolView extends Container` — minimal id property
- `SpawnerFactory` — creates/releases symbols with pooling
- 5 cols × 3 rows board grid

### Symbol pooling
```typescript
class SpawnerFactory {
  pool: Map<string, SymbolView[]> = new Map();
  
  createSymbol(name: string): SymbolView {
    return this.pool.get(name)?.pop() || new SymbolView(name);
  }
  
  releaseSymbol(symbol: SymbolView) {
    if (!this.pool.has(symbol.name)) this.pool.set(symbol.name, []);
    this.pool.get(symbol.name)!.push(symbol);
  }
}
```

### Spin animation (acceleration → decel → stop)

`/games/slot_beijin_duck/assets/src/animation/spinAnimation.ts`:
1. **Bounce in:** 0.1s up 30px + 0.1s down 30px (TickerTween)
2. **Loop:** continuous scroll at `_speedPxPerSec`, dynamically spawning symbols at `_spacingPx` intervals
3. **Stop (SpinAnimationStop):** variable duration (0.05s turbo / full normal), spine `stop` animation 1.5-4× speed
4. **Idle:** hold position, play `idle` spine loop

Spine states: `blur` (spinning) → `stop` (decel) → `idle`/`win`.

### Win line drawing
- Server returns pre-calculated `Win[]`:
  ```typescript
  interface Win { cash: string; layout: string; line: string; wild: string; }
  ```
- **WinLabelBuilder** positions labels on paylines
- **PositionCurveAnimation** uses LerpCurve for non-linear label movement

### Symbol matching
**100% server-driven.** Client just renders received `SpinData.wins[]`.

### Bonus trigger
Server flag `bonusGame: true` in scatter data → route to BonusState.

`BonusCell` (`/custom/bonus-cell.c.ts`):
- Cell ID mapped to win value
- Click: spine `press` → `reveal` → number display
- ChooseFromAllController accumulates payout

### Free spins
```typescript
interface ScatterValues {
  isFreeSpins: boolean;
  spinsAmount: number;
  scatterReelNumber: number[];
  scatterReelPosition: number[][];
}
```

Cascade: blackout → scatter glow → counter update → FreeSpinTickState loop. Re-trigger collected during FS.

### Big-win cascade
- Big win: ≥5× bet → play `big_win` sound
- Mega win: ≥20× bet
- Super win: ≥50× bet
- Counter animation: scale up + falling number particles

### Auto-spin / quick-spin
- AutoplayState loops spin requests with configurable count
- SpeedController scales animation durations
- Turbo: `isTurboSpin` flag bypasses to 0.05s instead of full
- Input guard disables buttons during spin

### Audio phases
```json
"loadOnDemandSounds": {
  "sounds/music_main": 2,
  "sounds/music_fs": 2,
  "sounds/start_spin": 2,
  "sounds/stop_spin": 2,
  "sounds/scatter_1/2/3": 2,
  "sounds/scatter_wins": 2,
  "sounds/coins_fall_loop": 2,
  "sounds/coins_fall_end": 2,
  "sounds/big_win": 2,
  "sounds/mega_win": 2,
  "sounds/super_win": 2,
  "sounds/wild_symbol": 2,
  "sounds/free_spins": 2,
  "sounds/BonusButton": 2
}
```

Music phases: idle (music_main) → spin → result (escalating sounds) → free spins (music_fs) → bonus.

## Crash engine patterns (soccer-x-game-v2)

### Coefficient streaming
`onFlightTick({ coefficient })` server event every frame:
```typescript
flyUnit.showWindEffectByCoefficient(coef, 2, 6);
flyUnit.showFireEffectByCoefficient(coef, 5, 10);
flyUnit.increaseRotationSpeedByCoefficient(coef, 0, 10);
increaseFillSpeed(coef, 0, 10);
```

### Multiplier display (CashoutCounter)
```typescript
score = betAmount * coefficient * cashoutMultiplier;
```
Updates every flightTick. Half-cashout (0.5×) for streak insurance.

### Bet placement
```typescript
interface CosmotripBet {
  amount: number;
  type: 'SlotA' | 'SlotB' | 'SlotC';
  cashoutCoefficient?: number;
  autoCashoutCoefficient?: number;
  streakMeterApplied?: boolean;
  autoBetIterations?: number;
}
```

### Cash-out flow
1. Bet placed before `prepare`
2. Flight begins, coefficient increments
3. Player cashes out manually OR auto-cashout triggers at threshold
4. Round ends, server validates timing vs actual crash point

### Streak insurance
Server applies `streakMeterApplied: true` → half-payouts on losses (0.5× protection).

## TickerTween animation pattern

```typescript
import TickerTween from '...';
import { Easing } from '...';

new TickerTween(card, 0.3)
  .moveTo({ x: target.x, y: target.y }, Easing.outCubic)
  .to(() => card.angle, v => card.angle = v, targetAngle, Easing.outCubic)
  .alphaTo(0.5, Easing.linear)
  .onComplete(() => tween.destroy())
  .start();
```

Composable, callbacks, manual destroy (or `onComplete` cleanup).

## Data-path component binding

```typescript
@editable({ type: 'data-path', isValueValid: (o: any) => o instanceof MovieClip })
cardSpritePath: string | null = null;

private cardSprite?: MovieClip;

init() {
  super.init();
  if (this.cardSpritePath) {
    this.cardSprite = getValueByPath(this.cardSpritePath, this);
  }
}
```

Enables loose coupling: scene can rewire bindings without code changes.

## Prefab parameter injection

Prefabs expose paths as editable props:
```json
{
  "cardSpritePath": "this.#cardSprite",
  "shadeShapePath": "this.#shadowShape"
}
```
Scene instantiates prefab + passes paths; prefab resolves at init.

## MovieClip timeline actions

```json
{
  "a": "this.parent.setBack"
},
{
  "a": "this.stop"
}
```
Keyframes can trigger arbitrary methods → choreography without code.

## Cards/Pieces factory

`CardFactory` / `PieceFactory` classes create instances dynamically:
```typescript
class CardFactory extends Container {
  public readonly PROGRESS_OFFSET = 30;
  
  createCard(suit: string, value: string): CardItem {
    const card = Lib.loadPrefab('cardItemPrefab') as CardItem;
    card.suit = suit;
    card.value = value;
    return card;
  }
}
```

## Service injection pattern

`/libs/skill-games-client-lib/assets/src/managers/gameManager.ts`:
```typescript
@injectable()
class GameManager implements IInitable {
  constructor(
    @inject(EventBusToken) private eventBus: EventBus,
    @inject(UiManagerToken) private uiManager: IUIManager,
    @inject(ConnectionServiceToken) private connectionService: ConnectionService,
  ) {}
  
  init() {
    document.addEventListener('visibilitychange', this.handleVisibility);
    this.eventBus.on('logon', this.handleLogon, this);
    this.connectionService.connect();
  }
}
```

## Library layering (real game lib hierarchy)

```
skill-games-durak (game)
  └─ skill-games-client-lib (base: bootstrap, services, types)
  └─ ui-common-lib (LayoutGroup, screens, custom buttons)

livegames-checkers (game)
  └─ ui-common-lib

slot_beijin_duck + slot_freya (games)
  └─ slots_lib (state machine, models, providers, services)
  └─ slots-ui-lib (BetSelector, FreebetViews, screens)

soccer-x-game-v2 (crash game)
  └─ cosmotrip-lib-v2 (crash core, models)
  └─ ui-common-lib
  └─ sport-ui-lib (MainScene, BetController, CashoutCounter, soccer extensions)
```

## ui-common-lib LayoutGroup

`/libs/ui-common-lib/assets/src/custom/layout-group.c.ts`:
- Extends Shape
- Properties: orientation Horizontal|Vertical, wrap, dynamicSize, sizeModeH/V none|stretch|shrink|both, spacingX/Y, paddingLeft/Right/Top/Bottom, aligmentX/Y (0-1)
- `layoutChildren()` called on init/child add/remove
- EDITOR refresh every 40ms

## Slot/crash architecture comparison

| Aspect | Slots | Crash |
|--------|-------|-------|
| Multiplier | Static paylines (5-20× fixed) | Dynamic coefficient (1.0× - ∞) |
| Physics | Discrete reel states | Continuous curve animation |
| Win trigger | Symbol match (server) | Crash point prediction |
| RTP | Pre-determined symbols | Real-time multiplier stream |
| Bet timing | Before spin | Before flight |
| Cashout | N/A | Manual or auto threshold |
| Audio | Discrete win sounds | Looping tension track |
| History | Spin results archive | Bet outcomes + crash points |

Both share: tsyringe DI, EventBus mitt, StateMachine, server-driven outcomes (TruePlay backend), symbol pooling, multi-phase audio, mobile-responsive UI.

## Common pitfalls in real games

1. **Forgotten super calls** — EDITOR_FLAGS Set assertion catches at next init/onRemove
2. **Direct DI resolution in update() loop** — resolve once in init()
3. **Multiple eventBus.on subscriptions** — events re-emit after class reload; check via flag or always cleanup in onRemove
4. **Hidden DI tokens across libs** — check both game and lib `types/diTokens.ts` (they can clash)
5. **Forgetting BalanceCrypto** — raw `info.user.balance` is encrypted
6. **Server time vs client time** — never trust client time for game logic
7. **Manual `game.editor.editProperty()` from runtime** — `game.editor` undefined; check `/// #if EDITOR`
8. **Persisting state in localStorage** — clear on logout to avoid stale session data
