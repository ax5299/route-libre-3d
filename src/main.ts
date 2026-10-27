import "./styles.css";
import { boot } from "./game/app";

/**
 * Point d'entrée de la page : récupère le canevas, démarre le jeu et affiche
 * un message lisible si l'environnement ne permet pas de lancer WebGL.
 */
function start(): void {
  const canvas = document.getElementById("renderCanvas");
  const bootLabel = document.getElementById("boot");
  if (!(canvas instanceof HTMLCanvasElement)) {
    if (bootLabel) bootLabel.textContent = "Canevas introuvable : la page est incomplète.";
    return;
  }
  try {
    const game = boot(canvas);
    // Pratique pour debugger depuis la console du navigateur.
    (window as unknown as { game: unknown }).game = game;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (bootLabel) bootLabel.textContent = `Impossible de démarrer : ${reason}`;
    console.error(error);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
