import "../ui/base.css";
import "./style.css";
import "../ui/theme";
import { resolveAsset } from "../../shared/renderer-base";

type StickerItem = {
  id: string;
  src: string;
  enabled: boolean;
  builtIn?: boolean;
  description?: string;
};

interface StickerManagerApi {
  minimize: () => void;
  close: () => void;
  getConfig: () => Promise<StickerItem[]>;
  setEnabled: (id: string, enabled: boolean) => Promise<StickerItem[]>;
}

declare global {
  interface Window {
    stickerManager?: StickerManagerApi;
  }
}

const grid = document.getElementById("sticker-grid") as HTMLElement;
const minBtn = document.getElementById("min-btn") as HTMLButtonElement;
const closeBtn = document.getElementById("close-btn") as HTMLButtonElement;

function render(items: StickerItem[]): void {
  grid.replaceChildren();

  for (const item of items) {
    const card = document.createElement("article");
    card.className = "sticker-card";
    card.classList.toggle("is-disabled", !item.enabled);

    const img = document.createElement("img");
    img.src = item.src.startsWith("/stickers/") ? resolveAsset(item.src) : item.src;
    img.alt = item.description || "";
    img.draggable = false;

    const label = document.createElement("label");
    label.className = "mini-switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = item.enabled;
    const track = document.createElement("span");
    track.className = "mini-switch__track";
    const thumb = document.createElement("span");
    thumb.className = "mini-switch__thumb";
    track.appendChild(thumb);
    label.append(input, track);

    input.addEventListener("change", async () => {
      const next = await window.stickerManager?.setEnabled(item.id, input.checked);
      if (next) render(next);
    });

    card.append(img, label);
    grid.appendChild(card);
  }
}

async function init(): Promise<void> {
  const items = await window.stickerManager?.getConfig();
  render(items ?? []);
}

minBtn.addEventListener("click", () => window.stickerManager?.minimize());
closeBtn.addEventListener("click", () => window.stickerManager?.close());
void init();
