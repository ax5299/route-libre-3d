import type { Vector3 } from "@babylonjs/core";
import type { Track } from "./track";

interface MapPoint {
  x: number;
  y: number;
}

/**
 * Plan du circuit en canvas 2D (coin haut droit du HUD) : tracé complet,
 * portion déjà parcourue en orange, pastilles des portiques, triangle rouge
 * de la voiture orienté. Rendu pixel déterministe, sans caméra 3D dédiée.
 */
export class MiniMap {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly path: MapPoint[] = [];
  private readonly gates: { p: MapPoint; major: boolean }[] = [];
  private start: MapPoint = { x: 0, y: 0 };
  private minX = 0;
  private minZ = 0;
  private spanX = 1;
  private spanZ = 1;
  private layoutW = 0;
  private layoutH = 0;
  private readonly trail: { x: number; z: number; t: number }[] = [];

  /** Oublie la trace (reprise sur la grille, nouvelle course). */
  reset(): void {
    this.trail.length = 0;
  }

  constructor(canvas: HTMLCanvasElement, track: Track) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D indisponible pour le plan.");
    this.ctx = ctx;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of track.samples) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    this.minX = minX;
    this.minZ = minZ;
    this.spanX = Math.max(1, maxX - minX);
    this.spanZ = Math.max(1, maxZ - minZ);
    const step = Math.max(1, Math.round(track.samples.length / 260));
    for (let i = 0; i < track.samples.length; i += step) {
      const s = track.samples[i];
      this.path.push({ x: s.x, y: s.z });
    }
    track.checkpoints.forEach((cp, index) => {
      if (index === 0) this.start = { x: cp.position.x, y: cp.position.z };
      else this.gates.push({ p: { x: cp.position.x, y: cp.position.z }, major: index % 4 === 0 });
    });
  }

  /** Reprojette les points pour une taille de canvas donnée. */
  private toMap(x: number, z: number, w: number, h: number): MapPoint {
    const pad = 12;
    const s = Math.min((w - pad * 2) / this.spanX, (h - pad * 2) / this.spanZ);
    const ox = (w - this.spanX * s) / 2;
    const oy = (h - this.spanZ * s) / 2;
    return { x: ox + (x - this.minX) * s, y: h - oy - (z - this.minZ) * s };
  }

  /** Dessine le plan ; `progress` = fraction du tour en cours (0…1). */
  update(carPos: Vector3, heading: number, progress: number, lap = 1, laps = 1): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = this.canvas.clientWidth || 320;
    const cssH = this.canvas.clientHeight || 180;
    const bw = Math.round(cssW * dpr);
    const bh = Math.round(cssH * dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    if (this.layoutW !== cssW || this.layoutH !== cssH) {
      this.layoutW = cssW;
      this.layoutH = cssH;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const pts: MapPoint[] = [];
    for (const p of this.path) pts.push(this.toMap(p.x, p.y, cssW, cssH));

    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    // tracé complet
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.strokeStyle = "rgba(150, 158, 172, 0.9)";
    ctx.lineWidth = 6;
    ctx.stroke();

    // trace récente : dernier passage de la voiture (≈ 5 s)
    const now = performance.now();
    const last = this.trail[this.trail.length - 1];
    if (!last || Math.hypot(carPos.x - last.x, carPos.z - last.z) > 2) {
      this.trail.push({ x: carPos.x, z: carPos.z, t: now });
    }
    while (this.trail.length && now - this.trail[0].t > 5000) this.trail.shift();
    if (this.trail.length > 1) {
      ctx.beginPath();
      this.trail.forEach((p, i) => {
        const q = this.toMap(p.x, p.z, cssW, cssH);
        if (i === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      });
      ctx.strokeStyle = "#ff6a1a";
      ctx.lineWidth = 6;
      ctx.stroke();
    }

    // portiques
    for (const gate of this.gates) {
      const p = this.toMap(gate.p.x, gate.p.y, cssW, cssH);
      ctx.beginPath();
      ctx.arc(p.x, p.y, gate.major ? 5.5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = "#39b4dc";
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = "rgba(6, 10, 16, 0.85)";
      ctx.stroke();
    }
    // ligne d'arrivée
    const sp = this.toMap(this.start.x, this.start.y, cssW, cssH);
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd23f";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.stroke();

    // voiture : triangle orienté (z monde vers le haut du plan)
    const cp = this.toMap(carPos.x, carPos.z, cssW, cssH);
    ctx.save();
    ctx.translate(cp.x, cp.y);
    ctx.rotate(-heading);
    ctx.beginPath();
    ctx.moveTo(8.5, 0);
    ctx.lineTo(-6, 5.4);
    ctx.lineTo(-6, -5.4);
    ctx.closePath();
    ctx.fillStyle = "#ff3b2f";
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
    ctx.stroke();
    ctx.restore();

    // progression chiffrée
    ctx.font = "600 11px ui-monospace, monospace";
    ctx.fillStyle = "rgba(226, 233, 243, 0.92)";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(
      `T${Math.round(Math.min(Math.max(lap, 1), laps))}/${laps} · ${Math.round(Math.min(Math.max(progress, 0), 1) * 100)} %`,
      8,
      cssH - 6,
    );
  }
}
