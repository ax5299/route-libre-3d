import type { Track } from "./track";
import { clamp } from "./utils";

/** État du contre-la-montre. */
export type RacePhase = "idle" | "countdown" | "racing" | "finished";

/** Événements transmis à l'interface (HUD, sons, records). */
export type RaceEvent =
  | { type: "countdown"; label: string }
  | { type: "start" }
  | { type: "checkpoint"; index: number; total: number }
  | { type: "lap"; lap: number; lapMs: number; best: boolean }
  | { type: "finish"; totalMs: number; bestLapMs: number; lapTimes: number[] }
  | { type: "wrongway"; active: boolean };

const COUNTDOWN_STEPS = ["3", "2", "1", "GO"] as const;

/** Distance (m) entre la ligne de départ et la voiture au repos. */
export const START_BACK = 6;

/**
 * Progression sur le circuit : portiques, tours, chronos et contresens.
 * On ne lui transmet que l'avancement `s` de la voiture sur la trajectoire.
 *
 * Le portique n° 0 est confondu avec la ligne d'arrivée : il n'est donc pas
 * compté comme point de passage, c'est le franchissement de la ligne qui clot
 * le tour.
 */
export class Race {
  phase: RacePhase = "idle";
  /** Tour affiché, à partir de 1. */
  lap = 1;
  lapMs = 0;
  totalMs = 0;
  bestLapMs = 0;
  lapTimes: number[] = [];
  wrongWay = false;
  /** Portique visé (index dans `track.checkpoints`). */
  nextGate = 1;
  /** Portiques franchis dans le tour en cours (hors ligne d'arrivée). */
  passed = 0;

  private readonly gateS: number[];
  private countdown = 0;
  private countdownStep = -1;
  private previousS = 0;
  private backwards = 0;
  private forwards = 0;

  constructor(
    private readonly track: Track,
    readonly totalLaps: number,
    private readonly onEvent: (event: RaceEvent) => void,
  ) {
    this.gateS = track.checkpoints.map((cp) => cp.s);
  }

  /** Portiques à franchir dans un tour (ligne d'arrivée déduite). */
  get checkpointTotal(): number {
    return Math.max(1, this.gateS.length - 1);
  }

  /** Position du dernier portique (0..total) pour l'affichage. */
  get checkpointIndex(): number {
    return this.passed;
  }

  /** Repart pour une course : compte à rebours inclus. */
  restart(): void {
    this.phase = "countdown";
    this.lap = 1;
    this.lapMs = 0;
    this.totalMs = 0;
    this.bestLapMs = 0;
    this.lapTimes = [];
    this.passed = 0;
    this.nextGate = 1;
    this.countdown = 3;
    this.countdownStep = -1;
    this.wrongWay = false;
    this.backwards = 0;
    this.forwards = 0;
    this.previousS = this.track.totalLength - START_BACK;
  }

  /** Stoppe la course (retour au menu). */
  abort(): void {
    this.phase = "idle";
    this.wrongWay = false;
  }

  /**
   * Une image de progression.
   * @param s       avancement de la voiture sur la trajectoire (0..totalLength)
   * @param onTrack vraie quand la voiture reste près de la piste
   */
  update(dt: number, s: number, onTrack: boolean): void {
    if (this.phase === "idle" || this.phase === "finished") {
      this.previousS = s;
      return;
    }

    if (this.phase === "countdown") {
      this.countdown -= dt;
      const step = clamp(3 - Math.ceil(this.countdown), 0, 3);
      if (step !== this.countdownStep) {
        this.countdownStep = step;
        this.onEvent({ type: "countdown", label: COUNTDOWN_STEPS[step] });
      }
      this.previousS = s;
      if (this.countdown <= 0) {
        this.phase = "racing";
        this.countdownStep = -1;
        this.backwards = 0;
        this.forwards = 0;
        this.onEvent({ type: "start" });
      }
      return;
    }

    this.lapMs += dt * 1000;
    this.totalMs += dt * 1000;

    const previousS = this.previousS;
    const length = this.track.totalLength;

    // --- contresens : déplacement le long de la trajectoire ----------------
    let step = s - previousS;
    if (step > length * 0.5) step -= length;
    if (step < -length * 0.5) step += length;
    if (onTrack && Math.abs(step) < 12) {
      if (step < -0.05) {
        this.backwards += -step;
        this.forwards = Math.max(0, this.forwards - 0.25);
      } else if (step > 0.05) {
        this.forwards += step;
        this.backwards = Math.max(0, this.backwards - 0.25);
      }
      const wrong = this.backwards > 5 && this.backwards > this.forwards;
      if (wrong !== this.wrongWay) {
        this.wrongWay = wrong;
        this.onEvent({ type: "wrongway", active: wrong });
      }
    }
    this.previousS = s;

    // --- portique suivant ---------------------------------------------------
    const gate = this.gateS[this.nextGate];
    if (gate !== undefined && this.nextGate !== 0) {
      let ahead = gate - s;
      if (ahead < -length * 0.5) ahead += length;
      if (ahead > 0 && ahead < 13) {
        this.passed += 1;
        this.nextGate = this.passed + 1 < this.gateS.length ? this.passed + 1 : 0;
        this.onEvent({ type: "checkpoint", index: this.passed, total: this.checkpointTotal });
      }
    }

    // --- franchissement de la ligne d'arrivée ------------------------------
    const crossed = (previousS >= length - 25 && s < 25) || (previousS < length && s >= length);
    if (crossed && this.passed >= this.checkpointTotal) this.completeLap();
  }

  /** Cap conseillé juste devant la voiture. */
  headingHint(s: number): number {
    const length = this.track.totalLength;
    return this.track.headingAt((s + 14) % length);
  }

  private completeLap(): void {
    const lapTime = this.lapMs;
    this.lapTimes.push(lapTime);
    const best = this.bestLapMs === 0 || lapTime < this.bestLapMs;
    if (best) this.bestLapMs = lapTime;
    this.lapMs = 0;
    this.passed = 0;
    this.nextGate = 1;
    this.backwards = 0;
    this.forwards = 0;
    this.onEvent({ type: "lap", lap: this.lap, lapMs: lapTime, best });
    if (this.lap >= this.totalLaps) {
      this.phase = "finished";
      this.onEvent({
        type: "finish",
        totalMs: this.totalMs,
        bestLapMs: this.bestLapMs,
        lapTimes: [...this.lapTimes],
      });
    } else {
      this.lap += 1;
    }
  }
}
