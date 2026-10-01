import { expect, type Locator, type Page, test } from "@playwright/test";
import type { WorkspaceDetail, WorkspaceSnapshot, WorkspacesResponse } from "../src/lib/types";
import { face, fitPatch, node, stage, unstage } from "./canvas";

function snapshot(): WorkspaceSnapshot {
  return {
    version: 4,
    graph: {
      nodes: [
        node("speaker", { kind: "speaker" }, { x: 0, y: 0, w: 280, h: 180 }),
        node("scope", { kind: "scope" }, { x: 340, y: 0, w: 560, h: 340 }),
      ],
      edges: [],
    },
  };
}

async function workspace(page: Page): Promise<WorkspaceDetail> {
  const listed: WorkspacesResponse = await page.request
    .get("/api/workspaces")
    .then((r) => r.json());
  return page.request.get(`/api/workspaces/${listed.active}`).then((r) => r.json());
}

async function stored(page: Page): Promise<WorkspaceSnapshot> {
  return (await workspace(page)).snapshot;
}

async function label(page: Page): Promise<string | undefined> {
  return (await stored(page)).graph.nodes.find((item) => item.id === "speaker")?.label ?? undefined;
}

function title(shell: Locator, name = "Speaker"): Locator {
  return shell.getByRole("button", { name: `Rename ${name}`, exact: true });
}

async function edit(shell: Locator, name = "Speaker"): Promise<Locator> {
  await title(shell, name).dblclick();
  const input = shell.getByRole("textbox", { name: "Node name", exact: true });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(name);
  expect(
    await input.evaluate((element: HTMLInputElement) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual([0, name.length]);
  return input;
}

test.beforeEach(async ({ page }) => {
  await stage(page, "Node names", snapshot());
  await fitPatch(page);
});

test.afterEach(({ request }) => unstage(request));

test("saves a trimmed name, reloads it and supports undo and redo", async ({ page }) => {
  const speaker = face(page, "speaker");
  const before = (await stored(page)).graph;
  await expect(title(speaker)).toHaveAttribute("title", "Double-click to rename");
  const input = await edit(speaker);
  await input.fill("  Desk audio  ");
  await input.press("Enter");
  await expect(title(speaker, "Desk audio")).toBeVisible();
  await expect(
    speaker.getByRole("button", { name: "Remove Desk audio", exact: true }),
  ).toBeVisible();
  await expect.poll(() => label(page)).toBe("Desk audio");
  expect((await stored(page)).graph).toEqual({
    ...before,
    nodes: before.nodes.map((item) =>
      item.id === "speaker" ? { ...item, label: "Desk audio" } : item,
    ),
  });

  await page.reload();
  await expect(title(speaker, "Desk audio")).toBeVisible();
  await page.getByRole("button", { name: /^undo/i }).click();
  await expect(title(speaker)).toBeVisible();
  await expect.poll(() => label(page)).toBeUndefined();
  await page.getByRole("button", { name: /^redo/i }).click();
  await expect(title(speaker, "Desk audio")).toBeVisible();
  await expect.poll(() => label(page)).toBe("Desk audio");
});

test("Escape cancels without saving when focus later moves", async ({ page }) => {
  const speaker = face(page, "speaker");
  const before = await workspace(page);
  let input = await edit(speaker);
  await input.press("Enter");
  await expect(input).toHaveCount(0);
  await page.reload();
  const unchanged = await workspace(page);
  expect(unchanged.revision).toBe(before.revision);
  expect(unchanged.history).toEqual(before.history);
  expect(unchanged.snapshot).toEqual(before.snapshot);

  input = await edit(speaker);
  await input.fill("Discard this");
  await input.press("Escape");
  await expect(input).toHaveCount(0);
  await title(face(page, "scope"), "Scope").click();
  await expect(title(speaker)).toBeVisible();
  await expect.poll(() => label(page)).toBeUndefined();
  await page.reload();
  await expect(title(speaker)).toBeVisible();
});

test("drags the title and selects name text without moving the node", async ({ page }) => {
  const speaker = face(page, "speaker");
  const position = async () =>
    (await stored(page)).graph.nodes.find((item) => item.id === "speaker")?.position;
  const before = await position();
  const handle = await title(speaker).boundingBox();
  if (handle === null || before === undefined) {
    throw new Error("a speaker title to drag");
  }
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 40, { steps: 12 });
  await page.mouse.up();
  await expect.poll(position).not.toEqual(before);
  const moved = await position();
  expect(moved?.x).toBeGreaterThan(before.x);
  expect(moved?.y).toBeGreaterThan(before.y);

  const input = await edit(speaker);
  await input.fill("Selectable audio");
  const box = await input.boundingBox();
  if (box === null) {
    throw new Error("a name input to select");
  }
  await page.mouse.move(box.x + 3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  expect(
    await input.evaluate(
      (element: HTMLInputElement) => (element.selectionEnd ?? 0) - (element.selectionStart ?? 0),
    ),
  ).toBeGreaterThan(0);
  await input.press("Escape");
  await page.reload();
  expect(await position()).toEqual(moved);
  await expect(title(speaker)).toBeVisible();
});

test("blur saves and blank names restore the default", async ({ page }) => {
  const speaker = face(page, "speaker");
  let input = await edit(speaker);
  await input.fill("  Room audio  ");
  await title(face(page, "scope"), "Scope").click();
  await expect(title(speaker, "Room audio")).toBeVisible();
  await expect.poll(() => label(page)).toBe("Room audio");

  for (const blank of ["   ", ""]) {
    input = await edit(speaker, "Room audio");
    await input.fill(blank);
    await input.press("Enter");
    await expect(title(speaker)).toBeVisible();
    await expect.poll(() => label(page)).toBeUndefined();
    if (blank !== "") {
      input = await edit(speaker);
      await input.fill("Room audio");
      await input.press("Enter");
      await expect(title(speaker, "Room audio")).toBeVisible();
    }
  }
  await page.reload();
  await expect(title(speaker)).toBeVisible();
});

for (const key of ["Enter", "Space", "F2"]) {
  test(`${key} edits the name and Backspace keeps the node`, async ({ page }) => {
    const speaker = face(page, "speaker");
    await title(speaker).focus();
    await title(speaker).press(key);
    const input = speaker.getByRole("textbox", { name: "Node name", exact: true });
    await expect(input).toBeFocused();
    await input.press("Backspace");
    await expect(input).toHaveValue("");
    await expect(speaker).toHaveCount(1);
    await input.pressSequentially("Keyboard audio");
    await input.press("Enter");
    await expect(title(speaker, "Keyboard audio")).toBeVisible();
    await expect.poll(() => label(page)).toBe("Keyboard audio");
  });
}

test("limits names to 64 characters", async ({ page }) => {
  const speaker = face(page, "speaker");
  const input = await edit(speaker);
  await expect(input).toHaveAttribute("maxlength", "64");
  await input.pressSequentially("a".repeat(80));
  await expect(input).toHaveValue("a".repeat(64));
  await input.press("Enter");
  await expect.poll(() => label(page)).toBe("a".repeat(64));
  await page.reload();
  await expect(title(speaker, "a".repeat(64))).toBeVisible();
});

test("renames a pinned face and shares its name with the canvas", async ({ page }) => {
  const speaker = face(page, "speaker");
  await speaker.getByRole("button", { name: "Pin to the rack", exact: true }).click();
  const views = page.getByRole("group", { name: "View" });
  await views.getByRole("button", { name: "Rack", exact: true }).click();
  const rack = page.locator('.grid > [data-id="speaker"]');
  const input = await edit(rack);
  await input.fill("Rack audio");
  await input.press("Enter");
  await expect(title(rack, "Rack audio")).toBeVisible();
  await expect.poll(() => label(page)).toBe("Rack audio");
  await views.getByRole("button", { name: "Patch", exact: true }).click();
  await expect(title(speaker, "Rack audio")).toBeVisible();
});
