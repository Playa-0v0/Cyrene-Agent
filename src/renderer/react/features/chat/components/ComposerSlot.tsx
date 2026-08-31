import type { ReactNode } from "react";
import { AskUserPanel, PermissionPanel } from "./InteractionPanel";
import { resolveComposerSlot, type ComposerInteraction } from "./run-presentation";
import "./RunExperience.css";

export function ComposerSlot({
  composer,
  interaction,
  interactionBusy = false,
  onAnswer,
  onIgnore,
  onPermissionDecision,
}: {
  composer: ReactNode;
  interaction?: ComposerInteraction;
  interactionBusy?: boolean;
  onAnswer?: (interactionId: string, answer: unknown) => void;
  onIgnore?: (interactionId: string) => void;
  onPermissionDecision?: (interactionId: string, allowed: boolean) => void;
}) {
  const slot = resolveComposerSlot(interaction);

  return (
    <div className={`cy-composer-slot is-${slot}`}>
      <div className="cy-composer-slot__composer" aria-hidden={interaction ? true : undefined}>
        {composer}
      </div>
      {interaction?.kind === "ask" && (
        <div className="cy-composer-slot__interaction">
          <AskUserPanel
            interaction={interaction}
            disabled={interactionBusy}
            onAnswer={(answer) => onAnswer?.(interaction.id, answer)}
            onIgnore={() => onIgnore?.(interaction.id)}
          />
        </div>
      )}
      {interaction?.kind === "permission" && (
        <div className="cy-composer-slot__interaction">
          <PermissionPanel
            interaction={interaction}
            disabled={interactionBusy}
            onDecision={(allowed) => onPermissionDecision?.(interaction.id, allowed)}
          />
        </div>
      )}
    </div>
  );
}
