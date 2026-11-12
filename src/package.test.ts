import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

// `npm ci` refuses a lockfile that disagrees with package.json. After changing
// the version or a devDependency, run next to package.json:
//   npm install --package-lock-only --ignore-scripts
describe("package-lock.json", () => {
  const pkg = read("package.json");
  const lock = read("package-lock.json");

  it("has the version of package.json", () => {
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
  });

  it("pins the devDependencies of package.json", () => {
    expect(lock.packages[""].devDependencies).toEqual(pkg.devDependencies);
    expect(lock.packages[""].dependencies).toEqual(pkg.dependencies);
  });
});
