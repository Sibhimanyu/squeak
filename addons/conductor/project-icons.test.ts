import { describe, expect, it, vi } from "vitest";

import { ProjectIcons, type RepositoryIcon } from "./project-icons.js";

const png = (text: string) => `data:image/png;base64,${Buffer.from(text).toString("base64")}`;

describe("ProjectIcons", () => {
  it("keeps a shrunk icon by repository name and ignores what is not a raster image", async () => {
    const rows: RepositoryIcon[] = [
      { name: "storefront", icon: png("big-storefront") },
      { name: "vector", icon: "data:image/svg+xml;base64,PHN2Zy8+" },
      { name: "broken", icon: "not a data uri" },
    ];
    const shrink = vi.fn(async (image: Buffer) => Buffer.from(`small:${image.toString()}`));
    const icons = new ProjectIcons(() => rows, shrink);
    expect(await icons.refresh()).toBe(true);
    expect(Object.keys(icons.current())).toEqual(["storefront"]);
    expect(Buffer.from(icons.current().storefront!, "base64").toString()).toBe("small:big-storefront");
  });

  it("shrinks only what changed, and says whether anything did", async () => {
    let rows: RepositoryIcon[] = [{ name: "a", icon: png("one") }];
    const shrink = vi.fn(async (image: Buffer) => image);
    const icons = new ProjectIcons(() => rows, shrink);
    expect(await icons.refresh()).toBe(true);
    expect(await icons.refresh()).toBe(false);
    expect(shrink).toHaveBeenCalledTimes(1);
    rows = [{ name: "a", icon: png("two") }];
    expect(await icons.refresh()).toBe(true);
    expect(shrink).toHaveBeenCalledTimes(2);
    rows = [];
    expect(await icons.refresh()).toBe(true);
    expect(icons.current()).toEqual({});
  });

  it("leaves an icon out when it cannot be shrunk or stays too big, and survives a failed read", async () => {
    const rows: RepositoryIcon[] = [
      { name: "fails", icon: png("x") },
      { name: "huge", icon: png("y") },
    ];
    const shrink = async (image: Buffer) => (image.toString() === "x" ? null : Buffer.alloc(30_000));
    const icons = new ProjectIcons(() => rows, shrink);
    await icons.refresh();
    expect(icons.current()).toEqual({});
    const broken = new ProjectIcons(() => {
      throw new Error("locked");
    }, shrink);
    expect(await broken.refresh()).toBe(false);
  });
});
