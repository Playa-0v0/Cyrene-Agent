import { describe, expect, it } from "vitest";
import {
  deriveNeteaseViewState,
  type MusicStatusSnapshot,
} from "../../shared/music-view-state";
import type {
  LoginFlowState,
  MusicBackendState,
  MusicAccountState,
  MusicPlayerState,
} from "../../shared/music-types";

interface Snapshot {
  backend: MusicBackendState;
  account: MusicAccountState;
  player: MusicPlayerState;
  flow: LoginFlowState;
}

function snap(overrides: Partial<Snapshot>): MusicStatusSnapshot {
  return {
    backend: "ready",
    account: "signed_in",
    player: "available",
    flow: "idle",
    ...overrides,
  };
}

describe("deriveNeteaseViewState", () => {
  it("(starting, _, _) -> backend_starting", () => {
    expect(deriveNeteaseViewState(snap({ backend: "starting" }))).toBe("backend_starting");
  });

  it("(failed, _, _) -> backend_error", () => {
    expect(
      deriveNeteaseViewState(snap({ backend: "failed", account: "signed_out", flow: "idle" })),
    ).toBe("backend_error");
  });

  it("(incompatible, _, _) -> backend_error", () => {
    expect(
      deriveNeteaseViewState(
        snap({ backend: "incompatible", account: "signed_out", flow: "idle" }),
      ),
    ).toBe("backend_error");
  });

  it("(ready, signed_out, _, idle) -> signed_out", () => {
    expect(
      deriveNeteaseViewState(snap({ backend: "ready", account: "signed_out", flow: "idle" })),
    ).toBe("signed_out");
  });

  it("(ready, signed_out, _, waiting_scan) -> waiting_scan", () => {
    expect(
      deriveNeteaseViewState(
        snap({ backend: "ready", account: "signed_out", flow: "waiting_scan" }),
      ),
    ).toBe("waiting_scan");
  });

  it("(ready, signed_out, _, waiting_confirm) -> waiting_confirm", () => {
    expect(
      deriveNeteaseViewState(
        snap({ backend: "ready", account: "signed_out", flow: "waiting_confirm" }),
      ),
    ).toBe("waiting_confirm");
  });

  it("(ready, signed_out, _, expired) -> login_expired", () => {
    expect(
      deriveNeteaseViewState(
        snap({ backend: "ready", account: "signed_out", flow: "expired" }),
      ),
    ).toBe("login_expired");
  });

  it("(ready, signed_out, _, failed) -> login_failed", () => {
    expect(
      deriveNeteaseViewState(
        snap({ backend: "ready", account: "signed_out", flow: "failed" }),
      ),
    ).toBe("login_failed");
  });

  it("(ready, signed_in, _, creating_qr) -> creating_qr", () => {
    expect(
      deriveNeteaseViewState(snap({ backend: "ready", account: "signed_in", flow: "creating_qr" })),
    ).toBe("creating_qr");
  });

  it("(ready, signed_in, _, waiting_scan) -> waiting_scan", () => {
    expect(
      deriveNeteaseViewState(snap({ backend: "ready", account: "signed_in", flow: "waiting_scan" })),
    ).toBe("waiting_scan");
  });

  it("(ready, signed_in, _, waiting_confirm) -> waiting_confirm", () => {
    expect(
      deriveNeteaseViewState(
        snap({ backend: "ready", account: "signed_in", flow: "waiting_confirm" }),
      ),
    ).toBe("waiting_confirm");
  });

  it("(ready, signed_in, _, expired) -> login_expired", () => {
    expect(
      deriveNeteaseViewState(snap({ backend: "ready", account: "signed_in", flow: "expired" })),
    ).toBe("login_expired");
  });

  it("(ready, signed_in, _, failed) -> login_failed", () => {
    expect(
      deriveNeteaseViewState(snap({ backend: "ready", account: "signed_in", flow: "failed" })),
    ).toBe("login_failed");
  });

  it("(ready, signed_in, _, authorized, available) -> connected", () => {
    expect(
      deriveNeteaseViewState(
        snap({ backend: "ready", account: "signed_in", player: "available", flow: "authorized" }),
      ),
    ).toBe("connected");
  });

  it("(ready, signed_in, _, authorized, unavailable) -> connected_without_client", () => {
    expect(
      deriveNeteaseViewState(
        snap({ backend: "ready", account: "signed_in", player: "unavailable", flow: "authorized" }),
      ),
    ).toBe("connected_without_client");
  });

  it("(ready, signed_in, _, authorized, unknown) -> connected_without_client (signed-in but mpv initializing)", () => {
    expect(
      deriveNeteaseViewState(
        snap({ backend: "ready", account: "signed_in", player: "unknown", flow: "authorized" }),
      ),
    ).toBe("connected_without_client");
  });

  it("(ready, unknown, _, _) -> backend_starting (account not initialized)", () => {
    expect(
      deriveNeteaseViewState(
        snap({ backend: "ready", account: "unknown", player: "unknown", flow: "idle" }),
      ),
    ).toBe("backend_starting");
  });
});
