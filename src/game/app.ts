import {
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  RenderTargetTexture,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import {
  audio,
  checkpoint as sfxCheckpoint,
  crash as sfxCrash,
  duckEngine,
  finish as sfxFinish,
  initAudio,
  lap as sfxLap,
  land as sfxLand,
  setAudioVolume,
  setEngineParams,
  startEngine,
  stopEngine,
  tireScreech as sfxScreech,
  updateAudio,
  wrongWay as sfxWrongWay,
} from "./audio";
import { CameraRig } from "./cameras";
import { PadSetup } from "./pad-setup";
import { MiniMap } from "./minimap";
import { Frogs } from "./frogs";
import { Hud } from "./hud";
import { InputManager, type InputFrame } from "./input";
import { PALETTE, mix } from "./palette";
import { Race, START_BACK as GRID_BACK, type RaceEvent } from "./race";
import {
  DEFAULT_SETTINGS,
  EMPTY_RECORDS,
  clearRecords,
  loadRecords,
  loadSettings,
  saveRecords,
  saveSettings,
  storageAvailable,
  type Records,
  type Settings,
} from "./settings";
import { CIRCUITS, Track } from "./track";
import { Traffic } from "./traffic";
import { Car, type VehicleInput } from "./vehicle";
import { clamp, formatLapTime, wrap01 } from "./utils";

/** Pas de simulation fixe : 120 Hz, indépendant de la fréquence d'affichage. */
const PHYS_STEP = 1 / 120;
const MAX_STEPS = 6;
const LAP_COUNT = 3;
/** Vitesse de référence du châssis sur route (m/s) : sert à l'audio et au HUD. */
const SPEED_REFERENCE = 62.5;

const NEUTRAL: VehicleInput = { steer: 0, throttle: 0, brake: 0, handbrake: false };

/**
 * Cœur du jeu : assemble la scène, la physique du véhicule, les entrées, la
 * progression de course, les caméras et l'interface, puis fait tourner la
 * boucle (pas physique fixe + rendu).
 */
export class Game {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private settings: Settings;
  private records: Records;

  private readonly world: TransformNode;
  private readonly track: Track;
  private readonly car: Car;
  private readonly traffic: Traffic;
  private readonly frogs: Frogs;
  private readonly race: Race;
  private readonly rig: CameraRig;
  private readonly minimap: MiniMap;
  private readonly padSetup: PadSetup;
  private readonly input: InputManager;
  private readonly hud: Hud;
  private readonly shadow: ShadowGenerator;
  private readonly shadowReceivers: Mesh[] = [];

  private accumulator = 0;
  private lastS = 0;
  private lastFrame = 0;
  private goTimer = 0;
  private prevSlip = 0;
  private prevOnRoad = true;
  private hint = 0;
  private lastSteps = 0;
  private audioReady = false;
  private started = false;
  private menuTime = 0;
  private readonly stepInput: VehicleInput = { ...NEUTRAL };
  private readonly prevStepInput: VehicleInput = { ...NEUTRAL };
  private readonly focusPoint = new Vector3();
  private readonly detach: (() => void)[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.settings = loadSettings();
    this.records = loadRecords();

    this.engine = new Engine(canvas, true, { stencil: true, antialias: true, powerPreference: "high-performance" }, true);
    this.applyResolution();

    this.scene = new Scene(this.engine);
    this.world = new TransformNode("world", this.scene);
    this.scene.clearColor = new Color4(0.66, 0.78, 0.87, 1);
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.scene.fogColor = PALETTE.fog.clone();
    this.scene.fogDensity = 0.0024;
    this.scene.imageProcessingConfiguration.toneMappingEnabled = true;
    this.scene.imageProcessingConfiguration.exposure = 1.08;
    // Le prototype n'utilise pas de chaîne de post-process : c'est chaque matériau
    // qui applique exposition, tone mapping puis retour en sRGB. Dans ce mode,
    // Babylon part d'une couleur supposée en sRGB (toLinearSpace → traitement →
    // toGammaSpace), d'où une palette conservée en sRGB (voir palette.ts).
    this.scene.imageProcessingConfiguration.applyByPostProcess = false;

    // --- lumières ------------------------------------------------------------
    const hemi = new HemisphericLight("hemi", new Vector3(-0.3, 1, -0.35), this.scene);
    // L'éclairage des StandardMaterial se fait en espace sRGB (voir palette.ts) :
    // des intensités proches de 1 suffisent, au-delà les couleurs sont écrêtées
    // avant le tone mapping et les surfaces partent en aplat.
    hemi.intensity = 0.55;
    hemi.diffuse = new Color3(0.88, 0.93, 1);
    hemi.groundColor = PALETTE.grassDry.scale(0.55);
    hemi.specular = new Color3(0.1, 0.1, 0.1);

    const sun = new DirectionalLight("sun", new Vector3(-0.5, -0.66, -0.55), this.scene);
    sun.intensity = 1.05;
    sun.diffuse = PALETTE.sunCore.scale(1.02);
    sun.specular = PALETTE.sunGlow.scale(0.9);
    sun.position.set(300, 400, 330);

    this.shadow = new ShadowGenerator(1024, sun);
    this.shadow.useBlurExponentialShadowMap = true;
    this.shadow.blurKernel = 24;
    this.shadow.darkness = 0.42;
    this.shadow.bias = 0.0016;
    this.shadow.forceBackFacesOnly = true;

    // --- ciel ----------------------------------------------------------------
    // Dégradé zénith/horizon peint directement dans les couleurs de sommets :
    // aucun shader personnalisé, donc aucune surprise de syntaxe GLSL selon WebGL1/2.
    const skyDome = MeshBuilder.CreateSphere(
      "sky-dome",
      { diameter: 3600, segments: 24, sideOrientation: Mesh.BACKSIDE },
      this.scene,
    );
    const skyPositions = skyDome.getVerticesData("position");
    if (skyPositions) {
      const skyColors = new Float32Array((skyPositions.length / 3) * 4);
      // Dégradé piloté par l'élévation angulaire et non par le y brut : la caméra
      // reste à ~1 m du sol, donc tout le ciel visible tient dans les 10 premiers
      // degrés. Un mélange direct horizon → zénith traversait un gris mauve
      // désaturé (R ≈ B) ; on passe par le bleu clair intermédiaire, et la
      // chaleur de l'horizon se referme en ~26° pour laisser la place au bleu.
      const toDegrees = 180 / Math.PI;
      for (let index = 0; index < skyPositions.length / 3; index += 1) {
        const elevation = Math.asin(clamp(skyPositions[index * 3 + 1] / 1800, -1, 1)) * toDegrees;
        const step = Math.pow(clamp(elevation / 26, 0, 1), 0.8);
        const tint =
          step < 0.4
            ? mix(PALETTE.skyHorizon, PALETTE.skyMiddle, step / 0.4)
            : mix(PALETTE.skyMiddle, PALETTE.skyZenith, (step - 0.4) / 0.6);
        skyColors[index * 4 + 0] = tint.r;
        skyColors[index * 4 + 1] = tint.g;
        skyColors[index * 4 + 2] = tint.b;
        skyColors[index * 4 + 3] = 1;
      }
      skyDome.setVerticesData("color", skyColors);
    }
    const sky = new StandardMaterial("sky-material", this.scene);
    // En l'absence d'éclairage, la couleur affichée est émissive × couleur de
    // sommet : laisser emissiveColor noir réduisait tout le ciel à du noir, et le
    // dôme (backFaceCulling désactivé) recouvrait alors toute la scène.
    sky.disableLighting = true;
    sky.diffuseColor = Color3.Black();
    sky.emissiveColor = Color3.White();
    sky.specularColor = Color3.Black();
    sky.backFaceCulling = false;
    sky.fogEnabled = false;
    skyDome.material = sky;
    skyDome.infiniteDistance = true;
    skyDome.applyFog = false;
    skyDome.isPickable = false;
    skyDome.layerMask = 0x00000001;

    // --- circuit + décor -----------------------------------------------------
    this.track = new Track(this.scene, this.world, CIRCUITS[this.settings.circuit] ?? CIRCUITS.cretes);
    this.track.build();
    this.track.clearGateStates();

    // --- voiture -------------------------------------------------------------
    this.car = new Car(this.scene, PALETTE.carBody.clone());
    this.car.root.parent = this.world;
    this.car.placeAt(this.gridSlot(this.focusPoint), this.track.startHeading);
    const casters = this.car.root
      .getChildMeshes(false)
      .filter((mesh): mesh is Mesh => mesh instanceof Mesh);
    this.shadow.getShadowMap()?.renderList?.push(...casters);
    for (const mesh of this.scene.meshes) {
      if (mesh instanceof Mesh && mesh.receiveShadows) this.shadowReceivers.push(mesh);
    }

    // --- trafic ---------------------------------------------------------------
    this.traffic = new Traffic(this.scene, this.world, this.track, this.settings.trafficCount);
    this.frogs = new Frogs(this.scene, this.world, this.track, this.settings.frogCount);

    // --- caméras, entrées, interface -----------------------------------------
    this.rig = new CameraRig(this.scene);
    this.minimap = new MiniMap(document.getElementById("hud-map") as HTMLCanvasElement, this.track);
    this.input = new InputManager();
    this.hud = new Hud(
      {
        onPlay: () => this.startRace(),
        onResume: () => this.resume(),
        onRestart: () => this.startRace(),
        onQuit: () => this.quitToMenu(),
        onSettingsChange: (next) => this.applySettings(next),
        onResetSettings: () => {
          const fresh = { ...DEFAULT_SETTINGS };
          this.applySettings(fresh);
          this.hud.syncSettings(fresh);
        },
        onResetRecords: () => {
          clearRecords();
          this.records = { ...EMPTY_RECORDS };
          this.hud.setRecords(this.records);
          this.hud.toast("Records effacés.", 1500);
        },
      },
      this.settings,
      this.records,
    );

    this.padSetup = new PadSetup(this.input);

    this.race = new Race(this.track, LAP_COUNT, (event) => this.onRaceEvent(event));
    this.applySettings(this.settings);
    if (storageAvailable) this.hud.bootDone();
    else this.hud.setNotice("Réglages non sauvegardés : stockage indisponible.");

    // --- événements du navigateur --------------------------------------------
    const onResize = (): void => {
      this.engine.resize();
      this.applyResolution();
    };
    const onVisibility = (): void => {
      if (document.hidden && this.race.phase === "racing") this.pause();
    };
    const onWake = (): void => this.ensureAudio();
    const onContextLost = (event: Event): void => event.preventDefault();
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pointerdown", onWake);
    window.addEventListener("keydown", onWake);
    canvas.addEventListener("webglcontextlost", onContextLost);
    this.detach.push(() => {
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointerdown", onWake);
      window.removeEventListener("keydown", onWake);
      canvas.removeEventListener("webglcontextlost", onContextLost);
    });
    this.rig.applyTo(this.scene);
  }

  /** Position sur la grille : juste avant la ligne d'arrivée. */
  private gridSlot(out: Vector3): Vector3 {
    return this.track.positionAt(this.track.totalLength - GRID_BACK, 0, out);
  }

  private applyResolution(): void {
    const ratio = window.devicePixelRatio || 1;
    this.engine.setHardwareScalingLevel(1 / Math.min(ratio, 2));
  }

  /** Lance la boucle de rendu : les menus aussi sont animés par cette boucle. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.lastFrame = performance.now();
    this.engine.runRenderLoop(() => this.frame());
  }

  // ---------------------------------------------------------------------- boucle

  private frame(): void {
    const now = performance.now();
    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
    if (dt > 0.25) dt = 1 / 60; // retour d'un onglet placé en arrière-plan

    const inMenus = this.hud.inMenus;
    this.input.configuring = this.hud.screen === "controller";
    const frame = this.input.update(inMenus);
    this.padSetup.update(this.input.configuring);
    this.hud.setPadPrompt(frame.padPending && inMenus);

    if (inMenus) {
      if (this.input.padReady && !this.input.configuring) this.hud.navigate(frame);
      if (frame.pause) this.hud.goBack();
      this.menuCamera(dt);
    } else {
      if (frame.pause) this.pause();
      else if (frame.resetCar) this.recover();
      else if (frame.switchCamera) this.switchCamera();
      if (this.hud.screen === "game") {
        this.simulate(dt, frame, this.race.phase !== "finished");
        this.traffic.update(dt, this.car.position);
        this.trafficCollide();
        this.coneCollide();
        this.frogCollide(dt);
        this.rig.update(this.car, dt);
        this.minimap.update(
          this.car.renderPos,
          this.car.renderHeading,
          clamp(this.lastS / this.track.totalLength, 0, 1),
          this.race.lap,
          this.race.totalLaps,
        );
      }
    }

    this.updateVisuals(dt);
    this.updateAudioState();
    this.updateHud(frame);
    this.scene.render();
  }

  // -------------------------------------------------------------------- conduite

  /**
   * Une image de jeu : commandes -> pas physique fixe -> progression de course.
   * Si l'image est plus longue que le pas, le premier pas réutilise les
   * commandes de l'image précédente, les suivants prennent les nouvelles.
   */
  private simulate(dt: number, frame: InputFrame, driving: boolean): void {
    const source: VehicleInput = driving
      ? { steer: frame.steer, throttle: frame.throttle, brake: frame.brake, handbrake: frame.handbrake }
      : NEUTRAL;
    this.copyInput(this.stepInput, source);

    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= PHYS_STEP && steps < MAX_STEPS) {
      this.accumulator -= PHYS_STEP;
      const command = steps === 0 ? this.prevStepInput : this.stepInput;
      steps += 1;
      this.car.update(PHYS_STEP, command, this.track);

      const here = this.track.query(this.car.position.x, this.car.position.z, this.car.heading, this.hint);
      this.hint = here.index;
      this.race.update(PHYS_STEP, here.s, !here.offTrack);
      this.lastS = here.s;

      if (this.car.readout.impact > 0.02) sfxCrash(this.car.readout.impact);
      const slip = this.car.skidIntensity;
      if (this.prevSlip < 0.4 && slip >= 0.4) sfxScreech(slip);
      this.prevSlip = slip;
      if (this.prevOnRoad && here.offTrack && Math.abs(this.car.forwardVelocity) > 20) sfxLand();
      this.prevOnRoad = !here.offTrack;
    }
    if (steps === MAX_STEPS) this.accumulator = 0; // pas de dette de simulation
    this.car.blendRender(clamp(this.accumulator / PHYS_STEP, 0, 1));
    this.lastSteps = steps;
    this.copyInput(this.prevStepInput, this.stepInput);
  }

  private copyInput(target: VehicleInput, source: VehicleInput): void {
    target.steer = source.steer;
    target.throttle = source.throttle;
    target.brake = source.brake;
    target.handbrake = source.handbrake;
  }

  /** Remise en piste : on repose la voiture un peu plus loin sur la trajectoire. */
  private recover(): void {
    const here = this.track.query(this.car.position.x, this.car.position.z, this.car.heading, this.hint);
    const length = this.track.totalLength;
    const s = wrap01((here.s + 8) / length) * length;
    this.car.placeAt(this.track.positionAt(s, 0, this.focusPoint), this.track.headingAt(s));
    this.hint = this.track.query(this.car.position.x, this.car.position.z, this.car.heading, here.index).index;
    this.lastS = s;
    this.accumulator = 0;
  }

  /** Contact joueur ↔ trafic : ralentissement, rebond et son de choc. */
  private trafficCollide(): void {
    for (const runner of this.traffic.list) {
      const other = runner.car.position;
      if (this.car.collideWith(other.x, other.z, 2.4)) sfxCrash(this.car.readout.impact);
    }
  }

  /** Contact joueur ↔ cône de chantier : le cône se renverse, petit choc. */
  private coneCollide(): void {
    if (Math.abs(this.car.forwardVelocity) < 2) return;
    if (this.track.knockCones(this.car.position.x, this.car.position.z, 1.05)) {
      this.car.readout.impact = 0.32;
      sfxCrash(0.32);
    }
  }

  /**
   * Grenouilles qui traversent : si la caisse en écrase une, gros choc et
   * dérapage contrôlé vers la barrière la plus proche.
   */
  private frogCollide(dt: number): void {
    if (this.frogs.update(dt, this.car.position, this.car.forwardVelocity)) {
      this.car.swerve(1);
      sfxCrash(0.85);
      sfxScreech(0.8);
      this.hud.toast("Splac ! Grenouille sous les roues, la caisse décroche.", 1400);
    }
  }

  /**
   * Bascule poursuite / cockpit. `toggle` ne fait que changer le mode : il faut
   * rebrancher `scene.activeCameras` sur la scène, sinon l'image ne bouge pas.
   */
  private switchCamera(): void {
    const mode = this.rig.toggle();
    this.car.setCockpitView(mode === "cockpit");
    this.rig.applyTo(this.scene);
    this.hud.toast(mode === "cockpit" ? "Caméra cockpit" : "Caméra poursuite", 1100);
  }

  /** Caméra de présentation : orbite lente autour de la voiture à l'arrêt. */
  private menuCamera(dt: number): void {
    this.menuTime += dt;
    const camera = this.rig.active;
    const position = this.car.position;
    const radius = 9.5;
    const angle = this.menuTime * 0.22 + this.track.startHeading;
    const x = position.x - Math.cos(angle) * radius;
    const z = position.z - Math.sin(angle) * radius;
    const y = position.y + 2.5 + Math.sin(this.menuTime * 0.5) * 0.25;
    camera.position.set(x, y, z);
    const dx = position.x - x;
    const dz = position.z - z;
    camera.rotation.set(
      Math.atan2(y - (position.y + 0.9), Math.hypot(dx, dz) || 0.001),
      Math.atan2(dx, dz),
      0,
    );
    camera.fov = 0.8;
  }

  // ---------------------------------------------------------------------- visuel

  private updateVisuals(dt: number): void {
    if (this.goTimer > 0) {
      this.goTimer -= dt;
      if (this.goTimer <= 0) this.hud.setCountdown(null);
    }
  }

  // ----------------------------------------------------------------------- audio

  /** Ouvre le contexte audio : navigable uniquement après un geste utilisateur. */
  private ensureAudio(): void {
    initAudio(this.settings.volume, this.settings.muted);
    this.audioReady = !!audio.ctx;
  }

  private startAudio(): void {
    this.ensureAudio();
    if (!this.audioReady) return;
    if (!audio.started) startEngine();
    duckEngine(false);
  }

  private stopAudio(): void {
    if (!this.audioReady) return;
    stopEngine();
    this.audioReady = false;
  }

  private updateAudioState(): void {
    if (!this.audioReady) return;
    const readout = this.car.readout;
    const speed = Math.abs(this.car.forwardVelocity);
    const slip = this.car.skidIntensity;
    const offroad = !readout.onRoad;
    if (this.race.phase === "countdown") {
      const rev = 0.45 + 0.4 * Math.sin(performance.now() / 85);
      setEngineParams(0.12 + rev * 0.2, rev, rev, false);
    } else {
      setEngineParams(speed / SPEED_REFERENCE, this.stepInput.throttle, this.stepInput.throttle, offroad);
    }
    updateAudio(speed, slip, offroad, true);
  }

  // ------------------------------------------------------------------------- HUD

  private updateHud(frame: InputFrame): void {
    if (this.hud.screen !== "game") return;
    const readout = this.car.readout;
    const here = this.track.query(this.car.position.x, this.car.position.z, this.car.heading, this.hint);
    this.hud.setSpeed(readout.speedKmh);
    this.hud.setLap(this.race.lap, this.race.totalLaps);
    this.hud.setTimes(this.race.lapMs, this.race.totalMs, this.race.bestLapMs > 0 ? this.race.bestLapMs : null);
    this.hud.setWrongWay(this.race.wrongWay);
    this.hud.setOffTrack(here.offTrack && this.race.phase === "racing");
    if (this.settings.diagnostics) {
      this.hud.diagnostics(
        {
          fps: this.engine.getFps(),
          steps: this.lastSteps,
          speed: this.car.forwardVelocity,
          surface: here.offTrack ? "herbe" : here.onRoad ? "asphalte" : "accotement",
          lateral: here.lateral,
          distance: here.s,
          checkpoints: `${this.race.passed} / ${this.race.checkpointTotal}`,
          camera: this.rig.mode,
        },
        frame,
      );
    }
  }

  /** Applique l'état de la course aux portiques du circuit. */
  private updateGates(): void {
    const racing = this.race.phase === "racing";
    const total = this.track.checkpoints.length;
    for (let index = 0; index < total; index += 1) {
      let state: "next" | "pending" | "passed" = "pending";
      if (racing) {
        if (index === 0) state = this.race.passed >= this.race.checkpointTotal ? "next" : "pending";
        else if (index <= this.race.passed) state = "passed";
        else if (index === this.race.nextGate) state = "next";
      }
      this.track.setGateState(index, state);
    }
  }

  // ---------------------------------------------------------------------- course

  private onRaceEvent(event: RaceEvent): void {
    switch (event.type) {
      case "countdown": {
        this.hud.setCountdown(event.label);
        if (event.label === "GO") sfxCheckpoint(true);
        else sfxCheckpoint(false);
        break;
      }
      case "start": {
        this.goTimer = 0.75;
        break;
      }
      case "checkpoint": {
        sfxCheckpoint(false);
        this.hud.toast(`Portique ${event.index} / ${event.total}`, 1100);
        this.updateGates();
        break;
      }
      case "wrongway": {
        if (event.active) {
          sfxWrongWay();
          this.hud.toast("Tu roules à l’envers !", 1900);
        }
        this.hud.setWrongWay(event.active);
        break;
      }
      case "lap": {
        sfxLap();
        this.hud.toast(
          `Tour ${event.lap} — ${formatLapTime(event.lapMs)}${event.best ? " · meilleur tour" : ""}`,
          2400,
        );
        this.updateGates();
        break;
      }
      case "finish": {
        this.finishRace(event.lapTimes, event.totalMs, event.bestLapMs);
        break;
      }
    }
  }

  private finishRace(lapTimes: number[], totalMs: number, bestLapMs: number): void {
    let newRecord = false;
    if (bestLapMs > 0 && (this.records.bestLapMs === 0 || bestLapMs < this.records.bestLapMs)) {
      this.records.bestLapMs = bestLapMs;
      newRecord = true;
    }
    if (totalMs > 0 && (this.records.bestTotalMs === 0 || totalMs < this.records.bestTotalMs)) {
      this.records.bestTotalMs = totalMs;
      newRecord = true;
    }
    this.records.runs += 1;
    this.records.lapsCompleted += lapTimes.length;
    saveRecords(this.records);
    this.hud.setRecords(this.records);
    this.updateGates();
    sfxFinish();
    this.stopAudio();
    this.hud.showFinish({ lapTimes, totalMs, bestLapMs, newRecord });
  }

  /** Replace la voiture sur la grille, à l'arrêt, et remet les compteurs à zéro. */
  private spawn(): void {
    this.car.placeAt(this.gridSlot(this.focusPoint), this.track.startHeading);
    this.hint = this.track.query(this.car.position.x, this.car.position.z, this.car.heading, this.hint).index;
    this.prevSlip = 0;
    this.prevOnRoad = true;
    this.lastS = 0;
    this.accumulator = 0;
    this.lastSteps = 0;
    this.minimap.reset();
    this.copyInput(this.stepInput, NEUTRAL);
    this.copyInput(this.prevStepInput, NEUTRAL);
  }

  // ----------------------------------------------------------------- enchaînement

  private startRace(): void {
    this.spawn();
    this.race.restart();
    this.frogs.reset();
    this.updateGates();
    this.rig.reset(this.car);
    this.car.setCockpitView(this.rig.mode === "cockpit");
    this.hud.setScreen("game");
    this.hud.setNotice(null);
    this.hud.setRecords(this.records);
    this.hud.setSpeed(0);
    this.hud.setLap(1, this.race.totalLaps);
    this.hud.setTimes(0, 0, this.records.bestLapMs > 0 ? this.records.bestLapMs : null);
    this.goTimer = 0;
    this.lastFrame = performance.now();
    this.startAudio();
  }

  private pause(): void {
    if (this.race.phase === "finished") return;
    this.hud.openPause(`Tour ${this.race.lap} / ${this.race.totalLaps} · ${formatLapTime(this.race.lapMs)}`);
    duckEngine(true);
  }

  private resume(): void {
    this.hud.setScreen("game");
    duckEngine(false);
    this.lastFrame = performance.now();
    this.accumulator = 0;
  }

  private quitToMenu(): void {
    this.race.abort();
    this.spawn();
    this.car.setCockpitView(false);
    this.track.clearGateStates();
    this.stopAudio();
    this.hud.setCountdown(null);
    this.hud.setSpeed(0);
    this.hud.setWrongWay(false);
    this.hud.setOffTrack(false);
    this.hud.setScreen("home");
  }

  private applySettings(next: Settings): void {
    if (next.circuit !== this.track.circuit.id) {
      // Le circuit (piste, décor, portiques) se construit au démarrage :
      // on sauvegarde le choix et on recharge tout proprement.
      saveSettings(next);
      window.location.reload();
      return;
    }
    this.settings = next;
    this.input.deadzone = next.deadzone;
    this.input.sensitivity = next.steeringSensitivity;
    this.rig.firmness = next.cameraFirmness;
    this.traffic.setCount(next.trafficCount);
    this.frogs.setCount(next.frogCount);
    this.track.setPotholeLevel(next.potholesLevel);
    setAudioVolume(next.volume, next.muted);
    const map = this.shadow.getShadowMap();
    if (map) {
      // 0 = plus jamais rendue, 1 = rendue à chaque image (constantes Babylon).
      map.refreshRate = next.shadows
        ? RenderTargetTexture.REFRESHRATE_RENDER_ONEVERYFRAME
        : RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    }
    for (const mesh of this.shadowReceivers) mesh.receiveShadows = next.shadows;
    saveSettings(next);
  }

  dispose(): void {
    for (const detach of this.detach) detach();
    this.detach.length = 0;
    this.engine.stopRenderLoop();
    this.padSetup.dispose();
    this.input.dispose();
    this.hud.dispose();
    this.rig.dispose();
    this.traffic.dispose();
    this.frogs.dispose();
    this.car.dispose();
    this.track.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }
}

/** Point d'entrée : monte le jeu et lance la boucle de rendu. */
export function boot(canvas: HTMLCanvasElement): Game {
  const game = new Game(canvas);
  game.start();
  return game;
}
