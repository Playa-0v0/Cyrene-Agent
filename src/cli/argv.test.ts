import { describe, expect, it } from "vitest";
import { parseArgv } from "./argv";

describe("parseArgv", () => {
  it("returns default for empty argv", () => {
    expect(parseArgv([])).toEqual({ kind: "default" });
  });

  it("returns hello", () => {
    expect(parseArgv(["hello"])).toEqual({ kind: "hello" });
  });

  it("returns about", () => {
    expect(parseArgv(["about"])).toEqual({ kind: "about" });
  });

  it("returns version for the version subcommand", () => {
    expect(parseArgv(["version"])).toEqual({ kind: "version" });
  });

  it("returns help for the help subcommand", () => {
    expect(parseArgv(["help"])).toEqual({ kind: "help" });
  });

  it("returns run", () => {
    expect(parseArgv(["run"])).toEqual({ kind: "run" });
  });

  it("maps --help and -h to help, regardless of position", () => {
    expect(parseArgv(["--help"])).toEqual({ kind: "help" });
    expect(parseArgv(["-h"])).toEqual({ kind: "help" });
    expect(parseArgv(["hello", "--help"])).toEqual({ kind: "help" });
    expect(parseArgv(["-h", "run"])).toEqual({ kind: "help" });
  });

  it("maps --version and -v to version, regardless of position", () => {
    expect(parseArgv(["--version"])).toEqual({ kind: "version" });
    expect(parseArgv(["-v"])).toEqual({ kind: "version" });
    expect(parseArgv(["hello", "-v"])).toEqual({ kind: "version" });
  });

  it("maps doctor/init/update to placeholder", () => {
    expect(parseArgv(["doctor"])).toEqual({ kind: "placeholder", name: "doctor" });
    expect(parseArgv(["init"])).toEqual({ kind: "placeholder", name: "init" });
    expect(parseArgv(["update"])).toEqual({ kind: "placeholder", name: "update" });
  });

  it("returns unknown for unrecognised subcommands", () => {
    expect(parseArgv(["bogus"])).toEqual({ kind: "unknown", name: "bogus" });
  });

  it("returns unknown for a flag that is not -h/-v", () => {
    expect(parseArgv(["--foo"])).toEqual({ kind: "unknown", name: "--foo" });
  });
});
