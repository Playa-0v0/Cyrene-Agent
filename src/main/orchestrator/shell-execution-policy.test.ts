import { describe, expect, it } from "vitest";
import { classifyShellEffect, isCatastrophicCommand } from "./shell-execution-policy";

describe("isCatastrophicCommand", () => {
  it("rejects format / shutdown / dd regardless of path or .exe suffix", () => {
    expect(isCatastrophicCommand("format C:")).toBe(true);
    expect(isCatastrophicCommand("C:\\Windows\\System32\\shutdown.exe /s /t 0")).toBe(true);
    expect(isCatastrophicCommand("dd if=/dev/zero of=/dev/sda")).toBe(true);
    expect(isCatastrophicCommand("mkfs.ext4 /dev/sda1")).toBe(true);
    expect(isCatastrophicCommand("fdisk /dev/sda")).toBe(true);
    expect(isCatastrophicCommand("reboot")).toBe(true);
    expect(isCatastrophicCommand("halt")).toBe(true);
    expect(isCatastrophicCommand("poweroff")).toBe(true);
  });

  it("does not flag ordinary commands as catastrophic", () => {
    expect(isCatastrophicCommand("git status")).toBe(false);
    expect(isCatastrophicCommand("npm install")).toBe(false);
    expect(isCatastrophicCommand("rm file.txt")).toBe(false);
    expect(isCatastrophicCommand("echo hello")).toBe(false);
    expect(isCatastrophicCommand("")).toBe(false);
    expect(isCatastrophicCommand("   ")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isCatastrophicCommand("FORMAT C:")).toBe(true);
    expect(isCatastrophicCommand("Shutdown /r")).toBe(true);
  });
});

describe("classifyShellEffect", () => {
  describe("shell operators force write", () => {
    it("classifies redirect as write", () => {
      expect(classifyShellEffect("echo hello > out.txt")).toBe("write");
      expect(classifyShellEffect("echo hello >> out.txt")).toBe("write");
      expect(classifyShellEffect("sort < in.txt")).toBe("write");
    });

    it("classifies pipe as write", () => {
      expect(classifyShellEffect("git status | findstr TODO")).toBe("write");
    });

    it("classifies command chaining as write", () => {
      expect(classifyShellEffect("cd src && dir")).toBe("write");
      expect(classifyShellEffect("git add . || echo failed")).toBe("write");
      expect(classifyShellEffect("echo a & echo b")).toBe("write");
      expect(classifyShellEffect("echo a ; echo b")).toBe("write");
    });
  });

  describe("read-only commands", () => {
    it("classifies common read-only first words", () => {
      expect(classifyShellEffect("ls -la")).toBe("read");
      expect(classifyShellEffect("cat README.md")).toBe("read");
      expect(classifyShellEffect("echo hello")).toBe("read");
      expect(classifyShellEffect("pwd")).toBe("read");
      expect(classifyShellEffect("dir")).toBe("read");
      expect(classifyShellEffect("tree /F")).toBe("read");
      expect(classifyShellEffect("rg TODO")).toBe("read");
    });

    it("classifies git read subcommands", () => {
      expect(classifyShellEffect("git status")).toBe("read");
      expect(classifyShellEffect("git diff")).toBe("read");
      expect(classifyShellEffect("git log --oneline -5")).toBe("read");
      expect(classifyShellEffect("git show HEAD")).toBe("read");
      expect(classifyShellEffect("git branch")).toBe("read");
      expect(classifyShellEffect("git remote -v")).toBe("read");
      expect(classifyShellEffect("git stash list")).toBe("read");
    });

    it("classifies npm read subcommands", () => {
      expect(classifyShellEffect("npm list")).toBe("read");
      expect(classifyShellEffect("npm ls --depth=0")).toBe("read");
      expect(classifyShellEffect("npm view react")).toBe("read");
      expect(classifyShellEffect("npm outdated")).toBe("read");
    });

    it("classifies find without write flags as read", () => {
      expect(classifyShellEffect("find . -name *.ts")).toBe("read");
    });
  });

  describe("write commands", () => {
    it("classifies git write subcommands", () => {
      expect(classifyShellEffect("git commit -m msg")).toBe("write");
      expect(classifyShellEffect("git push")).toBe("write");
      expect(classifyShellEffect("git checkout main")).toBe("write");
      expect(classifyShellEffect("git reset --hard")).toBe("write");
      expect(classifyShellEffect("git add .")).toBe("write");
      expect(classifyShellEffect("git branch -D feature")).toBe("write");
      expect(classifyShellEffect("git stash push")).toBe("write");
      expect(classifyShellEffect("git remote add origin url")).toBe("write");
    });

    it("classifies npm write subcommands", () => {
      expect(classifyShellEffect("npm install")).toBe("write");
      expect(classifyShellEffect("npm i lodash")).toBe("write");
      expect(classifyShellEffect("npm add react")).toBe("write");
      expect(classifyShellEffect("npm run build")).toBe("write");
      expect(classifyShellEffect("npm publish")).toBe("write");
    });

    it("classifies find with write flags as write", () => {
      expect(classifyShellEffect("find . -name *.log -delete")).toBe("write");
      expect(classifyShellEffect("find . -exec rm {} ;")).toBe("write");
    });
  });

  describe("unknown commands", () => {
    it("classifies dynamic-script tools as unknown", () => {
      expect(classifyShellEffect("node script.js")).toBe("unknown");
      expect(classifyShellEffect("python build.py")).toBe("unknown");
      expect(classifyShellEffect("cargo build")).toBe("unknown");
      expect(classifyShellEffect("tsc --noEmit")).toBe("unknown");
    });

    it("classifies unrecognized commands as unknown", () => {
      expect(classifyShellEffect("some-weird-tool --flag")).toBe("unknown");
      expect(classifyShellEffect("")).toBe("unknown");
      expect(classifyShellEffect("   ")).toBe("unknown");
    });
  });

  describe("path and case handling", () => {
    it("resolves basename from absolute paths (no spaces)", () => {
      expect(classifyShellEffect("C:\\Tools\\git.exe status")).toBe("read");
      expect(classifyShellEffect("/usr/bin/git log")).toBe("read");
    });

    it("is case-insensitive on first token", () => {
      expect(classifyShellEffect("GIT STATUS")).toBe("read");
      expect(classifyShellEffect("NPM Install")).toBe("write");
    });
  });
});
