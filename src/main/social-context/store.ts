import * as fs from "fs";
import * as path from "path";
import type { SocialAtom, ValidatedSocialAtomOperation } from "./types";

interface SocialAtomFile {
  schemaVersion: 1;
  atoms: SocialAtom[];
}

export interface SocialAtomStore {
  listActive(conversationId: string, now?: number): SocialAtom[];
  getById(id: string): SocialAtom | undefined;
  applyOperations(
    conversationId: string,
    operations: readonly ValidatedSocialAtomOperation[],
    now?: number,
  ): void;
  replaceForTest(atoms: SocialAtom[]): void;
}

function isActive(atom: SocialAtom, now: number): boolean {
  return atom.status === "active"
    && (typeof atom.expiresAt !== "number" || atom.expiresAt > now);
}

export function createSocialAtomStore(filePath?: string): SocialAtomStore {
  let loaded = false;
  let atoms: SocialAtom[] = [];

  const load = (): void => {
    if (loaded) return;
    loaded = true;
    if (!filePath || !fs.existsSync(filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<SocialAtomFile>;
      atoms = Array.isArray(parsed.atoms) ? parsed.atoms : [];
    } catch {
      atoms = [];
    }
  };

  const save = (): void => {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    fs.writeFileSync(
      temporaryPath,
      JSON.stringify({ schemaVersion: 1, atoms } satisfies SocialAtomFile, null, 2),
      "utf8",
    );
    fs.copyFileSync(temporaryPath, filePath);
    fs.rmSync(temporaryPath);
  };

  return {
    listActive(conversationId, now = Date.now()) {
      load();
      return atoms.filter((atom) => atom.conversationId === conversationId && isActive(atom, now));
    },

    getById(id) {
      load();
      return atoms.find((atom) => atom.id === id);
    },

    applyOperations(conversationId, operations, now = Date.now()) {
      load();
      for (const operation of operations) {
        if (operation.operation === "resolve") {
          const target = atoms.find((atom) => (
            atom.id === operation.targetAtomId
            && atom.conversationId === conversationId
            && atom.type === "open_loop"
            && isActive(atom, now)
          ));
          if (!target) continue;
          target.status = "resolved";
          target.resolvedByTurnId = operation.evidenceTurnId;
          continue;
        }

        if (operation.atom.conversationId !== conversationId) continue;
        const duplicate = atoms.some((atom) => (
          atom.conversationId === conversationId
          && atom.type === operation.atom.type
          && atom.evidenceTurnId === operation.atom.evidenceTurnId
          && atom.content.trim() === operation.atom.content.trim()
        ));
        if (duplicate) continue;
        if (operation.operation === "supersede") {
          const target = atoms.find((atom) => (
            atom.id === operation.targetAtomId
            && atom.conversationId === conversationId
            && isActive(atom, now)
          ));
          if (!target) continue;
          target.status = "superseded";
          target.supersededByAtomId = operation.atom.id;
        }
        if (!atoms.some((atom) => atom.id === operation.atom.id)) {
          atoms.push(operation.atom);
        }
      }
      save();
    },

    replaceForTest(next) {
      loaded = true;
      atoms = [...next];
    },
  };
}
