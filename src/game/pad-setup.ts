import { InputManager } from "./input";
import { PAD_ACTIONS, padKey, readBinding, type PadBinding, type PadProfile } from "./pad-profile";

const LABELS = ["Tourner à gauche", "Tourner à droite", "Accélérer", "Freiner / reculer", "Frein à main", "Changer de caméra", "Replacer la voiture", "Pause", "Valider un menu", "Retour"];
const INSTRUCTIONS = [
  "Pousse le joystick gauche complètement à gauche, ou appuie sur la direction gauche.",
  "Pousse le même joystick complètement à droite, ou appuie sur la direction droite.",
  "Appuie à fond sur la gâchette ou le bouton choisi pour accélérer.",
  "Appuie à fond sur la gâchette ou le bouton choisi pour freiner et reculer.",
];

/** L'assistant n'applique le brouillon qu'après une sauvegarde explicite. */
export class PadSetup {
  private readonly select = document.getElementById("pad-select") as HTMLSelectElement;
  private readonly status = document.getElementById("pad-status")!;
  private readonly live = document.getElementById("pad-live")!;
  private readonly instruction = document.getElementById("pad-instruction")!;
  private readonly summary = document.getElementById("pad-summary")!;
  private readonly start = document.getElementById("pad-start") as HTMLButtonElement;
  private readonly arm = document.getElementById("pad-arm") as HTMLButtonElement;
  private readonly skip = document.getElementById("pad-skip") as HTMLButtonElement;
  private readonly save = document.getElementById("pad-save") as HTMLButtonElement;
  private readonly reset = document.getElementById("pad-reset") as HTMLButtonElement;
  private cleanup: (() => void)[] = [];
  private step = -1;
  private draft = {} as PadProfile;
  private identity = "";
  private baseline: { axes: number[]; buttons: number[] } | null = null;
  private armedAt = 0;
  private wasVisible = false;
  private notice = "";

  constructor(private readonly input: InputManager) {
    const listen = (element: HTMLElement, event: string, handler: () => void): void => {
      element.addEventListener(event, handler);
      this.cleanup.push(() => element.removeEventListener(event, handler));
    };
    listen(this.select, "change", () => {
      this.input.selectPad(Number(this.select.value));
      this.cancel();
    });
    listen(this.start, "click", () => {
      const pad = this.input.currentPad;
      if (!pad) return;
      this.identity = padKey(pad);
      this.draft = Object.fromEntries(PAD_ACTIONS.map(action => [action, null])) as PadProfile;
      this.step = 0;
      this.baseline = null;
      this.notice = "";
      this.showStep();
    });
    listen(this.arm, "click", () => {
      const pad = this.input.currentPad;
      if (!pad || this.step < 0 || this.step >= PAD_ACTIONS.length) return;
      this.baseline = { axes: [...pad.axes], buttons: pad.buttons.map(b => b.value) };
      this.armedAt = performance.now();
      this.instruction.textContent = INSTRUCTIONS[this.step] ?? `Appuie sur la commande choisie : ${LABELS[this.step]}.`;
      this.arm.disabled = true;
    });
    listen(this.skip, "click", () => {
      if (this.step < 4 || this.step >= PAD_ACTIONS.length) return;
      this.draft[PAD_ACTIONS[this.step]] = null;
      this.advance();
    });
    listen(this.save, "click", () => {
      const pad = this.input.currentPad;
      if (!pad || padKey(pad) !== this.identity || this.step !== PAD_ACTIONS.length) return;
      const stored = this.input.profiles.save(pad, this.draft);
      this.cancel();
      this.notice = stored ? "Configuration enregistrée pour cette manette dans ce navigateur." : "Configuration appliquée pour cette session. Le navigateur bloque la sauvegarde.";
    });
    listen(this.reset, "click", () => {
      const pad = this.input.currentPad;
      if (!pad) return;
      const stored = this.input.profiles.reset(pad);
      this.cancel();
      this.notice = stored ? "Configuration automatique rétablie." : "Configuration automatique rétablie pour cette session. Le stockage est inaccessible.";
    });
  }

  private cancel(): void {
    this.step = -1;
    this.baseline = null;
    this.notice = "";
    this.summary.textContent = "";
    this.showStep();
  }

  private showStep(): void {
    const active = this.step >= 0 && this.step < PAD_ACTIONS.length;
    this.arm.hidden = !active;
    this.arm.disabled = false;
    this.skip.hidden = !active || this.step < 4;
    this.save.hidden = this.step !== PAD_ACTIONS.length;
    this.start.textContent = this.step < 0 ? "Configurer ma manette" : "Recommencer la configuration";
    this.instruction.textContent = active
      ? `Étape ${this.step + 1}/${PAD_ACTIONS.length} — ${LABELS[this.step]}. Relâche tous les boutons, centre les joysticks, puis clique sur « Détecter la commande ».`
      : this.step === PAD_ACTIONS.length ? "Relâche les commandes, vérifie les associations ci-dessous puis enregistre. Les commandes ignorées restent disponibles au clavier."
      : "Les manettes au format standard fonctionnent automatiquement. Pour une manette générique, configure les commandes avec la souris. Les quatre premières étapes sont obligatoires.";
  }

  private advance(): void {
    this.step++;
    this.baseline = null;
    this.summary.textContent = PAD_ACTIONS.slice(0, this.step).map((action, i) => {
      const b = this.draft[action];
      return `${LABELS[i]} : ${b ? `${b.kind === "axis" ? "axe" : "bouton"} ${b.index}${b.kind === "axis" ? (b.end > b.rest ? " +" : " −") : ""}` : "clavier uniquement"}`;
    }).join("\n");
    this.showStep();
  }

  update(visible: boolean): void {
    if (!visible) {
      if (this.wasVisible) this.cancel();
      this.wasVisible = false;
      return;
    }
    if (!this.wasVisible) this.showStep();
    this.wasVisible = true;
    const pads = Array.from(navigator.getGamepads?.() ?? []).filter((p): p is Gamepad => !!p);
    const options = pads.map(p => `${p.index}:${padKey(p)}`).join(";");
    if (this.select.dataset.pads !== options) {
      this.select.replaceChildren(...pads.map(p => new Option(p.id, String(p.index))));
      this.select.dataset.pads = options;
    }
    const pad = this.input.currentPad;
    this.start.disabled = !pad;
    this.reset.disabled = !pad;
    if (!pad || (this.step >= 0 && padKey(pad) !== this.identity)) {
      if (this.step >= 0) { this.cancel(); this.notice = "Manette débranchée ou changée : configuration annulée, ancien profil conservé."; }
    }
    if (!pad) {
      this.status.textContent = this.notice || "Aucune manette visible. Branche-la, clique dans cette page puis appuie sur un bouton de la manette.";
      this.live.textContent = "En attente de la manette…";
      return;
    }
    this.select.value = String(pad.index);
    this.status.textContent = this.notice || `${pad.id} — ${pad.mapping === "standard" ? "format standard (Xbox compatible)" : "format générique"} — ${this.input.profiles.get(pad) ? "profil personnalisé" : "configuration automatique"}`;
    const profile = this.input.profiles.get(pad);
    this.live.textContent = `Axes reçus : ${pad.axes.map((v, i) => `${i}: ${v.toFixed(2)}`).join(" · ") || "aucun"}\nBoutons actifs : ${pad.buttons.map((b, i) => b.value > 0.05 ? `${i}: ${b.value.toFixed(2)}` : "").filter(Boolean).join(" · ") || "aucun"}`
      + (profile ? `\nProfil actif — gauche ${readBinding(pad, profile.left).toFixed(2)} · droite ${readBinding(pad, profile.right).toFixed(2)} · gaz ${readBinding(pad, profile.throttle).toFixed(2)} · frein ${readBinding(pad, profile.brake).toFixed(2)}` : "");
    if (!this.baseline) return;
    let found: PadBinding | null = null;
    for (let i = 0; i < pad.buttons.length; i++) {
      const rest = this.baseline.buttons[i] ?? 0;
      if (pad.buttons[i].value - rest > 0.55) { found = { kind: "button", index: i, rest, end: 1 }; break; }
    }
    if (!found) {
      let largest = 0.55;
      for (let i = 0; i < pad.axes.length; i++) {
        const rest = this.baseline.axes[i] ?? 0;
        const delta = pad.axes[i] - rest;
        if (Number.isFinite(rest) && Math.abs(rest) <= 1 && Math.abs(delta) > largest && Math.abs(pad.axes[i]) <= 1) {
          largest = Math.abs(delta);
          found = { kind: "axis", index: i, rest, end: delta > 0 ? 1 : -1 };
        }
      }
    }
    if (found) {
      const duplicate = PAD_ACTIONS.slice(0, this.step).some(action => {
        const b = this.draft[action];
        return b && b.kind === found.kind && b.index === found.index && Math.sign(b.end - b.rest) === Math.sign(found.end - found.rest);
      });
      if (duplicate) {
        this.baseline = null;
        this.arm.disabled = false;
        this.instruction.textContent = "Cette commande est déjà utilisée. Relâche tout, clique sur Détecter puis utilise une autre commande (ou le sens opposé du même axe).";
      } else {
        this.draft[PAD_ACTIONS[this.step]] = found;
        this.advance();
      }
    } else if (performance.now() - this.armedAt > 12000) {
      this.baseline = null;
      this.arm.disabled = false;
      this.instruction.textContent = "Aucun mouvement reçu. Vérifie le bouton MODE / ANALOG ou le mode XInput de la manette. Tu peux aussi utiliser la croix ou des boutons pour tourner. Relâche tout puis réessaie.";
    }
  }

  dispose(): void { for (const off of this.cleanup) off(); this.cleanup = []; }
}

