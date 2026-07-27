import { describe, expect, it } from "vitest";
import { deriveRoomAssignment, mapGuestInputToPlayerTwo, type RoomPeer } from "./multiplayer-room";

const peer = (clientId: string, joinedAt: number, choice: RoomPeer["choice"]): RoomPeer => ({
  clientId, joinedAt, choice, displayName: clientId,
});

describe("Ropebound multiplayer room assignment", () => {
  it("keeps the oldest non-solo participant as host and assigns one willing guest", () => {
    const room = deriveRoomAssignment([
      peer("solo", 1, "solo"),
      peer("host", 2, "host"),
      peer("guest", 3, "join"),
      peer("waiting", 4, "waiting"),
    ]);
    expect(room.host?.clientId).toBe("host");
    expect(room.guest?.clientId).toBe("guest");
    expect(room.waiting.map((entry) => entry.clientId)).toEqual(["waiting"]);
  });

  it("maps familiar first-player keys onto the original second-player controls", () => {
    expect(mapGuestInputToPlayerTwo("KeyA")).toBe("ArrowLeft");
    expect(mapGuestInputToPlayerTwo("Space")).toBe("ArrowUp");
    expect(mapGuestInputToPlayerTwo("KeyF")).toBe("Slash");
    expect(mapGuestInputToPlayerTwo("KeyE")).toBe("Enter");
    expect(mapGuestInputToPlayerTwo("Escape")).toBeNull();
  });
});
