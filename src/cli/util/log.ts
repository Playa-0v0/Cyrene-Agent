/**
 * Thin wrappers over process.stdout / process.stderr.
 *
 * We avoid console.log because on Windows legacy code pages (cp936, cp950)
 * it applies an encoding transform that can mangle box-drawing characters
 * in cmd.exe. Writing directly to the stream with a trailing \n is safer.
 */
import process from "node:process";

export function out(s: string): void {
  process.stdout.write(s);
}

export function err(s: string): void {
  process.stderr.write(s);
}

export function outLine(s = ""): void {
  process.stdout.write(s + "\n");
}

export function errLine(s = ""): void {
  process.stderr.write(s + "\n");
}
