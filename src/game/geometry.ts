import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";

/**
 * Construction de toutes les géométries du jeu par le code : aucune ressource
 * externe. Les normales sont calculées face par face (rendu facetté « low
 * poly ») et la couleur est portée par chaque sommet, ce qui permet de regrouper
 * des centaines d'objets dans un seul mesh et de laisser la carte GPU.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Placement {
  position?: Vec3;
  rotationY?: number;
  /** Facteur d'échelle uniforme ou par axe. */
  scale?: number | Vec3;
}

/**
 * Constructeur de facettes. On empile des primitives (triangles, quads, boîtes,
 * cônes, prismes) puis on fabrique le mesh en une fois.
 */
export class FacetBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly colors: number[] = [];
  private readonly indices: number[] = [];

  private px = 0;
  private py = 0;
  private pz = 0;
  private cos = 1;
  private sin = 0;
  private sx = 1;
  private sy = 1;
  private sz = 1;

  /** Positionne/oriente/mise à l'échelle les primitives suivantes. */
  place(p: Placement | null): this {
    if (!p) {
      this.px = this.py = this.pz = 0;
      this.cos = 1;
      this.sin = 0;
      this.sx = this.sy = this.sz = 1;
      return this;
    }
    this.px = p.position?.x ?? 0;
    this.py = p.position?.y ?? 0;
    this.pz = p.position?.z ?? 0;
    const yaw = p.rotationY ?? 0;
    this.cos = Math.cos(yaw);
    this.sin = Math.sin(yaw);
    if (typeof p.scale === "number" || p.scale === undefined) {
      this.sx = this.sy = this.sz = typeof p.scale === "number" ? p.scale : 1;
    } else {
      this.sx = p.scale.x;
      this.sy = p.scale.y;
      this.sz = p.scale.z;
    }
    return this;
  }

  private map(v: Vec3): Vec3 {
    const x = v.x * this.sx;
    const y = v.y * this.sy;
    const z = v.z * this.sz;
    return {
      x: this.px + x * this.cos + z * this.sin,
      y: this.py + y,
      z: this.pz - x * this.sin + z * this.cos,
    };
  }

  /** Triangle avec sa propre normale. L'ordre direct définit la face visible. */
  tri(a: Vec3, b: Vec3, c: Vec3, color: Color3): this {
    const A = this.map(a);
    const B = this.map(b);
    const C = this.map(c);
    const base = this.positions.length / 3;
    const nx = (B.y - A.y) * (C.z - A.z) - (B.z - A.z) * (C.y - A.y);
    const ny = (B.z - A.z) * (C.x - A.x) - (B.x - A.x) * (C.z - A.z);
    const nz = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
    const len = Math.hypot(nx, ny, nz) || 1;
    const inv = 1 / len;
    for (const p of [A, B, C]) {
      this.positions.push(p.x, p.y, p.z);
      this.normals.push(nx * inv, ny * inv, nz * inv);
      this.colors.push(color.r, color.g, color.b, 1);
    }
    // Normale obtenue par le produit vectoriel « main droite », alors que Babylon
    // travaille en coordonnées gauches et traite les triangles parcourus dans le
    // sens horaire comme des faces avant. On émet donc l'ordre inverse : la face
    // visible redevient celle pointer par la normale, et un matériau simple face
    // (backFaceCulling = true) ne culle plus la géométrie.
    this.indices.push(base, base + 2, base + 1);
    return this;
  }

  quad(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, color: Color3): this {
    this.tri(p0, p1, p2, color);
    this.tri(p0, p2, p3, color);
    return this;
  }

  /** Quad vertical (panneau, plot de barrière, lamelle de portique), visible des deux côtés. */
  verticalQuad(bottom: Vec3, width: number, height: number, yaw: number, color: Color3): this {
    const tx = Math.cos(yaw + Math.PI / 2);
    const tz = Math.sin(yaw + Math.PI / 2);
    const hw = width / 2;
    const p0 = { x: bottom.x - tx * hw, y: bottom.y, z: bottom.z - tz * hw };
    const p1 = { x: bottom.x + tx * hw, y: bottom.y, z: bottom.z + tz * hw };
    const p2 = { x: p1.x, y: bottom.y + height, z: p1.z };
    const p3 = { x: p0.x, y: bottom.y + height, z: p0.z };
    this.quad(p0, p1, p2, p3, color);
    this.quad(p3, p2, p1, p0, color); // face arrière : lisibles dans les deux sens
    return this;
  }

  /**
   * Boîte facettée centrée sur le placement courant ; `x`/`y`/`z` optionnels
   * décalent la boîte dans le repère du placement.
   */
  box(size: { w: number; h: number; d: number; x?: number; y?: number; z?: number }, color: Color3): this {
    const hx = size.w / 2;
    const hy = size.h / 2;
    const hz = size.d / 2;
    const ox = size.x ?? 0;
    const oy = size.y ?? 0;
    const oz = size.z ?? 0;
    const v = (sx: number, sy: number, sz: number): Vec3 => ({ x: sx + ox, y: sy + oy, z: sz + oz });
    const light = color.scale(1.14);
    const dark = color.scale(0.74);
    this.quad(v(-hx, -hy, hz), v(hx, -hy, hz), v(hx, hy, hz), v(-hx, hy, hz), color);
    this.quad(v(hx, -hy, -hz), v(-hx, -hy, -hz), v(-hx, hy, -hz), v(hx, hy, -hz), color);
    this.quad(v(hx, -hy, hz), v(hx, -hy, -hz), v(hx, hy, -hz), v(hx, hy, hz), light);
    this.quad(v(-hx, -hy, -hz), v(-hx, -hy, hz), v(-hx, hy, hz), v(-hx, hy, -hz), light);
    this.quad(v(-hx, hy, hz), v(hx, hy, hz), v(hx, hy, -hz), v(-hx, hy, -hz), light.scale(1.05));
    this.quad(v(-hx, -hy, -hz), v(hx, -hy, -hz), v(hx, -hy, hz), v(-hx, -hy, hz), dark);
    return this;
  }

  /** Cône facetté : base en y = 0, sommet en y = height. */
  cone(opts: { radius: number; height: number; segments: number }, tipColor: Color3, baseColor: Color3): this {
    const { radius, height, segments } = opts;
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const lit = 0.84 + 0.3 * Math.max(0, Math.cos(a0 + Math.PI / 4));
      this.tri(
        { x: Math.cos(a0) * radius, y: 0, z: Math.sin(a0) * radius },
        { x: Math.cos(a1) * radius, y: 0, z: Math.sin(a1) * radius },
        { x: 0, y: height, z: 0 },
        Color3.Lerp(baseColor, tipColor, 0.55).scale(lit),
      );
    }
    return this;
  }

  /** Prisme à n côtés : base en y = 0, plafond en y = height. */
  prism(
    opts: { radius: number; height: number; segments: number; topRadius?: number },
    color: Color3,
  ): this {
    const { radius, height, segments } = opts;
    const topRadius = opts.topRadius ?? radius;
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const lit = 0.78 + 0.38 * Math.max(0, Math.cos(a0 - Math.PI / 5));
      const c = color.scale(lit);
      this.quad(
        { x: Math.cos(a0) * radius, y: 0, z: Math.sin(a0) * radius },
        { x: Math.cos(a1) * radius, y: 0, z: Math.sin(a1) * radius },
        { x: Math.cos(a1) * topRadius, y: height, z: Math.sin(a1) * topRadius },
        { x: Math.cos(a0) * topRadius, y: height, z: Math.sin(a0) * topRadius },
        c,
      );
      const top = color.scale(1.18);
      const bottom = color.scale(0.66);
      this.tri(
        { x: Math.cos(a0) * topRadius, y: height, z: Math.sin(a0) * topRadius },
        { x: Math.cos(a1) * topRadius, y: height, z: Math.sin(a1) * topRadius },
        { x: 0, y: height, z: 0 },
        top,
      );
      this.tri(
        { x: Math.cos(a1) * radius, y: 0, z: Math.sin(a1) * radius },
        { x: Math.cos(a0) * radius, y: 0, z: Math.sin(a0) * radius },
        { x: 0, y: 0, z: 0 },
        bottom,
      );
    }
    return this;
  }

  /** Pyramide à base carrée (toits, sommets). */
  pyramid(base: number, height: number, color: Color3): this {
    const h = base / 2;
    const corners = [
      { x: -h, y: 0, z: h },
      { x: h, y: 0, z: h },
      { x: h, y: 0, z: -h },
      { x: -h, y: 0, z: -h },
    ];
    const apex = { x: 0, y: height, z: 0 };
    for (let i = 0; i < 4; i++) {
      const lit = 0.8 + 0.34 * Math.max(0, Math.cos((i / 4) * Math.PI * 2 - Math.PI / 4));
      this.tri(corners[i], corners[(i + 1) % 4], apex, color.scale(lit));
    }
    return this;
  }

  get isEmpty(): boolean {
    return this.positions.length === 0;
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  /** Fabrique le mesh statique correspondant (normales plates, couleurs par sommet). */
  toMesh(scene: Scene, name: string): Mesh | null {
    if (this.isEmpty) return null;
    const mesh = new Mesh(name, scene);
    const vd = new VertexData();
    vd.positions = this.positions;
    vd.normals = this.normals;
    vd.colors = this.colors;
    vd.indices = this.indices;
    vd.applyToMesh(mesh);
    mesh.alwaysSelectAsActiveMesh = true;
    return mesh;
  }

}

/** Une rangée transversale d'une bande continue (points ordonnés de la gauche vers la droite). */
export interface BandRow {
  points: { p: Vec3; color: Color3 }[];
}

/**
 * Surface continue le long de rangées successives (chaussée, accotements,
 * talus, rails). Fermée, la dernière rangée rejoint la première.
 */
export function addBand(fb: FacetBuilder, rows: readonly BandRow[], closed = false): void {
  const rowCount = closed ? rows.length : rows.length - 1;
  for (let i = 0; i < rowCount; i++) {
    const next = (i + 1) % rows.length;
    const rowA = rows[i];
    const rowB = rows[next];
    const cols = Math.min(rowA.points.length, rowB.points.length) - 1;
    for (let j = 0; j < cols; j++) {
      const a = rowA.points[j];
      const b = rowA.points[j + 1];
      const c = rowB.points[j + 1];
      const d = rowB.points[j];
      const color = new Color3(
        (a.color.r + b.color.r + c.color.r + d.color.r) / 4,
        (a.color.g + b.color.g + c.color.g + d.color.g) / 4,
        (a.color.b + b.color.b + c.color.b + d.color.b) / 4,
      );
      fb.quad(a.p, b.p, c.p, d.p, color);
    }
  }
}
